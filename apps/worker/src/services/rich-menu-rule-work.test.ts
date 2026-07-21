import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createRichMenuDisplayRule } from '@line-crm/db';
import { LineApiError } from '@line-crm/line-sdk';
import {
  RichMenuRuleReapplyConflictError,
  createRichMenuRuleReapplyJob,
  enqueueRichMenuRuleScheduleTransitions,
  getLatestRichMenuRuleReapplyJob,
  processRichMenuRuleWork,
} from './rich-menu-rule-work.js';

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

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
        async run() {
          const info = statement.run(...(params as never[]));
          return { meta: { changes: info.changes } };
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

let raw: Database.Database;
let db: D1Database;

function seedFriends(count: number, accountId = 'acc-1'): void {
  const insert = raw.prepare(
    `INSERT INTO friends (id, line_user_id, line_account_id, metadata, is_following)
     VALUES (?, ?, ?, '{}', 1)`,
  );
  for (let index = 0; index < count; index++) {
    const id = `friend-${String(index).padStart(3, '0')}`;
    insert.run(id, `U${index}`, accountId);
  }
}

function bulkLineDouble(options: {
  bulkFailureStatuses?: number[];
  individualFailureStatuses?: number[];
  initialMenus?: Record<string, string | null>;
  invalidUserIndexesOnce?: number[];
  forbidVerification?: boolean;
} = {}) {
  const currentMenus = new Map<string, string | null>(Object.entries(options.initialMenus ?? {}));
  const bulkFailureStatuses = [...(options.bulkFailureStatuses ?? [])];
  const individualFailureStatuses = [...(options.individualFailureStatuses ?? [])];
  let invalidUserIndexes = options.invalidUserIndexesOnce;
  const bulkLinks: Array<{ userIds: string[]; richMenuId: string }> = [];
  const bulkUnlinks: string[][] = [];
  const individualLinks: Array<{ userId: string; richMenuId: string }> = [];
  const individualUnlinks: string[] = [];
  const verificationCalls: string[] = [];
  const factory = vi.fn(() => ({
    async linkRichMenuToUser(userId: string, richMenuId: string) {
      individualLinks.push({ userId, richMenuId });
      const status = individualFailureStatuses.shift();
      if (status !== undefined) throw new LineApiError(status, 'individual failure', '{}');
      currentMenus.set(userId, richMenuId);
    },
    async unlinkRichMenuFromUser(userId: string) {
      individualUnlinks.push(userId);
      const status = individualFailureStatuses.shift();
      if (status !== undefined) throw new LineApiError(status, 'individual failure', '{}');
      currentMenus.set(userId, null);
    },
    async linkRichMenuToMultipleUsers(userIds: string[], richMenuId: string) {
      bulkLinks.push({ userIds: [...userIds], richMenuId });
      const status = bulkFailureStatuses.shift();
      if (status !== undefined) throw new LineApiError(status, 'temporary', '{}');
      if (invalidUserIndexes) {
        const indexes = invalidUserIndexes;
        invalidUserIndexes = undefined;
        throw new LineApiError(400, 'Bad Request', JSON.stringify({
          message: indexes.map((index) => `The property, 'userIds[${index}]', is invalid`).join('; '),
        }));
      }
      for (const userId of userIds) currentMenus.set(userId, richMenuId);
    },
    async unlinkRichMenusFromMultipleUsers(userIds: string[]) {
      bulkUnlinks.push([...userIds]);
      const status = bulkFailureStatuses.shift();
      if (status !== undefined) throw new LineApiError(status, 'temporary', '{}');
      for (const userId of userIds) currentMenus.set(userId, null);
    },
    async getRichMenuIdOfUser(userId: string) {
      verificationCalls.push(userId);
      if (options.forbidVerification) throw new Error('per-user verification exceeds the Worker budget');
      const richMenuId = currentMenus.get(userId) ?? null;
      if (richMenuId === null) throw new LineApiError(404, 'Not Found', '{}');
      return { richMenuId };
    },
    async getDefaultRichMenuId() {
      if (options.forbidVerification) throw new LineApiError(403, 'Forbidden', '{}');
      return null;
    },
  }));
  return { bulkLinks, bulkUnlinks, individualLinks, individualUnlinks, verificationCalls, factory };
}

beforeEach(() => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  replayAll(raw);
  raw.prepare(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
     VALUES ('acc-1', 'channel-1', 'A', 'account-token', 'secret')`,
  ).run();
  db = d1(raw);
});

describe('rich menu rule reapply jobs', () => {
  test('processes 1,450 friends with exactly three external calls and batches of at most 500', async () => {
    seedFriends(1_450);
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-1', name: '全員', conditionType: 'tag_not_exists', conditionValue: 'missing',
      richMenuId: 'menu-all', priority: 10, isActive: true,
    });
    await createRichMenuRuleReapplyJob(db, 'acc-1');
    const line = bulkLineDouble();
    let queryCount = 0;
    const requestCounter = { used: 0 };
    const countingDb = {
      prepare(sql: string) {
        queryCount++;
        return db.prepare(sql);
      },
    } as unknown as D1Database;

    const result = await processRichMenuRuleWork(countingDb, {
      limit: 1_450,
      clientFactory: line.factory,
      bulkOptions: { sleep: async () => undefined, requestCounter },
    } as never);

    expect(result).toEqual({ attempted: 1_450, queueProcessed: 0, jobsCompleted: 1 });
    expect(line.bulkLinks.map((call) => call.userIds.length)).toEqual([500, 500, 450]);
    expect(requestCounter.used).toBe(3);
    expect(line.verificationCalls).toEqual([]);
    expect(line.individualLinks).toEqual([]);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM rich_menu_friend_assignments').get())
      .toEqual({ count: 1_450 });
    expect(queryCount).toBeLessThanOrEqual(20);
  });

  test.each([429, 503])('backs off and retries a bulk link after LINE %s', async (status) => {
    seedFriends(1);
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-1', name: '全員', conditionType: 'tag_not_exists', conditionValue: 'missing',
      richMenuId: 'menu-all', priority: 10, isActive: true,
    });
    await createRichMenuRuleReapplyJob(db, 'acc-1');
    const line = bulkLineDouble({ bulkFailureStatuses: [status] });
    const sleeps = vi.fn(async (_milliseconds: number) => undefined);

    await processRichMenuRuleWork(db, {
      limit: 1,
      clientFactory: line.factory,
      bulkOptions: { sleep: sleeps },
    } as never);

    expect(line.bulkLinks).toHaveLength(2);
    expect(sleeps).toHaveBeenCalledWith(1_000);
    expect(sleeps).toHaveBeenCalledWith(1);
    expect(line.individualLinks).toEqual([]);
  });

  test('isolates userIds[n] named by LINE 400 and individually retries only those users', async () => {
    seedFriends(3);
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-1', name: '全員', conditionType: 'tag_not_exists', conditionValue: 'missing',
      richMenuId: 'menu-all', priority: 10, isActive: true,
    });
    await createRichMenuRuleReapplyJob(db, 'acc-1');
    const line = bulkLineDouble({ invalidUserIndexesOnce: [1] });

    await processRichMenuRuleWork(db, {
      limit: 3,
      clientFactory: line.factory,
      bulkOptions: { sleep: async () => undefined },
    } as never);

    expect(line.bulkLinks.map((call) => call.userIds)).toEqual([
      ['U0', 'U1', 'U2'],
      ['U0', 'U2'],
    ]);
    expect(line.individualLinks).toEqual([{ userId: 'U1', richMenuId: 'menu-all' }]);
    expect((await getLatestRichMenuRuleReapplyJob(db, 'acc-1'))?.failedCount).toBe(0);
  });

  test('records an individually retried permanent 400 as terminal so one invalid user cannot block the job', async () => {
    seedFriends(3);
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-1', name: '全員', conditionType: 'tag_not_exists', conditionValue: 'missing',
      richMenuId: 'menu-all', priority: 10, isActive: true,
    });
    await createRichMenuRuleReapplyJob(db, 'acc-1');
    const line = bulkLineDouble({
      invalidUserIndexesOnce: [1],
      individualFailureStatuses: [400],
    });

    await processRichMenuRuleWork(db, {
      limit: 3,
      clientFactory: line.factory,
      bulkOptions: { sleep: async () => undefined },
    } as never);

    expect(line.bulkLinks.map((call) => call.userIds)).toEqual([
      ['U0', 'U1', 'U2'],
      ['U0', 'U2'],
    ]);
    expect(line.individualLinks).toEqual([{ userId: 'U1', richMenuId: 'menu-all' }]);
    expect(await getLatestRichMenuRuleReapplyJob(db, 'acc-1')).toMatchObject({
      status: 'completed', processedCount: 3, appliedCount: 2, failedCount: 1,
    });
    expect(raw.prepare('SELECT friend_id FROM rich_menu_rule_evaluation_queue').all()).toEqual([]);
  });

  test('queues a whole chunk after bulk 5xx retries exhaust instead of overflowing subrequests', async () => {
    seedFriends(1);
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-1', name: '全員', conditionType: 'tag_not_exists', conditionValue: 'missing',
      richMenuId: 'menu-all', priority: 10, isActive: true,
    });
    await createRichMenuRuleReapplyJob(db, 'acc-1');
    const line = bulkLineDouble({ bulkFailureStatuses: [503, 503, 503] });
    const sleeps = vi.fn(async (_milliseconds: number) => undefined);

    await processRichMenuRuleWork(db, {
      limit: 1,
      clientFactory: line.factory,
      bulkOptions: { sleep: sleeps },
    } as never);

    expect(line.bulkLinks).toHaveLength(3);
    expect(sleeps).toHaveBeenCalledWith(1_000);
    expect(sleeps).toHaveBeenCalledWith(2_000);
    expect(line.individualLinks).toEqual([]);
    expect(await getLatestRichMenuRuleReapplyJob(db, 'acc-1')).toMatchObject({
      status: 'running', failedCount: 1,
    });
    expect(raw.prepare('SELECT attempts FROM rich_menu_rule_evaluation_queue WHERE friend_id = ?').get('friend-000'))
      .toEqual({ attempts: 1 });
  });

  test('uses bulk unlink when rules return managed friends to the account default', async () => {
    seedFriends(2);
    raw.prepare(
      `INSERT INTO rich_menu_friend_assignments (friend_id, account_id, rule_id, rich_menu_id)
       VALUES ('friend-000', 'acc-1', NULL, 'menu-old'),
              ('friend-001', 'acc-1', NULL, 'menu-old')`,
    ).run();
    await createRichMenuRuleReapplyJob(db, 'acc-1');
    const line = bulkLineDouble({
      initialMenus: { U0: 'menu-old', U1: 'menu-old' },
      forbidVerification: true,
    });

    await processRichMenuRuleWork(db, {
      limit: 2,
      clientFactory: line.factory,
      bulkOptions: { sleep: async () => undefined },
    } as never);

    expect(line.bulkUnlinks).toEqual([['U0', 'U1']]);
    expect(line.verificationCalls).toEqual([]);
    expect(line.individualUnlinks).toEqual([]);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM rich_menu_friend_assignments').get())
      .toEqual({ count: 0 });
  });

  test('continues a pre-deploy 20-friend cursor and bulk-applies only the remaining friends', async () => {
    seedFriends(30);
    const rule = await createRichMenuDisplayRule(db, {
      accountId: 'acc-1', name: '全員', conditionType: 'tag_not_exists', conditionValue: 'missing',
      richMenuId: 'menu-all', priority: 10, isActive: true,
    });
    const insertAssignment = raw.prepare(
      `INSERT INTO rich_menu_friend_assignments (friend_id, account_id, rule_id, rich_menu_id)
       VALUES (?, 'acc-1', ?, 'menu-all')`,
    );
    for (let index = 0; index < 20; index++) {
      insertAssignment.run(`friend-${String(index).padStart(3, '0')}`, rule.id);
    }
    raw.prepare(
      `INSERT INTO rich_menu_rule_reapply_jobs
       (id, account_id, status, total_count, processed_count, applied_count, last_friend_id)
       VALUES ('job-old', 'acc-1', 'running', 30, 20, 20, 'friend-019')`,
    ).run();
    const line = bulkLineDouble();

    const result = await processRichMenuRuleWork(db, {
      clientFactory: line.factory,
      bulkOptions: { sleep: async () => undefined },
    });

    expect(result).toEqual({ attempted: 10, queueProcessed: 0, jobsCompleted: 1 });
    expect(line.bulkLinks.map((call) => call.userIds)).toEqual([
      Array.from({ length: 10 }, (_value, index) => `U${index + 20}`),
    ]);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM rich_menu_friend_assignments').get())
      .toEqual({ count: 30 });
  });

  test('does not advance job progress past a friend whose queue lease cannot be claimed', async () => {
    seedFriends(3);
    await createRichMenuRuleReapplyJob(db, 'acc-1');
    raw.prepare(
      `INSERT INTO rich_menu_rule_evaluation_queue (friend_id, available_at)
       VALUES ('friend-000', '2999-01-01T00:00:00.000')`,
    ).run();

    await processRichMenuRuleWork(db, { limit: 3 });

    expect(await getLatestRichMenuRuleReapplyJob(db, 'acc-1')).toMatchObject({
      status: 'running', processedCount: 0, lastFriendId: null,
    });
    raw.prepare('DELETE FROM rich_menu_rule_evaluation_queue').run();
    await processRichMenuRuleWork(db, { limit: 3 });
    expect(await getLatestRichMenuRuleReapplyJob(db, 'acc-1')).toMatchObject({
      status: 'completed', processedCount: 3,
    });
  });

  test('immediately releases an unprocessed suffix even when a dirty trigger increments its revision', async () => {
    seedFriends(3);
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-1', name: '全員', conditionType: 'tag_not_exists', conditionValue: 'missing',
      richMenuId: 'menu-all', priority: 10, isActive: true,
    });
    await createRichMenuRuleReapplyJob(db, 'acc-1');
    raw.prepare(
      `INSERT INTO rich_menu_rule_evaluation_queue (friend_id, available_at)
       VALUES ('friend-000', '2999-01-01T00:00:00.000')`,
    ).run();
    let injected = false;
    const racingDb = {
      prepare(sql: string) {
        const statement = db.prepare(sql);
        if (!sql.includes('RETURNING friend_id, revision')) return statement;
        return {
          bind(...args: unknown[]) {
            const bound = statement.bind(...args) as unknown as { all<T>(): Promise<{ results: T[] }> };
            return {
              async all<T>() {
                const result = await bound.all<T>();
                if (!injected) {
                  injected = true;
                  raw.prepare("UPDATE friends SET metadata = '{\"changed\":true}' WHERE id = 'friend-002'").run();
                }
                return result;
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    const line = bulkLineDouble();

    const result = await processRichMenuRuleWork(racingDb, {
      limit: 3,
      clientFactory: line.factory,
      bulkOptions: { sleep: async () => undefined },
    });

    expect(result).toEqual({ attempted: 2, queueProcessed: 2, jobsCompleted: 0 });
    expect(line.bulkLinks.map((call) => call.userIds)).toEqual([['U1', 'U2']]);
    expect(raw.prepare(
      "SELECT friend_id, lease_token FROM rich_menu_rule_evaluation_queue WHERE friend_id = 'friend-002'",
    ).get()).toBeUndefined();
  });

  test('a superseded bulk worker invalidates assignment state and leaves a corrective queue generation', async () => {
    seedFriends(1);
    raw.prepare("INSERT INTO tags (id, name) VALUES ('tag-paid', '購入済み')").run();
    raw.prepare("INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-000', 'tag-paid')").run();
    const rule = await createRichMenuDisplayRule(db, {
      accountId: 'acc-1', name: '購入済み', conditionType: 'tag_exists', conditionValue: 'tag-paid',
      richMenuId: 'menu-old', priority: 10, isActive: true,
    });
    await createRichMenuRuleReapplyJob(db, 'acc-1');
    let staleStarted!: () => void;
    let releaseStale!: () => void;
    const started = new Promise<void>((resolve) => { staleStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseStale = resolve; });
    let effectiveMenu: string | null = null;
    const staleFactory = () => ({
      async linkRichMenuToUser(_userId: string, richMenuId: string) { effectiveMenu = richMenuId; },
      async unlinkRichMenuFromUser() { effectiveMenu = null; },
      async linkRichMenuToMultipleUsers(_userIds: string[], richMenuId: string) {
        staleStarted();
        await release;
        effectiveMenu = richMenuId;
      },
      async unlinkRichMenusFromMultipleUsers() { effectiveMenu = null; },
    });
    const currentFactory = () => ({
      async linkRichMenuToUser(_userId: string, richMenuId: string) { effectiveMenu = richMenuId; },
      async unlinkRichMenuFromUser() { effectiveMenu = null; },
      async linkRichMenuToMultipleUsers(_userIds: string[], richMenuId: string) { effectiveMenu = richMenuId; },
      async unlinkRichMenusFromMultipleUsers() { effectiveMenu = null; },
    });

    const stale = processRichMenuRuleWork(db, {
      limit: 1,
      clientFactory: staleFactory,
      bulkOptions: { sleep: async () => undefined },
    });
    await started;
    raw.prepare('UPDATE rich_menu_display_rules SET rich_menu_id = ? WHERE id = ?')
      .run('menu-new', rule.id);
    raw.prepare(
      `UPDATE rich_menu_rule_evaluation_queue
       SET lease_token = NULL, revision = revision + 1, available_at = '2000-01-01T00:00:00.000'`,
    ).run();
    raw.prepare(
      `UPDATE rich_menu_rule_reapply_jobs
       SET locked_until = '2000-01-01T00:00:00.000' WHERE id = ?`,
    ).run((await getLatestRichMenuRuleReapplyJob(db, 'acc-1'))!.id);
    await processRichMenuRuleWork(db, {
      limit: 1,
      clientFactory: currentFactory,
      bulkOptions: { sleep: async () => undefined },
    });
    expect(effectiveMenu).toBe('menu-new');

    releaseStale();
    await stale;
    expect(effectiveMenu).toBe('menu-old');
    expect(raw.prepare('SELECT friend_id FROM rich_menu_rule_evaluation_queue').all())
      .toEqual([{ friend_id: 'friend-000' }]);
    expect(raw.prepare('SELECT rich_menu_id FROM rich_menu_friend_assignments').all()).toEqual([]);

    await processRichMenuRuleWork(db, {
      limit: 1,
      clientFactory: currentFactory,
      bulkOptions: { sleep: async () => undefined },
    });
    expect(effectiveMenu).toBe('menu-new');
    expect(raw.prepare('SELECT rich_menu_id FROM rich_menu_friend_assignments').get())
      .toEqual({ rich_menu_id: 'menu-new' });
    expect(raw.prepare('SELECT friend_id FROM rich_menu_rule_evaluation_queue').all()).toEqual([]);
  });

  test('starts one account job with total visibility and blocks repeated clicks for a cooldown window', async () => {
    seedFriends(3);
    const job = await createRichMenuRuleReapplyJob(db, 'acc-1');
    expect(job).toMatchObject({ accountId: 'acc-1', status: 'running', totalCount: 3, processedCount: 0 });
    await expect(createRichMenuRuleReapplyJob(db, 'acc-1')).rejects.toBeInstanceOf(RichMenuRuleReapplyConflictError);
    expect(await getLatestRichMenuRuleReapplyJob(db, 'acc-1')).toMatchObject({ id: job.id, totalCount: 3 });
  });

  test('keeps an empty sweep lock until the worker completes it', async () => {
    const job = await createRichMenuRuleReapplyJob(db, 'acc-1');
    expect(job).toMatchObject({ status: 'running', totalCount: 0 });
    await expect(createRichMenuRuleReapplyJob(db, 'acc-1')).rejects.toBeInstanceOf(RichMenuRuleReapplyConflictError);

    expect(await processRichMenuRuleWork(db)).toEqual({ attempted: 0, queueProcessed: 0, jobsCompleted: 1 });
    expect(await getLatestRichMenuRuleReapplyJob(db, 'acc-1')).toMatchObject({ status: 'completed', totalCount: 0 });
  });

  test('processes at most 20 friends per tick and exposes deterministic progress/result counts', async () => {
    seedFriends(25);
    const job = await createRichMenuRuleReapplyJob(db, 'acc-1');

    const first = await processRichMenuRuleWork(db, { limit: 20 });
    expect(first).toMatchObject({ attempted: 20, jobsCompleted: 0 });
    expect(await getLatestRichMenuRuleReapplyJob(db, 'acc-1')).toMatchObject({
      id: job.id,
      status: 'running',
      processedCount: 20,
      skippedCount: 20,
    });

    const second = await processRichMenuRuleWork(db, { limit: 20 });
    expect(second).toMatchObject({ attempted: 5, jobsCompleted: 1 });
    expect(await getLatestRichMenuRuleReapplyJob(db, 'acc-1')).toMatchObject({
      status: 'completed',
      processedCount: 25,
      skippedCount: 25,
      failedCount: 0,
    });
  });

  test('a LINE failure records progress but keeps the job running until queued retry work settles', async () => {
    seedFriends(1);
    raw.prepare("INSERT INTO tags (id, name) VALUES ('tag-paid', '購入済み')").run();
    raw.prepare("INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-000', 'tag-paid')").run();
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-1',
      name: '購入済み',
      conditionType: 'tag_exists',
      conditionValue: 'tag-paid',
      richMenuId: 'menu-paid',
      priority: 10,
      isActive: true,
    });
    await createRichMenuRuleReapplyJob(db, 'acc-1');

    await processRichMenuRuleWork(db, {
      limit: 20,
      clientFactory: () => ({
        async linkRichMenuToUser() { throw new Error('temporary'); },
        async unlinkRichMenuFromUser() {},
      }),
      bulkOptions: { sleep: async () => undefined },
    });

    expect(await getLatestRichMenuRuleReapplyJob(db, 'acc-1')).toMatchObject({
      status: 'running',
      processedCount: 1,
      failedCount: 1,
    });
    expect(raw.prepare('SELECT attempts FROM rich_menu_rule_evaluation_queue WHERE friend_id = ?').get('friend-000'))
      .toEqual({ attempts: 1 });
  });

  test('reserves bounded capacity for dirty changes while a large sweep is running', async () => {
    seedFriends(25);
    raw.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
       VALUES ('acc-2', 'channel-2', 'B', 'account-token-2', 'secret-2')`,
    ).run();
    raw.prepare(
      `INSERT INTO friends (id, line_user_id, line_account_id, metadata, is_following)
       VALUES ('friend-dirty', 'U-dirty', 'acc-2', '{}', 1)`,
    ).run();
    raw.prepare(
      `INSERT INTO rich_menu_rule_evaluation_queue (friend_id) VALUES ('friend-dirty')
       ON CONFLICT(friend_id) DO UPDATE SET available_at = excluded.available_at`,
    ).run();
    await createRichMenuRuleReapplyJob(db, 'acc-1');

    const result = await processRichMenuRuleWork(db, { limit: 20 });

    expect(result).toEqual({ attempted: 20, queueProcessed: 1, jobsCompleted: 0 });
    expect(await getLatestRichMenuRuleReapplyJob(db, 'acc-1')).toMatchObject({ processedCount: 19 });
  });

  test('a sweep never erases a newer metadata change queued while LINE is in flight', async () => {
    seedFriends(1);
    raw.prepare("INSERT INTO tags (id, name) VALUES ('tag-paid', '購入済み')").run();
    raw.prepare("INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-000', 'tag-paid')").run();
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-1', name: '購入済み', conditionType: 'tag_exists', conditionValue: 'tag-paid',
      richMenuId: 'menu-paid', priority: 10, isActive: true,
    });
    await createRichMenuRuleReapplyJob(db, 'acc-1');
    raw.prepare('DELETE FROM rich_menu_rule_evaluation_queue').run();
    let releaseLine!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseLine = resolve; });

    const processing = processRichMenuRuleWork(db, {
      limit: 1,
      clientFactory: () => ({
        async linkRichMenuToUser() { markStarted(); await release; },
        async unlinkRichMenuFromUser() {},
      }),
    });
    await started;
    raw.prepare("UPDATE friends SET metadata = '{\"rank\":\"VIP\"}' WHERE id = 'friend-000'").run();
    releaseLine();
    await processing;

    expect(raw.prepare('SELECT friend_id FROM rich_menu_rule_evaluation_queue').all())
      .toEqual([{ friend_id: 'friend-000' }]);
  });

  test('only the worker that still owns the job lock reports its completion', async () => {
    seedFriends(1);
    raw.prepare("INSERT INTO tags (id, name) VALUES ('tag-paid', '購入済み')").run();
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-1', name: '購入済み', conditionType: 'tag_exists', conditionValue: 'tag-paid',
      richMenuId: 'menu-paid', priority: 10, isActive: true,
    });
    raw.prepare("INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-000', 'tag-paid')").run();
    await createRichMenuRuleReapplyJob(db, 'acc-1');
    raw.prepare('DELETE FROM rich_menu_rule_evaluation_queue').run();
    let releaseLine!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseLine = resolve; });
    const clientFactory = () => ({
      async linkRichMenuToUser() { markStarted(); await release; },
      async unlinkRichMenuFromUser() {},
    });

    const staleWorker = processRichMenuRuleWork(db, { limit: 1, clientFactory });
    await started;
    raw.prepare(
      "UPDATE rich_menu_rule_reapply_jobs SET locked_until = '2000-01-01T00:00:00.000' WHERE account_id = 'acc-1'",
    ).run();
    const newOwnerResult = await processRichMenuRuleWork(db, { limit: 1, clientFactory });
    releaseLine();
    const staleResult = await staleWorker;

    expect(newOwnerResult.jobsCompleted + staleResult.jobsCompleted).toBe(0);
    const closerResult = await processRichMenuRuleWork(db, { limit: 1, clientFactory });
    expect(closerResult.jobsCompleted).toBe(1);
    expect(await getLatestRichMenuRuleReapplyJob(db, 'acc-1')).toMatchObject({ status: 'completed' });
  });
});

