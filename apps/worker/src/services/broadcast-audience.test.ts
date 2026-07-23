import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  countBroadcastAudience,
  listBroadcastRecipientSnapshot,
  snapshotBroadcastRecipients,
} from './broadcast-audience.js';
import type { SegmentCondition } from './segment-query.js';

function d1(raw: Database.Database, preparedSql: string[] = []): D1Database {
  return {
    prepare(sql: string) {
      preparedSql.push(sql);
      const statement = raw.prepare(sql);
      let bindings: unknown[] = [];
      const api = {
        bind(...values: unknown[]) {
          bindings = values;
          return api;
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
      return api;
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      const results: unknown[] = [];
      raw.transaction(() => {
        for (const statement of statements) {
          results.push(statement.run());
        }
      })();
      return Promise.all(results);
    },
  } as unknown as D1Database;
}

let raw: Database.Database;
let db: D1Database;
let preparedSql: string[];

beforeEach(() => {
  raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE friends (
      id TEXT PRIMARY KEY,
      line_user_id TEXT NOT NULL,
      line_account_id TEXT,
      is_following INTEGER NOT NULL DEFAULT 1,
      metadata TEXT
    );
    CREATE TABLE friend_tags (
      friend_id TEXT NOT NULL,
      tag_id TEXT NOT NULL,
      PRIMARY KEY (friend_id, tag_id)
    );
    CREATE TABLE tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE friend_field_definitions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      default_value TEXT NOT NULL DEFAULT '',
      display_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX idx_friend_field_definitions_name
      ON friend_field_definitions (name);
    CREATE TABLE broadcast_recipient_snapshots (
      broadcast_id TEXT NOT NULL,
      friend_id TEXT NOT NULL,
      line_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (broadcast_id, friend_id)
    );
  `);
  raw.prepare(`INSERT INTO tags (id, name) VALUES ('vip', 'VIP'), ('blocked', '対象外')`).run();
  raw.prepare(
    `INSERT INTO friend_field_definitions
       (id, name, default_value, is_active)
     VALUES ('field-plan', 'プラン', '', 1), ('field-note', 'メモ', '', 1)`,
  ).run();

  const friends: Array<[string, string, string, number, string]> = [
    ['f-gold', 'u-gold', 'acc-1', 1, JSON.stringify({ プラン: 'gold', メモ: '' })],
    ['f-silver', 'u-silver', 'acc-1', 1, JSON.stringify({ プラン: 'silver', メモ: '連絡済み' })],
    ['f-missing', 'u-missing', 'acc-1', 1, '{}'],
    ['f-null', 'u-null', 'acc-1', 1, JSON.stringify({ プラン: null, メモ: null })],
    ['f-unfollowed', 'u-unfollowed', 'acc-1', 0, JSON.stringify({ プラン: 'gold', メモ: '' })],
    ['f-other-account', 'u-other', 'acc-2', 1, JSON.stringify({ プラン: 'gold', メモ: '' })],
  ];
  const insertFriend = raw.prepare(
    `INSERT INTO friends
       (id, line_user_id, line_account_id, is_following, metadata)
     VALUES (?, ?, ?, ?, ?)`,
  );
  for (const friend of friends) insertFriend.run(...friend);

  const insertTag = raw.prepare('INSERT INTO friend_tags (friend_id, tag_id) VALUES (?, ?)');
  insertTag.run('f-gold', 'vip');
  insertTag.run('f-silver', 'vip');
  insertTag.run('f-silver', 'blocked');
  insertTag.run('f-unfollowed', 'vip');
  insertTag.run('f-other-account', 'vip');

  preparedSql = [];
  db = d1(raw, preparedSql);
});

async function ids(condition: SegmentCondition): Promise<string[]> {
  await snapshotBroadcastRecipients(db, 'broadcast-test', 'acc-1', condition);
  return (await listBroadcastRecipientSnapshot(db, 'broadcast-test')).map((friend) => friend.id);
}

describe('broadcast audience tag conditions', () => {
  test('tag target, tag exclusion, and their AND combination select the expected following friends', async () => {
    await expect(ids({
      operator: 'AND',
      rules: [{ type: 'tag_exists', value: 'vip' }],
    })).resolves.toEqual(['f-gold', 'f-silver']);

    await expect(ids({
      operator: 'AND',
      rules: [{ type: 'tag_not_exists', value: 'vip' }],
    })).resolves.toEqual(['f-missing', 'f-null']);

    await expect(ids({
      operator: 'AND',
      rules: [
        { type: 'tag_exists', value: 'vip' },
        { type: 'tag_not_exists', value: 'blocked' },
      ],
    })).resolves.toEqual(['f-gold']);
  });

  test('a missing tag fails closed instead of turning tag exclusion into all friends', async () => {
    await expect(ids({
      operator: 'AND',
      rules: [{ type: 'tag_not_exists', value: 'deleted-tag' }],
    })).resolves.toEqual([]);
  });
});

describe('broadcast audience custom-field conditions', () => {
  test('equals, not-equals, empty, and not-empty are evaluated in SQL', async () => {
    await expect(ids({
      operator: 'AND',
      rules: [{ type: 'metadata_equals', value: { key: 'プラン', value: 'gold' } }],
    })).resolves.toEqual(['f-gold']);

    await expect(ids({
      operator: 'AND',
      rules: [{ type: 'metadata_not_equals', value: { key: 'プラン', value: 'gold' } }],
    })).resolves.toEqual(['f-missing', 'f-null', 'f-silver']);

    await expect(ids({
      operator: 'AND',
      rules: [{ type: 'metadata_empty', value: { key: 'メモ' } }],
    })).resolves.toEqual(['f-gold', 'f-missing', 'f-null']);

    await expect(ids({
      operator: 'AND',
      rules: [{ type: 'metadata_not_empty', value: { key: 'メモ' } }],
    })).resolves.toEqual(['f-silver']);
  });

  test('tag and custom-field rules compose without leaving the account scope', async () => {
    await expect(ids({
      operator: 'AND',
      rules: [
        { type: 'tag_exists', value: 'vip' },
        { type: 'metadata_equals', value: { key: 'プラン', value: 'gold' } },
      ],
    })).resolves.toEqual(['f-gold']);
  });
});

describe('send-time recipient snapshot', () => {
  test('uses one INSERT ... SELECT and remains stable after tags and fields change', async () => {
    const condition: SegmentCondition = {
      operator: 'AND',
      rules: [
        { type: 'tag_exists', value: 'vip' },
        { type: 'tag_not_exists', value: 'blocked' },
        { type: 'metadata_equals', value: { key: 'プラン', value: 'gold' } },
      ],
    };

    expect(await countBroadcastAudience(db, 'acc-1', condition)).toBe(1);
    expect(await snapshotBroadcastRecipients(db, 'broadcast-stable', 'acc-1', condition)).toBe(1);
    expect(preparedSql.some((sql) =>
      /INSERT\s+INTO\s+broadcast_recipient_snapshots[\s\S]+SELECT/i.test(sql),
    )).toBe(true);

    raw.prepare(`DELETE FROM friend_tags WHERE friend_id = 'f-gold' AND tag_id = 'vip'`).run();
    raw.prepare(`UPDATE friends SET metadata = ? WHERE id = 'f-gold'`)
      .run(JSON.stringify({ プラン: 'silver', メモ: '' }));

    expect(await countBroadcastAudience(db, 'acc-1', condition)).toBe(0);
    await expect(listBroadcastRecipientSnapshot(db, 'broadcast-stable')).resolves.toEqual([
      { id: 'f-gold', line_user_id: 'u-gold' },
    ]);
  });
});
