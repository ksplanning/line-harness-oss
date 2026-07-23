import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import { mergeFriendMetadata } from './friends.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');

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
let DB: D1Database;

beforeEach(() => {
  raw = new Database(':memory:');
  raw.exec(readFileSync(join(PKG_ROOT, 'bootstrap.sql'), 'utf8'));
  raw.prepare(
    `INSERT INTO friends (id, line_user_id, display_name, metadata)
     VALUES ('friend-1', 'U1', '田中', '{"existing":"keep"}')`,
  ).run();
  DB = d1(raw);
});

describe('mergeFriendMetadata', () => {
  test('merges one field without losing unrelated metadata', async () => {
    const result = await mergeFriendMetadata(DB, 'friend-1', { 入金確認: '済' });

    expect(result.status).toBe('updated');
    expect(JSON.parse(raw.prepare(
      "SELECT metadata FROM friends WHERE id = 'friend-1'",
    ).pluck().get() as string)).toEqual({ existing: 'keep', 入金確認: '済' });
  });

  test('stores an empty string as an explicit blank', async () => {
    await mergeFriendMetadata(DB, 'friend-1', { 入金確認: '済' });
    const result = await mergeFriendMetadata(DB, 'friend-1', { 入金確認: '' });

    expect(result.status).toBe('updated');
    expect(JSON.parse(raw.prepare(
      "SELECT metadata FROM friends WHERE id = 'friend-1'",
    ).pluck().get() as string)).toMatchObject({ 入金確認: '' });
  });

  test('returns structured outcomes for missing friends and invalid stored JSON', async () => {
    expect(await mergeFriendMetadata(DB, 'missing', { x: 'y' }))
      .toEqual({ status: 'not_found' });

    raw.prepare("UPDATE friends SET metadata = '{broken' WHERE id = 'friend-1'").run();
    expect(await mergeFriendMetadata(DB, 'friend-1', { x: 'y' }))
      .toEqual({ status: 'invalid' });
  });
});
