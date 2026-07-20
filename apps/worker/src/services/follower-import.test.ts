import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { LineApiError, LineClient } from '@line-crm/line-sdk';
import {
  FollowerImportAccountNotVerifiedError,
  FollowerImportLineApiError,
  advanceFollowerImport,
  getLatestFollowerImportJob,
  processDueFollowerImports,
  startFollowerImport,
  type FollowerImportDependencies,
} from './follower-import.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database): void {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(join(DB_ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    for (const sql of readFileSync(join(DB_ROOT, 'migrations', file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/)
      .map((part) => part.trim())
      .filter(Boolean)) {
      try { db.exec(sql); } catch (error) {
        if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
  }
}

let d1Executions = 0;

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) {
          if (args.length > 100) throw new Error(`D1 bind limit exceeded: ${args.length}`);
          params = args;
          return api;
        },
        async first<T>() {
          d1Executions += 1;
          return (statement.get(...(params as never[])) as T) ?? null;
        },
        async all<T>() {
          d1Executions += 1;
          return { results: statement.all(...(params as never[])) as T[] };
        },
        async run() {
          d1Executions += 1;
          const info = statement.run(...(params as never[]));
          return { meta: { changes: info.changes } };
        },
      };
      return api;
    },
    async batch(statements: D1PreparedStatement[]) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  } as unknown as D1Database;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Forbidden',
    headers: { 'Content-Type': 'application/json' },
  });
}

const actor = { id: 'staff-1', name: '担当者' };
let raw: Database.Database;
let DB: D1Database;

beforeEach(() => {
  d1Executions = 0;
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  replayAll(raw);
  raw.prepare(`
    INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, is_active)
    VALUES ('acc-1', 'channel-1', '認証済みアカウント', 'access-token', 'secret', 1)
  `).run();
  DB = d1(raw);
});

afterEach(() => {
  vi.unstubAllGlobals();
  raw.close();
});

function existingSnapshot(): unknown {
  return raw.prepare("SELECT * FROM friends WHERE id = 'friend-existing'").get();
}

