import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Env } from '../index.js';
import { followerImports } from './follower-imports.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;
const NOT_VERIFIED_MESSAGE = 'このアカウントは認証済みではないため利用できません (LINE の仕様)';

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
    statusText: status === 200 ? 'OK' : status === 403 ? 'Forbidden' : 'Not Found',
    headers: { 'Content-Type': 'application/json' },
  });
}

let raw: Database.Database;
let DB: D1Database;

function app(): Hono<Env> {
  const hono = new Hono<Env>();
  hono.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', name: '担当者', role: 'staff' });
    await next();
  });
  hono.route('/', followerImports);
  return hono;
}

function call(method: string, path: string): Promise<Response> {
  return app().request(path, { method }, { DB } as Env['Bindings']);
}

beforeEach(() => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  replayAll(raw);
  raw.prepare(`
    INSERT INTO line_accounts
      (id, channel_id, name, channel_access_token, channel_secret, is_active)
    VALUES ('acc-1', 'channel-1', 'LINEアカウント', 'access-token', 'secret', 1)
  `).run();
  DB = d1(raw);
});

afterEach(() => {
  vi.unstubAllGlobals();
  raw.close();
});

describe('/api/friends/follower-imports', () => {
  test('starts, restores progress, blocks a duplicate start, and advances without any send API', async () => {
    const requestedUrls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes('/followers/ids')) return jsonResponse({ userIds: ['U-new'] });
      if (url.includes('/profile/')) return jsonResponse({ userId: 'U-new', displayName: '新しい友だち' });
      return jsonResponse({ message: 'unexpected endpoint' }, 404);
    }));

    const startedResponse = await call('POST', '/api/friends/follower-imports?accountId=acc-1');
    expect(startedResponse.status).toBe(202);
    const started = await startedResponse.json() as { data: { id: string; status: string } };
    expect(started.data.status).toBe('profiling');

    const latest = await call('GET', '/api/friends/follower-imports/latest?accountId=acc-1');
    expect(await latest.json()).toMatchObject({
      success: true,
      data: { id: started.data.id, fetchedCount: 1, newCount: 1, existingCount: 0 },
    });

    const duplicate = await call('POST', '/api/friends/follower-imports?accountId=acc-1');
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ success: false, data: { id: started.data.id } });

    const advanced = await call(
      'POST',
      `/api/friends/follower-imports/${encodeURIComponent(started.data.id)}/advance?accountId=acc-1`,
    );
    expect(advanced.status).toBe(200);
    expect(await advanced.json()).toMatchObject({
      success: true,
      data: { status: 'completed', newCount: 1, existingCount: 0, failedCount: 0 },
    });
    expect(requestedUrls.every((url) => url.includes('/followers/ids') || url.includes('/profile/'))).toBe(true);
    expect(requestedUrls.some((url) => /message\/(push|multicast|broadcast)/.test(url))).toBe(false);
  });

  test.each([403, 404])('returns the exact honest error for follower endpoint status %s and never reports success', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ message: 'not verified' }, status)));

    const response = await call('POST', '/api/friends/follower-imports?accountId=acc-1');
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({
      success: false,
      error: NOT_VERIFIED_MESSAGE,
      errorCode: 'account_not_verified',
      data: { status: 'failed', newCount: 0, existingCount: 0 },
    });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM friends').get()).toEqual({ count: 0 });
  });

  test('validates account scope for start, latest, and advance', async () => {
    expect((await call('POST', '/api/friends/follower-imports')).status).toBe(400);
    expect((await call('GET', '/api/friends/follower-imports/latest')).status).toBe(400);
    expect((await call('POST', '/api/friends/follower-imports?accountId=missing')).status).toBe(404);
    expect((await call('POST', '/api/friends/follower-imports/job-x/advance?accountId=acc-1')).status).toBe(404);
  });
});
