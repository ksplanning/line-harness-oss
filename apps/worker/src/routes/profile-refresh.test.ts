import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../index.js';
import { profileRefresh } from './profile-refresh.js';

function asD1(raw: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = raw.prepare(sql);
      let bindings: unknown[] = [];
      const prepared = {
        bind(...args: unknown[]) {
          bindings = args;
          return prepared;
        },
        async first<T>() {
          return (statement.get(...(bindings as never[])) as T) ?? null;
        },
        async all<T>() {
          return { results: statement.all(...(bindings as never[])) as T[] };
        },
        async run() {
          const result = statement.run(...(bindings as never[]));
          return { meta: { changes: result.changes } };
        },
      };
      return prepared;
    },
  } as unknown as D1Database;
}

function setupSchema(raw: Database.Database) {
  raw.exec(`
    CREATE TABLE line_accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE friends (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      picture_url TEXT,
      line_account_id TEXT,
      is_following INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE friend_tags (friend_id TEXT NOT NULL, tag_id TEXT NOT NULL);
    CREATE TABLE messages_log (
      id TEXT PRIMARY KEY,
      friend_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      content TEXT,
      delivery_type TEXT,
      broadcast_id TEXT
    );
    CREATE TABLE broadcasts (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      batch_offset INTEGER NOT NULL DEFAULT 0,
      total_count INTEGER NOT NULL DEFAULT 0,
      failed_account_ids TEXT,
      dedup_progress TEXT,
      success_count INTEGER NOT NULL DEFAULT 0,
      sent_at TEXT,
      batch_lock_at TEXT,
      line_request_id TEXT
    );
  `);
}

function seedRecipients(raw: Database.Database) {
  raw.prepare(`INSERT INTO line_accounts (id, name) VALUES ('account-1', '本番アカウント')`).run();
  raw.prepare(`INSERT INTO tags (id, name) VALUES ('tag-1', '配信対象')`).run();
  raw.prepare(`INSERT INTO friends (id, user_id, line_account_id) VALUES (?, ?, 'account-1')`).run('friend-test', 'user-test');
  raw.prepare(`INSERT INTO friends (id, user_id, line_account_id) VALUES (?, ?, 'account-1')`).run('friend-real', 'user-real');
  raw.prepare(`INSERT INTO friend_tags (friend_id, tag_id) VALUES (?, 'tag-1')`).run('friend-test');
  raw.prepare(`INSERT INTO friend_tags (friend_id, tag_id) VALUES (?, 'tag-1')`).run('friend-real');
  raw.prepare(`INSERT INTO messages_log (id, friend_id, direction, content, delivery_type) VALUES (?, ?, 'outgoing', '告知URL', ?)`).run('log-test', 'friend-test', 'test');
  raw.prepare(`INSERT INTO messages_log (id, friend_id, direction, content, delivery_type) VALUES (?, ?, 'outgoing', '告知URL', ?)`).run('log-real', 'friend-real', 'push');
}

let raw: Database.Database;
let db: D1Database;

beforeEach(() => {
  raw = new Database(':memory:');
  setupSchema(raw);
  seedRecipients(raw);
  db = asD1(raw);
});

afterEach(() => raw.close());

function call(path: string, body: unknown) {
  const app = new Hono<Env>();
  app.route('/', profileRefresh);
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { DB: db } as Env['Bindings']);
}

describe('admin delivery metrics do not treat test sends as production delivery', () => {
  test('content leak and coverage count real push only', async () => {
    const leakResponse = await call('/api/admin/content-leak-check', {
      tagName: '配信対象',
      contentSubstring: '告知URL',
    });
    expect(leakResponse.status).toBe(200);
    const leak = await leakResponse.json() as {
      data: { unique_in_tag: number; same_friend_overlap: number; person_overlap: number };
    };
    expect(leak.data).toEqual({
      unique_in_tag: 2,
      same_friend_overlap: 1,
      person_overlap: 1,
    });

    const coverageResponse = await call('/api/admin/broadcast-coverage', {
      tagName: '配信対象',
      contentSubstring: '告知URL',
    });
    expect(coverageResponse.status).toBe(200);
    const coverage = await coverageResponse.json() as {
      data: {
        perAccount: Array<{ friends_total: number; friends_received: number }>;
        person: { unique_total: number; unique_received: number; unique_not_received: number };
        tagLeakBreakdown: Array<{ rest_unique: number; same_friend_dup: number; person_dup: number }>;
      };
    };
    expect(coverage.data.perAccount).toEqual([
      expect.objectContaining({ friends_total: 2, friends_received: 1 }),
    ]);
    expect(coverage.data.person).toEqual({
      unique_total: 2,
      unique_received: 1,
      unique_not_received: 1,
    });
    expect(coverage.data.tagLeakBreakdown).toEqual([
      expect.objectContaining({ rest_unique: 2, same_friend_dup: 1, person_dup: 1 }),
    ]);
  });

  test('tag dedup keeps a recipient whose only matching log is a test send', async () => {
    const response = await call('/api/admin/tag-remove-content-dups', {
      tagName: '配信対象',
      contentSubstring: '告知URL',
    });
    expect(response.status).toBe(200);
    expect(raw.prepare(`SELECT friend_id FROM friend_tags ORDER BY friend_id`).all()).toEqual([
      { friend_id: 'friend-test' },
    ]);
  });

  test('a test-send log cannot block resetting an otherwise unsent broadcast', async () => {
    raw.prepare(`INSERT INTO broadcasts (id, status) VALUES ('broadcast-1', 'sent')`).run();
    raw.prepare(`INSERT INTO messages_log (id, friend_id, direction, content, delivery_type, broadcast_id)
                 VALUES ('legacy-test-log', 'friend-test', 'outgoing', 'preview', 'test', 'broadcast-1')`).run();

    const response = await call('/api/admin/broadcasts/broadcast-1/reset-to-draft', {});
    expect(response.status).toBe(200);
    expect(raw.prepare(`SELECT status FROM broadcasts WHERE id = 'broadcast-1'`).get()).toEqual({ status: 'draft' });
  });
});