describe('follower import service', () => {
  test('walks a 1000-id page and continuation, deduplicates across pages, and never changes an existing friend', async () => {
    raw.prepare(`
      INSERT INTO friends
        (id, line_user_id, display_name, picture_url, status_message, is_following,
         line_account_id, metadata, source, created_at, updated_at)
      VALUES ('friend-existing', 'U-existing', '既存名', 'https://example.test/old.png',
              '既存状態', 0, 'acc-1', '{ "bytes" : "keep" }', NULL,
              '2025-01-01T00:00:00.000+09:00', '2025-02-02T00:00:00.000+09:00')
    `).run();
    raw.exec(`
      CREATE TRIGGER reject_existing_friend_update
      BEFORE UPDATE ON friends WHEN OLD.id = 'friend-existing'
      BEGIN SELECT RAISE(ABORT, 'existing friend must stay byte-identical'); END;
    `);
    const before = existingSnapshot();
    const firstPage = ['U-existing', ...Array.from({ length: 999 }, (_, index) => `U-${String(index).padStart(4, '0')}`)];
    const pageCalls: Array<string | undefined> = [];
    const dependencies: FollowerImportDependencies = {
      createClient: () => ({
        async getFollowerIds(start?: string) {
          pageCalls.push(start);
          return start === undefined
            ? { userIds: firstPage, next: 'next-page' }
            : { userIds: ['U-0000', 'U-final'] };
        },
        async getProfile() { throw new Error('profile phase must not run while fetching pages'); },
      }),
    };

    d1Executions = 0;
    const started = await startFollowerImport(DB, {
      id: 'acc-1', channelAccessToken: 'access-token', isActive: true,
    }, actor, dependencies);
    expect(started).toMatchObject({
      status: 'fetching', fetchedCount: 1000, newCount: 999, existingCount: 1,
    });
    expect(started.continuationToken).toBe('next-page');
    expect(d1Executions).toBeLessThanOrEqual(25);

    d1Executions = 0;
    const afterSecondPage = await advanceFollowerImport(DB, started.id, 'acc-1', dependencies);
    expect(afterSecondPage).toMatchObject({
      status: 'profiling', fetchedCount: 1001, newCount: 1000, existingCount: 1,
    });
    expect(pageCalls).toEqual([undefined, 'next-page']);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM friend_import_items WHERE job_id = ?').get(started.id))
      .toEqual({ count: 1001 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM friends').get()).toEqual({ count: 1001 });
    expect(existingSnapshot()).toStrictEqual(before);
    expect(d1Executions).toBeLessThanOrEqual(25);
  });

  test('reports a line user already owned by another account as a failure without changing that row', async () => {
    raw.prepare(`
      INSERT INTO line_accounts
        (id, channel_id, name, channel_access_token, channel_secret, is_active)
      VALUES ('acc-2', 'channel-2', '別アカウント', 'other-token', 'other-secret', 1)
    `).run();
    raw.prepare(`
      INSERT INTO friends
        (id, line_user_id, display_name, picture_url, status_message, is_following,
         line_account_id, metadata, source, created_at, updated_at)
      VALUES ('friend-other', 'U-shared', '別アカウントの友だち', NULL, NULL, 1,
              'acc-2', '{"owner":"acc-2"}', NULL,
              '2025-01-01T00:00:00.000+09:00', '2025-01-01T00:00:00.000+09:00')
    `).run();
    const before = raw.prepare("SELECT * FROM friends WHERE id = 'friend-other'").get();

    const started = await startFollowerImport(DB, {
      id: 'acc-1', channelAccessToken: 'access-token', isActive: true,
    }, actor, {
      createClient: () => ({
        async getFollowerIds() { return { userIds: ['U-shared'] }; },
        async getProfile() { throw new Error('conflicts must not be profiled'); },
      }),
    });

    expect(started).toMatchObject({
      status: 'profiling', fetchedCount: 1, newCount: 0, existingCount: 0, failedCount: 1,
    });
    expect(raw.prepare("SELECT outcome FROM friend_import_items WHERE line_user_id = 'U-shared'").get())
      .toEqual({ outcome: 'conflict' });
    expect(raw.prepare("SELECT * FROM friends WHERE id = 'friend-other'").get()).toStrictEqual(before);
  });

  test('profiles only new rows in bounded batches, enforces intervals, resumes retries, and reports honest failures', async () => {
    raw.prepare(`
      INSERT INTO friends
        (id, line_user_id, display_name, picture_url, status_message, is_following,
         line_account_id, metadata, source, created_at, updated_at)
      VALUES ('friend-existing', 'U-existing', '既存名', 'https://example.test/old.png',
              '既存状態', 0, 'acc-1', '{"preserve":true}', NULL,
              '2025-01-01T00:00:00.000+09:00', '2025-02-02T00:00:00.000+09:00')
    `).run();
    raw.exec(`
      CREATE TRIGGER reject_existing_friend_update
      BEFORE UPDATE ON friends WHEN OLD.id = 'friend-existing'
      BEGIN SELECT RAISE(ABORT, 'existing friend must stay byte-identical'); END;
    `);
    const before = existingSnapshot();
    let nowMs = Date.parse('2026-07-21T00:00:00.000Z');
    const profileCalls: string[] = [];
    const attempts = new Map<string, number>();
    const dependencies: FollowerImportDependencies = {
      now: () => new Date(nowMs),
      profileBatchSize: 2,
      profileIntervalMs: 1_000,
      profileRetryDelayMs: 1_000,
      maxProfileAttempts: 2,
      createClient: () => ({
        async getFollowerIds() {
          return { userIds: ['U-existing', 'U-a', 'U-b', 'U-c'] };
        },
        async getProfile(userId: string) {
          profileCalls.push(userId);
          attempts.set(userId, (attempts.get(userId) ?? 0) + 1);
          if (userId === 'U-a') {
            return { userId, displayName: 'Aさん', pictureUrl: 'https://example.test/a.png' };
          }
          if (userId === 'U-b' && attempts.get(userId) === 2) {
            return { userId, displayName: 'Bさん' };
          }
          throw new Error('temporary profile failure');
        },
      }),
    };

    const started = await startFollowerImport(DB, {
      id: 'acc-1', channelAccessToken: 'access-token', isActive: true,
    }, actor, dependencies);
    expect(started).toMatchObject({ status: 'profiling', newCount: 3, existingCount: 1 });

    const firstBatch = await advanceFollowerImport(DB, started.id, 'acc-1', dependencies);
    expect(firstBatch).toMatchObject({ status: 'profiling', profileCompletedCount: 1, failedCount: 0 });
    expect(profileCalls).toEqual(['U-a', 'U-b']);

    await advanceFollowerImport(DB, started.id, 'acc-1', dependencies);
    expect(profileCalls).toEqual(['U-a', 'U-b']);

    nowMs += 1_000;
    const secondBatch = await advanceFollowerImport(DB, started.id, 'acc-1', dependencies);
    expect(secondBatch).toMatchObject({ status: 'profiling', profileCompletedCount: 2, failedCount: 0 });
    expect(profileCalls).toEqual(['U-a', 'U-b', 'U-b', 'U-c']);

    nowMs += 1_000;
    const completed = await advanceFollowerImport(DB, started.id, 'acc-1', dependencies);
    expect(completed).toMatchObject({
      status: 'completed', newCount: 3, existingCount: 1,
      profileCompletedCount: 2, failedCount: 1,
    });
    expect(profileCalls).toEqual(['U-a', 'U-b', 'U-b', 'U-c', 'U-c']);
    expect(raw.prepare("SELECT display_name FROM friends WHERE line_user_id = 'U-a'").get()).toEqual({ display_name: 'Aさん' });
    expect(raw.prepare("SELECT display_name FROM friends WHERE line_user_id = 'U-b'").get()).toEqual({ display_name: 'Bさん' });
    expect(raw.prepare("SELECT display_name FROM friends WHERE line_user_id = 'U-c'").get()).toEqual({ display_name: null });
    expect(existingSnapshot()).toStrictEqual(before);

    const completedAudit = raw.prepare(`
      SELECT event_type, new_count, existing_count, failed_count
        FROM friend_import_audit_log
       WHERE job_id = ? AND event_type = 'completed'
    `).get(started.id);
    expect(completedAudit).toEqual({ event_type: 'completed', new_count: 3, existing_count: 1, failed_count: 1 });

    profileCalls.length = 0;
    const rerun = await startFollowerImport(DB, {
      id: 'acc-1', channelAccessToken: 'access-token', isActive: true,
    }, actor, dependencies);
    expect(rerun).toMatchObject({ status: 'profiling', newCount: 0, existingCount: 4 });
    const rerunCompleted = await advanceFollowerImport(DB, rerun.id, 'acc-1', dependencies);
    expect(rerunCompleted.status).toBe('completed');
    expect(profileCalls).toEqual([]);
    expect(existingSnapshot()).toStrictEqual(before);
  });

  test.each([403, 404])('fails closed for LINE follower eligibility status %s and records the rejection', async (status) => {
    const dependencies: FollowerImportDependencies = {
      createClient: () => ({
        async getFollowerIds() { throw new LineApiError(status, 'Forbidden', '{}'); },
        async getProfile() { throw new Error('not reached'); },
      }),
    };

    await expect(startFollowerImport(DB, {
      id: 'acc-1', channelAccessToken: 'access-token', isActive: true,
    }, actor, dependencies)).rejects.toBeInstanceOf(FollowerImportAccountNotVerifiedError);

    const latest = await getLatestFollowerImportJob(DB, 'acc-1');
    expect(latest).toMatchObject({
      status: 'failed', errorCode: 'account_not_verified', newCount: 0,
      existingCount: 0, failedCount: 0,
    });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM friends').get()).toEqual({ count: 0 });
    expect(raw.prepare("SELECT event_type FROM friend_import_audit_log WHERE event_type = 'failed'").get())
      .toEqual({ event_type: 'failed' });
  });

  test.each([
    ['missing userIds', {}],
    ['non-string continuation token', { userIds: ['U-1'], next: 123 }],
    ['mixed follower id types', { userIds: ['U-1', 42] }],
  ])('persists malformed successful responses (%s) as an honest retryable LINE error', async (_label, page) => {
    await expect(startFollowerImport(DB, {
      id: 'acc-1', channelAccessToken: 'access-token', isActive: true,
    }, actor, {
      createClient: () => ({
        async getFollowerIds() { return page as never; },
        async getProfile() { throw new Error('not reached'); },
      }),
    })).rejects.toBeInstanceOf(FollowerImportLineApiError);

    const latest = await getLatestFollowerImportJob(DB, 'acc-1');
    expect(latest).toMatchObject({ status: 'fetching', errorCode: 'line_api_error' });
    expect(latest?.nextRunAt).not.toBeNull();
    expect(raw.prepare(`
      SELECT event_type FROM friend_import_audit_log
       WHERE job_id = ? AND event_type = 'retry_scheduled'
    `).get(latest?.id)).toEqual({ event_type: 'retry_scheduled' });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM friends').get()).toEqual({ count: 0 });
  });

  test('fences stale workers after another worker takes the lease', async () => {
    const started = await startFollowerImport(DB, {
      id: 'acc-1', channelAccessToken: 'access-token', isActive: true,
    }, actor, {
      createClient: () => ({
        async getFollowerIds() {
          raw.prepare(`
            UPDATE friend_import_jobs
               SET lock_token = 'new-owner', locked_until = '2999-01-01T00:00:00.000Z'
             WHERE account_id = 'acc-1'
          `).run();
          return { userIds: ['U-must-not-be-written'], next: 'must-not-be-written' };
        },
        async getProfile() { throw new Error('not reached'); },
      }),
    });

    expect(started).toMatchObject({ status: 'fetching', fetchedCount: 0, continuationToken: null });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM friend_import_items').get()).toEqual({ count: 0 });
    expect(raw.prepare("SELECT COUNT(*) AS count FROM friend_import_audit_log WHERE event_type = 'followers_page'").get())
      .toEqual({ count: 0 });
  });

  test('uses deterministic terminal audit ids and the due worker resumes through completion', async () => {
    const pageCalls: Array<string | undefined> = [];
    const dependencies: FollowerImportDependencies = {
      profileBatchSize: 10,
      profileIntervalMs: 0,
      createClient: () => ({
        async getFollowerIds(start?: string) {
          pageCalls.push(start);
          return start ? { userIds: ['U-2'] } : { userIds: ['U-1'], next: 'page-2' };
        },
        async getProfile(userId: string) { return { userId, displayName: userId }; },
      }),
    };

    const started = await startFollowerImport(DB, {
      id: 'acc-1', channelAccessToken: 'access-token', isActive: true,
    }, actor, dependencies);
    expect(raw.prepare("SELECT id FROM friend_import_audit_log WHERE event_type = 'started'").get())
      .toEqual({ id: `${started.id}:started` });

    await processDueFollowerImports(DB, dependencies);
    const result = await processDueFollowerImports(DB, dependencies);
    const completed = await getLatestFollowerImportJob(DB, 'acc-1');
    expect(result.attempted).toBe(1);
    expect(completed).toMatchObject({ status: 'completed', newCount: 2, profileCompletedCount: 2 });
    expect(pageCalls).toEqual([undefined, 'page-2']);
    expect(raw.prepare("SELECT id FROM friend_import_audit_log WHERE event_type = 'completed'").get())
      .toEqual({ id: `${started.id}:completed` });
  });

  test('terminally fails an import whose LINE account becomes inactive so later jobs are not starved', async () => {
    const dependencies: FollowerImportDependencies = {
      createClient: () => ({
        async getFollowerIds() { return { userIds: [], next: 'page-2' }; },
        async getProfile() { throw new Error('not reached'); },
      }),
    };
    const started = await startFollowerImport(DB, {
      id: 'acc-1', channelAccessToken: 'access-token', isActive: true,
    }, actor, dependencies);
    raw.prepare("UPDATE line_accounts SET is_active = 0 WHERE id = 'acc-1'").run();

    const result = await processDueFollowerImports(DB, dependencies);
    const failed = await getLatestFollowerImportJob(DB, 'acc-1');
    expect(result).toMatchObject({ attempted: 1, failed: 1 });
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'line_account_unavailable' });
    expect(raw.prepare("SELECT id FROM friend_import_audit_log WHERE event_type = 'failed'").get())
      .toEqual({ id: `${started.id}:failed` });
  });

  test('cron advances at most one due import per tick to preserve the shared Worker budget', async () => {
    raw.prepare(`
      INSERT INTO line_accounts
        (id, channel_id, name, channel_access_token, channel_secret, is_active)
      VALUES ('acc-2', 'channel-2', '別アカウント', 'other-token', 'other-secret', 1)
    `).run();
    const insertJob = raw.prepare(`
      INSERT INTO friend_import_jobs
        (id, account_id, requested_by_id, requested_by_name, created_at, updated_at)
      VALUES (?, ?, 'staff-1', '担当者', ?, ?)
    `);
    insertJob.run('job-1', 'acc-1', '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z');
    insertJob.run('job-2', 'acc-2', '2026-07-21T00:00:01.000Z', '2026-07-21T00:00:01.000Z');

    const result = await processDueFollowerImports(DB, {
      createClient: () => ({
        async getFollowerIds() { return { userIds: [] }; },
        async getProfile() { throw new Error('not reached'); },
      }),
    });

    expect(result.attempted).toBe(1);
    expect(raw.prepare("SELECT COUNT(*) AS count FROM friend_import_jobs WHERE phase = 'profiles'").get())
      .toEqual({ count: 1 });
  });
});

describe('LineClient follower ids contract', () => {
  test('encodes the continuation token and exposes the next page', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ userIds: ['U-1'], next: 'next-2' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new LineClient('token').getFollowerIds('next / 1')).resolves.toEqual({
      userIds: ['U-1'], next: 'next-2',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.line.me/v2/bot/followers/ids?start=next+%2F+1&limit=1000',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  test('preserves HTTP status in a typed LINE API error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'not available' }, 404)));
    await expect(new LineClient('token').getFollowerIds()).rejects.toMatchObject({
      name: 'LineApiError', status: 404,
    });
  });
});
