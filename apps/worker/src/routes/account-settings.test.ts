import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { accountSettings } from './account-settings.js';

type TestEnv = { Bindings: { DB: D1Database } };

function asD1(raw: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = raw.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...values: unknown[]) { params = values; return api; },
        async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
        async run() {
          const result = statement.run(...(params as never[]));
          return { meta: { changes: result.changes } };
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

function createApp(raw: Database.Database) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.env = { DB: asD1(raw) };
    await next();
  });
  app.route('/', accountSettings);
  return app;
}

function put(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request('/api/account-settings/test-recipients', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let raw: Database.Database;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE friends (
      id TEXT PRIMARY KEY,
      line_user_id TEXT NOT NULL,
      display_name TEXT,
      picture_url TEXT,
      is_following INTEGER NOT NULL DEFAULT 1,
      line_account_id TEXT
    );
    CREATE TABLE account_settings (
      id TEXT PRIMARY KEY,
      line_account_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(line_account_id, key)
    );
  `);
  raw.prepare(`INSERT INTO friends (id, line_user_id, display_name, is_following, line_account_id) VALUES (?, ?, ?, ?, ?)`)
    .run('friend-a', 'U-a', 'テスターA', 1, 'acc-1');
  raw.prepare(`INSERT INTO friends (id, line_user_id, display_name, is_following, line_account_id) VALUES (?, ?, ?, ?, ?)`)
    .run('friend-b', 'U-b', 'テスターB', 1, 'acc-1');
  raw.prepare(`INSERT INTO friends (id, line_user_id, display_name, is_following, line_account_id) VALUES (?, ?, ?, ?, ?)`)
    .run('friend-other', 'U-other', '別アカウント', 1, 'acc-2');
  app = createApp(raw);
});

describe('test recipient settings', () => {
  test('saves one or more same-account friends, preserves order, and can clear them', async () => {
    const saved = await put(app, { accountId: 'acc-1', friendIds: ['friend-b', 'friend-a'] });
    expect(saved.status).toBe(200);

    const got = await app.request('/api/account-settings/test-recipients?accountId=acc-1');
    expect(got.status).toBe(200);
    expect((await got.json() as { data: Array<{ id: string }> }).data.map((friend) => friend.id))
      .toEqual(['friend-b', 'friend-a']);

    expect((await put(app, { accountId: 'acc-1', friendIds: [] })).status).toBe(200);
    const cleared = await app.request('/api/account-settings/test-recipients?accountId=acc-1');
    expect((await cleared.json() as { data: unknown[] }).data).toEqual([]);
  });

  test('rejects a cross-account friend and leaves the previous setting unchanged', async () => {
    expect((await put(app, { accountId: 'acc-1', friendIds: ['friend-a'] })).status).toBe(200);
    const rejected = await put(app, { accountId: 'acc-1', friendIds: ['friend-other'] });
    expect(rejected.status).toBe(400);

    const row = raw.prepare(`SELECT value FROM account_settings WHERE line_account_id = 'acc-1' AND key = 'test_recipients'`).get() as { value: string };
    expect(JSON.parse(row.value)).toEqual(['friend-a']);
  });

  test.each([
    { accountId: 'acc-1', friendIds: 'friend-a' },
    { accountId: 'acc-1', friendIds: ['friend-a', 'friend-a'] },
    { accountId: 'acc-1', friendIds: [''] },
  ])('rejects malformed or duplicate friendIds: %j', async (body) => {
    expect((await put(app, body)).status).toBe(400);
  });

  test('GET never returns stale or cross-account IDs stored in a corrupted legacy setting', async () => {
    raw.prepare(`INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at) VALUES ('s1', 'acc-1', 'test_recipients', ?, 'now', 'now')`)
      .run(JSON.stringify(['friend-other', 'friend-a', 'missing']));
    const got = await app.request('/api/account-settings/test-recipients?accountId=acc-1');
    expect((await got.json() as { data: Array<{ id: string }> }).data.map((friend) => friend.id))
      .toEqual(['friend-a']);
  });
});
