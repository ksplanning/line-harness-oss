import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  getFriendCountSummary,
  getFriendRegistrationTrend,
} from './friends.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATION_FILE = '140_friend_stats_index.sql';
const MIGRATION_PATH = join(PKG_ROOT, 'migrations', MIGRATION_FILE);

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...values: unknown[]) {
          params = values;
          return api;
        },
        async first<T>() {
          return (statement.get(...(params as never[])) as T) ?? null;
        },
        async all<T>() {
          return { results: statement.all(...(params as never[])) as T[] };
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

let raw: Database.Database;
let db: D1Database;

beforeEach(() => {
  raw = new Database(':memory:');
  raw.exec(readFileSync(join(PKG_ROOT, 'bootstrap.sql'), 'utf8'));
  raw.prepare(
    `INSERT INTO line_accounts
       (id, channel_id, name, channel_access_token, channel_secret)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('acc-1', 'channel-1', 'メイン', 'token-1', 'secret-1');
  raw.prepare(
    `INSERT INTO line_accounts
       (id, channel_id, name, channel_access_token, channel_secret)
     VALUES (?, ?, ?, ?, ?)`,
  ).run('acc-2', 'channel-2', '別アカウント', 'token-2', 'secret-2');

  const insertFriend = raw.prepare(
    `INSERT INTO friends
       (id, line_user_id, is_following, line_account_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertFriend.run('friend-old', 'U-old', 1, 'acc-1', '2026-07-10T09:00:00.000', '2026-07-10T09:00:00.000');
  insertFriend.run('friend-utc', 'U-utc', 1, 'acc-1', '2026-07-20T16:00:00.000Z', '2026-07-20T16:00:00.000Z');
  insertFriend.run('friend-a', 'U-a', 1, 'acc-1', '2026-07-21T10:00:00.000', '2026-07-21T10:00:00.000');
  insertFriend.run('friend-b', 'U-b', 0, 'acc-1', '2026-07-21T18:00:00.000', '2026-07-22T08:00:00.000');
  insertFriend.run('friend-c', 'U-c', 1, 'acc-1', '2026-07-23T08:30:00.000', '2026-07-23T08:30:00.000');
  insertFriend.run('friend-other', 'U-other', 0, 'acc-2', '2026-07-22T12:00:00.000', '2026-07-22T12:00:00.000');
  db = d1(raw);
});

afterEach(() => {
  raw.close();
});

describe('friend statistics', () => {
  test('counts all, non-following, and following friends for one LINE account', async () => {
    await expect(getFriendCountSummary(db, 'acc-1')).resolves.toEqual({
      total: 5,
      blocked: 1,
      sendable: 4,
    });
  });

  test('returns a zero-filled daily registration trend for the requested inclusive range', async () => {
    await expect(
      getFriendRegistrationTrend(db, 'acc-1', '2026-07-21', '2026-07-23'),
    ).resolves.toEqual([
      { date: '2026-07-21', registrations: 3 },
      { date: '2026-07-22', registrations: 0 },
      { date: '2026-07-23', registrations: 1 },
    ]);
  });
});

describe(`migration ${MIGRATION_FILE}`, () => {
  test('is additive and indexes account-scoped registration ranges', () => {
    expect(existsSync(MIGRATION_PATH)).toBe(true);
    if (!existsSync(MIGRATION_PATH)) return;

    const sql = readFileSync(MIGRATION_PATH, 'utf8');
    expect(sql).not.toMatch(/^\s*(?:DROP|RENAME|DELETE|UPDATE)\b/im);
    expect(sql).not.toMatch(/^\s*ALTER\s+TABLE\b/im);

    const migrationDb = new Database(':memory:');
    migrationDb.exec(`
      CREATE TABLE friends (
        id TEXT PRIMARY KEY,
        line_account_id TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO friends (id, line_account_id, created_at)
      VALUES ('existing', 'acc-1', '2026-07-23T00:00:00.000');
    `);
    migrationDb.exec(sql);

    expect(migrationDb.prepare(
      `SELECT id FROM friends WHERE id = 'existing'`,
    ).get()).toEqual({ id: 'existing' });
    expect(migrationDb.prepare(
      `PRAGMA index_info('idx_friends_account_created')`,
    ).all()).toMatchObject([
      { name: 'line_account_id' },
      { name: 'created_at' },
    ]);
    migrationDb.close();
  });

  test('is included in the generated bootstrap for fresh databases', () => {
    const bootstrapDb = new Database(':memory:');
    bootstrapDb.exec(readFileSync(join(PKG_ROOT, 'bootstrap.sql'), 'utf8'));
    expect(bootstrapDb.prepare(
      `PRAGMA index_info('idx_friends_account_created')`,
    ).all()).toMatchObject([
      { name: 'line_account_id' },
      { name: 'created_at' },
    ]);
    bootstrapDb.close();
  });
});
