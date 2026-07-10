/**
 * T-C3 / D-4 (Phase B B-3) — knowledge db helper (保存/取得のみ) を実 FTS5 (better-sqlite3) で検証。
 *  - createKnowledgeDocument が JST timestamp で document を作る。
 *  - insertKnowledgeChunks が D1 batch で原子的に INSERT し account 同値コピー・FTS 反映・UNIQUE 一意。
 *  - listKnowledgeDocuments が account スコープ (global + 指定 account) を返す。
 *  - deleteKnowledgeDocument が chunks→document の順で削除し ad トリガで FTS を除去 (CASCADE 非依存)。
 * db 層は計算しない (search_text は呼出側が渡す = 依存方向: packages/db は apps/worker を import しない)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import {
  createKnowledgeDocument,
  insertKnowledgeChunks,
  listKnowledgeDocuments,
  getKnowledgeDocumentById,
  deleteKnowledgeDocument,
} from './knowledge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(PKG_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const s of readFileSync(join(PKG_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((x) => x.trim()).filter(Boolean)) {
      try { db.exec(s); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

// D1 互換 mock (batch 対応)。prepare が返す stmt は batch でも実行できるよう __exec を持つ。
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
let db: D1Database;
beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  db = d1(raw);
});

function ftsCount() { return (raw.prepare(`SELECT count(*) c FROM knowledge_chunks_fts`).get() as { c: number }).c; }

describe('createKnowledgeDocument (T-C3)', () => {
  test('document を作り JST timestamp (T 区切り・+9h) で返す', async () => {
    const doc = await createKnowledgeDocument(db, { lineAccountId: 'acc-1', sourceType: 'url', sourceUrl: 'https://example.com/', title: 'ページ' });
    expect(doc.source_type).toBe('url');
    expect(doc.source_url).toBe('https://example.com/');
    expect(doc.line_account_id).toBe('acc-1');
    expect(doc.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/); // JST strftime 形式
  });

  test('text kind は source_url NULL・title 省略可', async () => {
    const doc = await createKnowledgeDocument(db, { lineAccountId: null, sourceType: 'text' });
    expect(doc.source_type).toBe('text');
    expect(doc.source_url).toBeNull();
    expect(doc.title).toBeNull();
    expect(doc.line_account_id).toBeNull();
  });
});

describe('insertKnowledgeChunks (D1 batch 原子性 + account 同値 + FTS 反映 / T-C3・D-4)', () => {
  test('batch INSERT で全チャンクを保存し ai トリガで knowledge_chunks_fts へ反映', async () => {
    const doc = await createKnowledgeDocument(db, { lineAccountId: 'acc-1', sourceType: 'text' });
    await insertKnowledgeChunks(db, doc.id, 'acc-1', [
      { chunkIndex: 0, content: '本文1', searchText: 'ほん んぶ' },
      { chunkIndex: 1, content: '本文2', searchText: 'てす すと' },
    ]);
    expect((raw.prepare(`SELECT count(*) c FROM knowledge_chunks WHERE source_doc_id=?`).get(doc.id) as { c: number }).c).toBe(2);
    expect(ftsCount()).toBe(2);
    const hit = raw.prepare(`SELECT c.content FROM knowledge_chunks_fts x JOIN knowledge_chunks c ON c.rowid=x.rowid WHERE x.search_text='てす すと'`).get() as { content: string } | undefined;
    expect(hit?.content).toBe('本文2');
  });

  test('chunk.line_account_id に親 document のスコープを同値コピー (Codex #9)', async () => {
    const doc = await createKnowledgeDocument(db, { lineAccountId: 'acc-9', sourceType: 'text' });
    await insertKnowledgeChunks(db, doc.id, doc.line_account_id, [{ chunkIndex: 0, content: 'x', searchText: 'ab' }]);
    const acct = (raw.prepare(`SELECT line_account_id FROM knowledge_chunks WHERE source_doc_id=?`).get(doc.id) as { line_account_id: string }).line_account_id;
    expect(acct).toBe('acc-9');
  });

  test('UNIQUE(source_doc_id, chunk_index) 違反時 batch 全体が rollback (原子性)', async () => {
    const doc = await createKnowledgeDocument(db, { lineAccountId: null, sourceType: 'text' });
    await insertKnowledgeChunks(db, doc.id, null, [{ chunkIndex: 0, content: 'first', searchText: 'aa' }]);
    // 同一 (doc, index=0) を含む 2 件目 batch は UNIQUE 違反 → transaction rollback で 1 件も増えない。
    await expect(
      insertKnowledgeChunks(db, doc.id, null, [
        { chunkIndex: 1, content: 'ok', searchText: 'bb' },
        { chunkIndex: 0, content: 'dup', searchText: 'cc' },
      ]),
    ).rejects.toThrow(/UNIQUE/i);
    expect((raw.prepare(`SELECT count(*) c FROM knowledge_chunks WHERE source_doc_id=?`).get(doc.id) as { c: number }).c).toBe(1);
    expect(ftsCount()).toBe(1);
  });

  test('空配列は no-op', async () => {
    const doc = await createKnowledgeDocument(db, { lineAccountId: null, sourceType: 'text' });
    await insertKnowledgeChunks(db, doc.id, null, []);
    expect(ftsCount()).toBe(0);
  });
});

describe('listKnowledgeDocuments — account スコープ (D-4)', () => {
  test('global(null) + 指定 account の document のみ返し他 account を返さない', async () => {
    await createKnowledgeDocument(db, { lineAccountId: 'acc-1', sourceType: 'text', title: 'A' });
    await createKnowledgeDocument(db, { lineAccountId: null, sourceType: 'text', title: 'G' });
    await createKnowledgeDocument(db, { lineAccountId: 'acc-2', sourceType: 'text', title: 'B' });
    const titles = (await listKnowledgeDocuments(db, 'acc-1')).map((d) => d.title).sort();
    expect(titles).toEqual(['A', 'G']); // acc-2 の B は含まれない
  });
});

describe('deleteKnowledgeDocument — chunks→document 順 + FTS 除去 (M-5 CASCADE 非依存 / D-4)', () => {
  test('資料削除で chunks・document・FTS 索引が全て消える', async () => {
    const doc = await createKnowledgeDocument(db, { lineAccountId: 'acc-1', sourceType: 'text' });
    await insertKnowledgeChunks(db, doc.id, 'acc-1', [
      { chunkIndex: 0, content: 'a', searchText: 'aa' },
      { chunkIndex: 1, content: 'b', searchText: 'bb' },
    ]);
    expect(ftsCount()).toBe(2);
    await deleteKnowledgeDocument(db, doc.id);
    expect(await getKnowledgeDocumentById(db, doc.id)).toBeNull();
    expect((raw.prepare(`SELECT count(*) c FROM knowledge_chunks WHERE source_doc_id=?`).get(doc.id) as { c: number }).c).toBe(0);
    expect(ftsCount()).toBe(0); // ad トリガで FTS からも除去 (CASCADE に依存しない)
  });
});
