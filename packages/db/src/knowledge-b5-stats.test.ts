/**
 * B-5 (T-E2) — 資料の chunk/embed 状態集計 helper (getDocumentChunkStats / countEmbeddedChunks)。
 *  - getDocumentChunkStats(db, accountId, docIds): doc_id → {chunkCount, embeddedCount} を **account 条件付き JOIN**
 *    集計で返す (他 account doc は集計対象外・embedded_at NOT NULL のみ embeddedCount・空配列/global doc/他 account
 *    id 混在を固定)。doc id は D1 bind 上限を超えないよう安全件数で batch。
 *  - countEmbeddedChunks(db, accountId?): embed 済 chunk 数を account スコープ (global + 指定) で返す。
 * migration ゼロ (既存 092/093 表 read のみ)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { getDocumentChunkStats, countEmbeddedChunks } from './knowledge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');
const BENIGN = /duplicate column name|already exists/i;

function splitStatements(sql: string): string[] {
  return sql.split(/;\s*(?:\r?\n|$)/).map((x) => x.trim()).filter(Boolean);
}
function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    for (const s of splitStatements(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))) {
      try { db.exec(s); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}
function d1(raw: Database.Database): D1Database {
  const makeStmt = (sql: string) => {
    const s = raw.prepare(sql);
    let params: unknown[] = [];
    const api = {
      bind(...a: unknown[]) { params = a; return api; },
      async first<T>() { return (s.get(...(params as never[])) as T) ?? null; },
      async all<T>() { return { results: s.all(...(params as never[])) as T[] }; },
      async run() { const i = s.run(...(params as never[])); return { meta: { changes: i.changes } }; },
      __exec() { return s.run(...(params as never[])); },
    };
    return api;
  };
  return {
    prepare(sql: string) { return makeStmt(sql); },
    async batch(stmts: Array<{ __exec: () => unknown }>) {
      const tx = raw.transaction(() => stmts.map((st) => st.__exec()));
      tx();
      return stmts.map(() => ({ success: true }));
    },
  } as unknown as D1Database;
}

let raw: Database.Database;
let DB: D1Database;

// doc + N chunks (embedded 済数 e) を seed。account は null(global) or 具体 id。
function seedDoc(id: string, accountId: string | null, total: number, embedded: number) {
  raw.prepare(`INSERT INTO knowledge_documents (id, line_account_id, source_type) VALUES (?,?, 'text')`).run(id, accountId);
  for (let i = 0; i < total; i += 1) {
    const embeddedAt = i < embedded ? '2026-07-11T10:00:00.000+09:00' : null;
    raw.prepare(
      `INSERT INTO knowledge_chunks (id, source_doc_id, line_account_id, chunk_index, content, embedded_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(`${id}-c${i}`, id, accountId, i, `body ${i}`, embeddedAt);
  }
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

describe('getDocumentChunkStats — 資料単位の chunk/embed 集計 (T-E2)', () => {
  test('chunk 総数と embed 済数を doc_id 別に返す (embedded_at NULL は embeddedCount に数えない)', async () => {
    seedDoc('d1', 'acc-1', 5, 2);
    seedDoc('d2', 'acc-1', 3, 3);
    const stats = await getDocumentChunkStats(DB, 'acc-1', ['d1', 'd2']);
    expect(stats['d1']).toEqual({ chunkCount: 5, embeddedCount: 2 });
    expect(stats['d2']).toEqual({ chunkCount: 3, embeddedCount: 3 });
  });

  test('他 account の doc は集計対象外 (cross-account 0)', async () => {
    seedDoc('mine', 'acc-1', 4, 1);
    seedDoc('theirs', 'acc-2', 9, 9);
    const stats = await getDocumentChunkStats(DB, 'acc-1', ['mine', 'theirs']);
    expect(stats['mine']).toEqual({ chunkCount: 4, embeddedCount: 1 });
    // 他 account の doc は集計されない (キー自体が無い = route が 0 default にする)。
    expect(stats['theirs']).toBeUndefined();
  });

  test('global(null) doc は account スコープに含まれる', async () => {
    seedDoc('g', null, 2, 2);
    const stats = await getDocumentChunkStats(DB, 'acc-1', ['g']);
    expect(stats['g']).toEqual({ chunkCount: 2, embeddedCount: 2 });
  });

  test('空配列は空オブジェクト (SQL を発行しない)', async () => {
    seedDoc('d1', 'acc-1', 3, 0);
    expect(await getDocumentChunkStats(DB, 'acc-1', [])).toEqual({});
  });

  test('D1 bind 上限 (>90 件) を超える docIds でも batch で正しく集計', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 130; i += 1) {
      const id = `doc-${i}`;
      ids.push(id);
      seedDoc(id, 'acc-1', 1, i % 2 === 0 ? 1 : 0);
    }
    const stats = await getDocumentChunkStats(DB, 'acc-1', ids);
    expect(Object.keys(stats).length).toBe(130);
    expect(stats['doc-0']).toEqual({ chunkCount: 1, embeddedCount: 1 });
    expect(stats['doc-1']).toEqual({ chunkCount: 1, embeddedCount: 0 });
    expect(stats['doc-129']).toEqual({ chunkCount: 1, embeddedCount: 0 });
  });
});

describe('countEmbeddedChunks — embed 済 chunk 総数 (account スコープ / T-E2・§4-4)', () => {
  test('account スコープ (global + 指定) の embed 済数を返す', async () => {
    seedDoc('d1', 'acc-1', 5, 3);
    seedDoc('g', null, 4, 4);
    seedDoc('other', 'acc-2', 6, 6);
    // acc-1 スコープ = acc-1(3) + global(4) = 7 (acc-2 は含めない)。
    expect(await countEmbeddedChunks(DB, 'acc-1')).toBe(7);
  });

  test('accountId 無し (null) は global のみ数える', async () => {
    seedDoc('g', null, 4, 4);
    seedDoc('a', 'acc-1', 5, 5);
    expect(await countEmbeddedChunks(DB, null)).toBe(4);
  });
});
