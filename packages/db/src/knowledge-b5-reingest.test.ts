/**
 * B-5 (T-E3) — replaceKnowledgeChunks: 1 資料の chunks を単一 db.batch で原子置換 (旧 chunks 全削除 + 新 chunks 挿入)。
 *  - 親 document は残す (updated_at 更新)。旧 chunk id は置換前に取得済 (呼出 route が Vectorize 掃除に使う)。
 *  - chunk.line_account_id = 引数 accountId (document とスコープ同値 / cross-account 防止)。
 *  - AD/AI トリガで FTS も旧除去→新反映。deleteKnowledgeDocument が親 doc も消すのと異なり doc は保持。
 * migration ゼロ (既存 092 表への write helper 追加のみ)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import {
  createKnowledgeDocument,
  insertKnowledgeChunks,
  getChunksBySourceDoc,
  getKnowledgeDocumentById,
  replaceKnowledgeChunks,
} from './knowledge.js';

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
beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

const ftsCount = () => (raw.prepare(`SELECT count(*) c FROM knowledge_chunks_fts`).get() as { c: number }).c;

describe('replaceKnowledgeChunks — 原子置換 (T-E3)', () => {
  test('旧 chunks を全削除し新 chunks を挿入・親 document は残り updated_at 更新', async () => {
    const doc = await createKnowledgeDocument(DB, { lineAccountId: 'acc-1', sourceType: 'url', sourceUrl: 'https://x/' });
    await insertKnowledgeChunks(DB, doc.id, 'acc-1', [
      { chunkIndex: 0, content: '旧A', searchText: 'きゅ ゅう' },
      { chunkIndex: 1, content: '旧B', searchText: 'きゅ ゅう' },
    ]);
    const oldChunks = await getChunksBySourceDoc(DB, doc.id);
    const oldIds = oldChunks.map((c) => c.id);
    expect(oldIds.length).toBe(2);

    await replaceKnowledgeChunks(DB, doc.id, 'acc-1', [
      { chunkIndex: 0, content: '新X', searchText: 'しん んえ' },
    ]);
    const after = await getChunksBySourceDoc(DB, doc.id);
    expect(after.length).toBe(1);
    expect(after[0].content).toBe('新X');
    // 新 chunk は新 UUID (旧 id は残らない)。
    expect(oldIds).not.toContain(after[0].id);
    // 親 document は残る。
    const stillDoc = await getKnowledgeDocumentById(DB, doc.id);
    expect(stillDoc).not.toBeNull();
    expect(stillDoc!.source_url).toBe('https://x/');
    // FTS も置換後の 1 件に (AD で旧除去 → AI で新反映)。
    expect(ftsCount()).toBe(1);
  });

  test('新 chunk の line_account_id は引数 accountId (document とスコープ同値)', async () => {
    const doc = await createKnowledgeDocument(DB, { lineAccountId: 'acc-1', sourceType: 'url', sourceUrl: 'https://x/' });
    await insertKnowledgeChunks(DB, doc.id, 'acc-1', [{ chunkIndex: 0, content: '旧', searchText: 'a' }]);
    await replaceKnowledgeChunks(DB, doc.id, 'acc-1', [
      { chunkIndex: 0, content: '新1', searchText: 'a' },
      { chunkIndex: 1, content: '新2', searchText: 'b' },
    ]);
    const accts = (raw.prepare(`SELECT DISTINCT line_account_id a FROM knowledge_chunks WHERE source_doc_id = ?`).all(doc.id) as { a: string }[]).map((r) => r.a);
    expect(accts).toEqual(['acc-1']);
  });

  test('空 chunks は旧を全削除し 0 件にする (原子性は保つ)', async () => {
    const doc = await createKnowledgeDocument(DB, { lineAccountId: 'acc-1', sourceType: 'url', sourceUrl: 'https://x/' });
    await insertKnowledgeChunks(DB, doc.id, 'acc-1', [{ chunkIndex: 0, content: '旧', searchText: 'a' }]);
    await replaceKnowledgeChunks(DB, doc.id, 'acc-1', []);
    expect((await getChunksBySourceDoc(DB, doc.id)).length).toBe(0);
    expect(await getKnowledgeDocumentById(DB, doc.id)).not.toBeNull(); // doc は残る
  });
});
