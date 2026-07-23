import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  countUnanswered,
  getAllUnansweredRows,
} from './unanswered-inbox.js';

function d1(raw: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = raw.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) {
          params = args;
          return api;
        },
        async first<T>() {
          return (statement.get(...(params as never[])) as T) ?? null;
        },
        async all<T>() {
          return { results: statement.all(...(params as never[])) as T[] };
        },
        async run() {
          const result = statement.run(...(params as never[]));
          return { meta: { changes: result.changes } };
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

describe('unanswered inquiry read boundary', () => {
  let raw: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    raw = new Database(':memory:');
    raw.exec(`
      CREATE TABLE line_accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE friends (
        id TEXT PRIMARY KEY,
        display_name TEXT,
        picture_url TEXT,
        line_account_id TEXT,
        is_following INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE messages_log (
        id TEXT PRIMARY KEY,
        friend_id TEXT NOT NULL,
        direction TEXT NOT NULL,
        message_type TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT,
        delivery_type TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE auto_replies (
        keyword TEXT NOT NULL,
        match_type TEXT NOT NULL,
        line_account_id TEXT,
        is_active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        friend_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'unread',
        read_at TEXT
      );

      INSERT INTO line_accounts (id, name) VALUES ('account-1', 'LINE 公式');
      INSERT INTO friends
        (id, display_name, picture_url, line_account_id, is_following)
      VALUES
        ('friend-1', '問い合わせ顧客', NULL, 'account-1', 1);
      INSERT INTO chats (id, friend_id, status, read_at)
      VALUES ('chat-1', 'friend-1', 'unread', NULL);
      INSERT INTO messages_log
        (id, friend_id, direction, message_type, content, source, created_at)
      VALUES
        (
          'incoming-1',
          'friend-1',
          'incoming',
          'text',
          '最初の問い合わせ',
          'user_unmatched',
          '2026-07-23T10:00:00.000+09:00'
        );
    `);
    db = d1(raw);
  });

  afterEach(() => {
    raw.close();
  });

  async function readState(): Promise<{
    rows: Array<{ friendId: string; content: string }>;
    count: number;
  }> {
    const [rows, count] = await Promise.all([
      getAllUnansweredRows(db),
      countUnanswered(db),
    ]);
    return {
      rows: rows.map((row) => ({
        friendId: row.friendId,
        content: row.lastIncomingContent,
      })),
      count: count.total,
    };
  }

  test('read_at hides only incoming messages at or before the latest read boundary', async () => {
    expect(await readState()).toEqual({
      rows: [{ friendId: 'friend-1', content: '最初の問い合わせ' }],
      count: 1,
    });

    raw.prepare(`UPDATE chats SET read_at = ? WHERE id = 'chat-1'`)
      .run('2026-07-23T10:01:00.000+09:00');
    expect(await readState()).toEqual({ rows: [], count: 0 });

    raw.prepare(
      `INSERT INTO messages_log
         (id, friend_id, direction, message_type, content, source, created_at)
       VALUES
         ('incoming-2', 'friend-1', 'incoming', 'text', '既読後の問い合わせ',
          'user_unmatched', '2026-07-23T10:02:00.000+09:00')`,
    ).run();
    expect(await readState()).toEqual({
      rows: [{ friendId: 'friend-1', content: '既読後の問い合わせ' }],
      count: 1,
    });

    raw.prepare(`UPDATE chats SET read_at = ? WHERE id = 'chat-1'`)
      .run('2026-07-23T10:03:00.000+09:00');
    expect(await readState()).toEqual({ rows: [], count: 0 });
  });
});