describe('dirty friend queue', () => {
  test('bulk-drains a 500-plus scheduled boundary queue when no manual sweep is running', async () => {
    seedFriends(501);
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-1', name: '全員', conditionType: 'tag_not_exists', conditionValue: 'missing',
      richMenuId: 'menu-all', priority: 10, isActive: true,
    });
    const enqueue = raw.prepare('INSERT INTO rich_menu_rule_evaluation_queue (friend_id) VALUES (?)');
    for (let index = 0; index < 501; index++) {
      enqueue.run(`friend-${String(index).padStart(3, '0')}`);
    }
    const line = bulkLineDouble();

    const result = await processRichMenuRuleWork(db, {
      limit: 501,
      clientFactory: line.factory,
      bulkOptions: { sleep: async () => undefined },
    });

    expect(result).toEqual({ attempted: 501, queueProcessed: 501, jobsCompleted: 0 });
    expect(line.bulkLinks.map((call) => call.userIds.length)).toEqual([500, 1]);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM rich_menu_rule_evaluation_queue').get())
      .toEqual({ count: 0 });
  });

  test('bulk-drains another account scheduled queue while a manual sweep is running', async () => {
    seedFriends(1);
    raw.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
       VALUES ('acc-2', 'channel-2', 'B', 'account-token-2', 'secret-2')`,
    ).run();
    const insertFriend = raw.prepare(
      `INSERT INTO friends (id, line_user_id, line_account_id, metadata, is_following)
       VALUES (?, ?, 'acc-2', '{}', 1)`,
    );
    const enqueue = raw.prepare('INSERT INTO rich_menu_rule_evaluation_queue (friend_id) VALUES (?)');
    for (let index = 0; index < 1_450; index++) {
      const friendId = `other-${String(index).padStart(4, '0')}`;
      insertFriend.run(friendId, `OTHER-U${index}`);
      enqueue.run(friendId);
    }
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-2', name: '全員', conditionType: 'tag_not_exists', conditionValue: 'missing',
      richMenuId: 'menu-other', priority: 10, isActive: true,
    });
    await createRichMenuRuleReapplyJob(db, 'acc-1');
    raw.prepare(
      `INSERT INTO rich_menu_rule_evaluation_queue (friend_id, available_at)
       VALUES ('friend-000', '2999-01-01T00:00:00.000')
       ON CONFLICT(friend_id) DO UPDATE SET available_at = excluded.available_at`,
    ).run();
    const line = bulkLineDouble();

    const result = await processRichMenuRuleWork(db, {
      limit: 1_500,
      clientFactory: line.factory,
      bulkOptions: { sleep: async () => undefined },
    });

    expect(result).toEqual({ attempted: 1_450, queueProcessed: 1_450, jobsCompleted: 0 });
    expect(line.bulkLinks.map((call) => call.userIds.length)).toEqual([500, 500, 450]);
    expect(await getLatestRichMenuRuleReapplyJob(db, 'acc-1')).toMatchObject({
      status: 'running', processedCount: 0,
    });
    expect(raw.prepare(
      `SELECT COUNT(*) AS count FROM rich_menu_rule_evaluation_queue q
       JOIN friends f ON f.id = q.friend_id WHERE f.line_account_id = 'acc-2'`,
    ).get()).toEqual({ count: 0 });
  });

  test('deduplicates rapid changes and drains only the global bounded limit', async () => {
    seedFriends(25);
    const enqueue = raw.prepare(
      `INSERT INTO rich_menu_rule_evaluation_queue (friend_id) VALUES (?)
       ON CONFLICT(friend_id) DO UPDATE SET available_at = excluded.available_at`,
    );
    for (let index = 0; index < 25; index++) {
      const friendId = `friend-${String(index).padStart(3, '0')}`;
      enqueue.run(friendId);
      enqueue.run(friendId);
    }
    expect(raw.prepare('SELECT COUNT(*) AS count FROM rich_menu_rule_evaluation_queue').get()).toEqual({ count: 25 });

    expect(await processRichMenuRuleWork(db, { limit: 20 })).toMatchObject({ attempted: 20, queueProcessed: 20 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM rich_menu_rule_evaluation_queue').get()).toEqual({ count: 5 });
  });

  test('leases a queued friend so overlapping workers perform one LINE mutation', async () => {
    seedFriends(1);
    raw.prepare("INSERT INTO tags (id, name) VALUES ('tag-paid', '購入済み')").run();
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-1',
      name: '購入済み',
      conditionType: 'tag_exists',
      conditionValue: 'tag-paid',
      richMenuId: 'menu-paid',
      priority: 10,
      isActive: true,
    });
    raw.prepare("INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-000', 'tag-paid')").run();
    let linkCalls = 0;
    const clientFactory = () => ({
      async linkRichMenuToUser() {
        linkCalls++;
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
      async unlinkRichMenuFromUser() {},
    });

    const results = await Promise.all([
      processRichMenuRuleWork(db, { limit: 1, clientFactory }),
      processRichMenuRuleWork(db, { limit: 1, clientFactory }),
    ]);

    expect(linkCalls).toBe(1);
    expect(results.reduce((total, result) => total + result.queueProcessed, 0)).toBe(1);
  });

  test('a queue lease only clears its own generation, not a newer dirty update', async () => {
    seedFriends(1);
    raw.prepare("INSERT INTO tags (id, name) VALUES ('tag-paid', '購入済み')").run();
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-1', name: '購入済み', conditionType: 'tag_exists', conditionValue: 'tag-paid',
      richMenuId: 'menu-paid', priority: 10, isActive: true,
    });
    raw.prepare("INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-000', 'tag-paid')").run();
    let releaseLine!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseLine = resolve; });

    const processing = processRichMenuRuleWork(db, {
      limit: 1,
      clientFactory: () => ({
        async linkRichMenuToUser() { markStarted(); await release; },
        async unlinkRichMenuFromUser() {},
      }),
    });
    await started;
    raw.prepare("UPDATE friends SET metadata = '{\"paid\":true}' WHERE id = 'friend-000'").run();
    releaseLine();
    await processing;

    expect(raw.prepare('SELECT friend_id FROM rich_menu_rule_evaluation_queue').all())
      .toEqual([{ friend_id: 'friend-000' }]);
  });

  test('one friend shared by a sweep and dirty queue receives one LINE mutation across overlapping workers', async () => {
    seedFriends(1);
    raw.prepare("INSERT INTO tags (id, name) VALUES ('tag-paid', '購入済み')").run();
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-1', name: '購入済み', conditionType: 'tag_exists', conditionValue: 'tag-paid',
      richMenuId: 'menu-paid', priority: 10, isActive: true,
    });
    raw.prepare("INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-000', 'tag-paid')").run();
    await createRichMenuRuleReapplyJob(db, 'acc-1');
    let linkCalls = 0;
    const clientFactory = () => ({
      async linkRichMenuToUser() {
        linkCalls++;
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
      async unlinkRichMenuFromUser() {},
    });

    await Promise.all([
      processRichMenuRuleWork(db, { limit: 2, clientFactory }),
      processRichMenuRuleWork(db, { limit: 2, clientFactory }),
    ]);

    expect(linkCalls).toBe(1);
  });
});

describe('scheduled rich menu rule transitions', () => {
  test('queues only following friends whose active account crossed a period boundary', async () => {
    seedFriends(25);
    raw.prepare(
      `INSERT INTO friends (id, line_user_id, line_account_id, is_following)
       VALUES ('friend-unfollowed', 'U-off', 'acc-1', 0)`,
    ).run();
    raw.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
       VALUES ('acc-2', 'channel-2', 'B', 'account-token-2', 'secret-2')`,
    ).run();
    raw.prepare(
      `INSERT INTO friends (id, line_user_id, line_account_id, is_following)
       VALUES ('friend-other', 'U-other', 'acc-2', 1)`,
    ).run();
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-1', name: '開始境界', conditionType: 'tag_exists', conditionValue: 'tag-any',
      richMenuId: 'menu-1', priority: 10, isActive: true,
      activeFrom: '2026-07-20T00:10:00.000Z', activeUntil: null,
    });
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-2', name: '停止中', conditionType: 'tag_exists', conditionValue: 'tag-any',
      richMenuId: 'menu-2', priority: 10, isActive: false,
      activeFrom: '2026-07-20T00:10:00.000Z', activeUntil: null,
    });

    const result = await enqueueRichMenuRuleScheduleTransitions(
      db,
      new Date('2026-07-20T00:15:00.000Z'),
    );

    expect(result).toMatchObject({ enqueued: 25, scannedThrough: '2026-07-20T00:15:00.000Z' });
    expect(raw.prepare(
      `SELECT q.friend_id FROM rich_menu_rule_evaluation_queue q
       JOIN friends f ON f.id = q.friend_id
       WHERE f.line_account_id = 'acc-2' OR f.is_following = 0`,
    ).all()).toEqual([]);
  });

  test('recovers a missed scan from its checkpoint and is idempotent at the same scheduled time', async () => {
    seedFriends(1);
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-1', name: '見逃し回収', conditionType: 'tag_exists', conditionValue: 'tag-any',
      richMenuId: 'menu-1', priority: 10, isActive: true,
      activeFrom: '2026-07-20T00:10:00.000Z', activeUntil: null,
    });
    raw.prepare(
      `INSERT INTO rich_menu_rule_schedule_state (id, last_scanned_at)
       VALUES (1, '2026-07-20T00:00:00.000Z')`,
    ).run();

    const first = await enqueueRichMenuRuleScheduleTransitions(
      db,
      new Date('2026-07-20T00:30:00.000Z'),
    );
    const second = await enqueueRichMenuRuleScheduleTransitions(
      db,
      new Date('2026-07-20T00:30:00.000Z'),
    );

    expect(first).toMatchObject({ enqueued: 1, scannedFrom: '2026-07-20T00:00:00.000Z' });
    expect(second).toMatchObject({ enqueued: 0, scannedFrom: '2026-07-20T00:30:00.000Z' });
    expect(raw.prepare(
      'SELECT revision FROM rich_menu_rule_evaluation_queue WHERE friend_id = ?',
    ).get('friend-000')).toEqual({ revision: 1 });
  });

  test('preserves an in-flight lease while recording the newer time transition', async () => {
    seedFriends(1);
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-1', name: '終了境界', conditionType: 'tag_exists', conditionValue: 'tag-any',
      richMenuId: 'menu-1', priority: 10, isActive: true,
      activeFrom: null, activeUntil: '2026-07-20T00:10:00.000Z',
    });
    raw.prepare(
      `INSERT INTO rich_menu_rule_evaluation_queue
       (friend_id, available_at, lease_token, revision)
       VALUES ('friend-000', '2099-01-01T00:00:00.000', 'worker-in-flight', 1)`,
    ).run();

    await enqueueRichMenuRuleScheduleTransitions(db, new Date('2026-07-20T00:15:00.000Z'));

    expect(raw.prepare(
      `SELECT available_at, lease_token, revision
       FROM rich_menu_rule_evaluation_queue WHERE friend_id = ?`,
    ).get('friend-000')).toEqual({
      available_at: '2099-01-01T00:00:00.000',
      lease_token: 'worker-in-flight',
      revision: 2,
    });
  });

  test('drains a transition through the bulk queue path', async () => {
    seedFriends(25);
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-1', name: '開始境界', conditionType: 'tag_not_exists', conditionValue: 'tag-missing',
      richMenuId: 'menu-1', priority: 10, isActive: true,
      activeFrom: '2026-07-20T00:10:00.000Z', activeUntil: null,
    });
    await enqueueRichMenuRuleScheduleTransitions(db, new Date('2026-07-20T00:15:00.000Z'));

    const line = bulkLineDouble();
    const result = await processRichMenuRuleWork(db, {
      limit: 20,
      clientFactory: line.factory,
      bulkOptions: { sleep: async () => undefined },
    });

    expect(result).toMatchObject({ attempted: 20, queueProcessed: 20 });
    expect(line.bulkLinks.map((call) => call.userIds.length)).toEqual([20]);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM rich_menu_rule_evaluation_queue').get())
      .toEqual({ count: 5 });
  });
});
