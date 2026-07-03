/**
 * canned-responses.ts (G23 チャット定型文) の db helper 検証 (real SQLite / schema replay)。
 *
 *   - create→getById で title/content を保全 round-trip
 *   - update は渡された列だけ SET (title のみ / content のみ / 両方)
 *   - delete で消える
 *   - list scoping: account 行 + NULL global がその account に見え、別 account の行は見えない
 *   - list は created_at ASC (挿入順で安定 = ピッカーの位置が動かない)
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import {
  listCannedResponses,
  createCannedResponse,
  getCannedResponseById,
  updateCannedResponse,
  deleteCannedResponse,
} from './canned-responses.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const s = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) {
          params = args;
          return api;
        },
        async first<T>() {
          return (s.get(...(params as never[])) as T) ?? null;
        },
        async all<T>() {
          return { results: s.all(...(params as never[])) as T[] };
        },
        async run() {
          s.run(...(params as never[]));
          return {};
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
  raw.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  db = d1(raw);
});

describe('canned-responses helper', () => {
  test('create → getById round-trips title and content', async () => {
    const created = await createCannedResponse(db, { lineAccountId: 'acc-1', title: '営業案内', content: '本日はご案内します' });
    const got = await getCannedResponseById(db, created.id);
    expect(got!.title).toBe('営業案内');
    expect(got!.content).toBe('本日はご案内します');
    expect(got!.lineAccountId).toBe('acc-1');
  });

  test('update with only title changes title and keeps content', async () => {
    const created = await createCannedResponse(db, { lineAccountId: 'acc-1', title: '旧', content: '本文' });
    const updated = await updateCannedResponse(db, created.id, { title: '新' });
    expect(updated!.title).toBe('新');
    expect(updated!.content).toBe('本文');
  });

  test('update with only content changes content and keeps title', async () => {
    const created = await createCannedResponse(db, { lineAccountId: 'acc-1', title: 'タイトル', content: '旧本文' });
    const updated = await updateCannedResponse(db, created.id, { content: '新本文' });
    expect(updated!.title).toBe('タイトル');
    expect(updated!.content).toBe('新本文');
  });

  test('update with both changes both', async () => {
    const created = await createCannedResponse(db, { lineAccountId: 'acc-1', title: 'a', content: 'b' });
    const updated = await updateCannedResponse(db, created.id, { title: 'x', content: 'y' });
    expect(updated!.title).toBe('x');
    expect(updated!.content).toBe('y');
  });

  test('update returns null for a missing id', async () => {
    expect(await updateCannedResponse(db, 'nope', { title: 'x' })).toBeNull();
  });

  test('delete removes the row', async () => {
    const created = await createCannedResponse(db, { lineAccountId: 'acc-1', title: 'x', content: 'y' });
    await deleteCannedResponse(db, created.id);
    expect(await getCannedResponseById(db, created.id)).toBeNull();
  });

  test('list scopes to the account plus NULL global, excludes other accounts', async () => {
    await createCannedResponse(db, { lineAccountId: 'acc-1', title: 'acc1', content: 'c' });
    await createCannedResponse(db, { lineAccountId: null, title: 'global', content: 'c' });
    await createCannedResponse(db, { lineAccountId: 'acc-2', title: 'acc2', content: 'c' });

    const forAcc1 = await listCannedResponses(db, 'acc-1');
    const titles = forAcc1.map((r) => r.title).sort();
    expect(titles).toEqual(['acc1', 'global']);
  });

  test('list orders by created_at ASC (insert order stays stable)', async () => {
    // 明示的な created_at で決定的に順序を検証 (jstNow の ms 衝突を避ける)。
    raw
      .prepare(`INSERT INTO canned_responses (id, line_account_id, title, content, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
      .run('c-b', 'acc-1', 'B', 'c', '2024-01-02T00:00:00.000+09:00', '2024-01-02T00:00:00.000+09:00');
    raw
      .prepare(`INSERT INTO canned_responses (id, line_account_id, title, content, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
      .run('c-a', 'acc-1', 'A', 'c', '2024-01-01T00:00:00.000+09:00', '2024-01-01T00:00:00.000+09:00');
    const list = await listCannedResponses(db, 'acc-1');
    expect(list.map((r) => r.title)).toEqual(['A', 'B']);
  });
});
