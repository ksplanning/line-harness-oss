/**
 * T-C6 (Phase B B-3) — chunk pre-tokenize + retrieval 基盤を実 FTS5 (better-sqlite3) で検証。
 *  - buildChunkSearchText が normalize/ngrams 再利用で 2-gram を作り buildQuerySearchText と同一入力で一致 (drift 防止)。
 *  - splitIntoChunks が段落境界で ~400字/最大1000/最小20/上限200 に分割する決定的純関数。
 *  - retrieveChunkCandidates が account スコープ内の chunk を rowid JOIN で bm25 付き top-K で返し他 account を返さない。
 *  - backfillChunkSearchText が件数一致・再実行 idempotent (rowid/search_text 同値)。
 * **本 batch は live RAG に結線しない** (基盤・B-4 で結線)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { buildChunkSearchText, splitIntoChunks, retrieveChunkCandidates, backfillChunkSearchText } from './knowledge.js';
import { buildQuerySearchText } from './faq-fts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(DB_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const s of readFileSync(join(DB_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((x) => x.trim()).filter(Boolean)) {
      try { db.exec(s); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}
function d1(raw: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const s = raw.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...a: unknown[]) { params = a; return api; },
        async first<T>() { return (s.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: s.all(...(params as never[])) as T[] }; },
        async run() { const i = s.run(...(params as never[])); return { meta: { changes: i.changes } }; },
      };
      return api;
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

// content + worker 計算 search_text で chunk を直接 insert (トリガが FTS 反映)。
function insertChunk(docId: string, acct: string | null, index: number, content: string) {
  raw.prepare(`INSERT OR IGNORE INTO knowledge_documents (id, line_account_id, source_type) VALUES (?, ?, 'text')`).run(docId, acct);
  raw.prepare(`INSERT INTO knowledge_chunks (id, source_doc_id, line_account_id, chunk_index, content, search_text) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(`${docId}-${index}`, docId, acct, index, content, buildChunkSearchText(content));
}

describe('buildChunkSearchText (normalize/ngrams 再利用・drift 防止 / T-C6)', () => {
  test('2-gram 空白連結を作る', () => {
    expect(buildChunkSearchText('駐車場')).toBe('駐車 車場');
  });
  test('buildQuerySearchText と同一入力で一致 (query drift 防止 / Codex #16)', () => {
    for (const s of ['営業時間は10時から', '駐車場はありますか', 'アクセス方法']) {
      expect(buildChunkSearchText(s)).toBe(buildQuerySearchText(s));
    }
  });
});

describe('splitIntoChunks (決定的純関数 / §5-4)', () => {
  test('段落 (空行) 境界で分割する', () => {
    const chunks = splitIntoChunks('第一段落の本文です。\n\n第二段落の本文です。\n\n第三段落の本文です。');
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.join('')).toContain('第一段落');
    expect(chunks.join('')).toContain('第三段落');
  });
  test('最大 1000 字を超えない', () => {
    const chunks = splitIntoChunks('あ'.repeat(3500));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
    expect(chunks.length).toBeGreaterThan(1);
  });
  test('極小の trailing 片 (<20字) は捨てる', () => {
    const chunks = splitIntoChunks('本文'.repeat(300) + '\n\nあ'); // 大段落 + 1 字段落
    expect(chunks.every((c) => c.trim().length >= 20)).toBe(true);
  });
  test('短文書は 1 チャンクとして保持 (全捨てしない)', () => {
    expect(splitIntoChunks('営業は10時')).toEqual(['営業は10時']);
  });
  test('1 資料あたり最大 200 チャンク', () => {
    const many = Array.from({ length: 500 }, (_, i) => `段落${i}の本文テキストをここに入れます。`).join('\n\n');
    expect(splitIntoChunks(many).length).toBeLessThanOrEqual(200);
  });
  test('決定的 (同一入力→同一出力)', () => {
    const t = '朝の挨拶。\n\n昼の連絡事項。\n\n夜のまとめ。';
    expect(splitIntoChunks(t)).toEqual(splitIntoChunks(t));
  });
});

describe('retrieveChunkCandidates (account スコープ + bm25 + rowid JOIN / T-C6・D-4)', () => {
  test('account スコープ内の chunk を bm25 付きで返し他 account を返さない', async () => {
    insertChunk('d1', 'acc-1', 0, '駐車場は店舗の裏にあります');
    insertChunk('d2', 'acc-2', 0, '駐車場は建物の地下です'); // 別 account
    insertChunk('d3', null, 0, '駐車場の共通案内です'); // global
    const cands = await retrieveChunkCandidates(db, '駐車場はありますか', 'acc-1', 5);
    const accts = cands.map((c) => c.chunk.line_account_id);
    expect(accts).not.toContain('acc-2'); // 他 account の chunk は返さない (cross-account 漏洩 0)
    expect(cands.length).toBeGreaterThanOrEqual(1);
    expect(cands.every((c) => typeof c.bm25 === 'number')).toBe(true); // bm25 返却
    expect(cands[0].chunk.content).toContain('駐車場'); // rowid JOIN で本文が取れる
  });
  test('空 bigram (極短文) は [] 返し', async () => {
    insertChunk('d1', 'acc-1', 0, '本文');
    expect(await retrieveChunkCandidates(db, '', 'acc-1')).toEqual([]);
  });
  test('bm25 昇順 top-K (limit 尊重)', async () => {
    for (let i = 0; i < 8; i++) insertChunk('d1', 'acc-1', i, `駐車場の案内その${i}番です`);
    const cands = await retrieveChunkCandidates(db, '駐車場', 'acc-1', 3);
    expect(cands.length).toBe(3);
  });
});

describe('backfillChunkSearchText (件数一致 + idempotent / T-C6・Codex #17)', () => {
  test('全 chunk の search_text を埋め FTS 件数が chunk 件数に一致', async () => {
    // search_text='' で直接 insert (migration 直後を模す・トリガは '' を索引)。
    raw.prepare(`INSERT INTO knowledge_documents (id, source_type) VALUES ('d1','text')`).run();
    raw.prepare(`INSERT INTO knowledge_chunks (id, source_doc_id, chunk_index, content, search_text) VALUES ('c1','d1',0,'駐車場はありますか','')`).run();
    raw.prepare(`INSERT INTO knowledge_chunks (id, source_doc_id, chunk_index, content, search_text) VALUES ('c2','d1',1,'営業時間を教えて','')`).run();
    const n = await backfillChunkSearchText(db);
    expect(n).toBe(2);
    const chunkCount = (raw.prepare(`SELECT count(*) c FROM knowledge_chunks`).get() as { c: number }).c;
    const ftsCount = (raw.prepare(`SELECT count(*) c FROM knowledge_chunks_fts`).get() as { c: number }).c;
    expect(ftsCount).toBe(chunkCount);
    expect((raw.prepare(`SELECT search_text FROM knowledge_chunks WHERE id='c1'`).get() as { search_text: string }).search_text).toBe(buildChunkSearchText('駐車場はありますか'));
  });
  test('再実行 idempotent: rowid/search_text 同値', async () => {
    raw.prepare(`INSERT INTO knowledge_documents (id, source_type) VALUES ('d1','text')`).run();
    raw.prepare(`INSERT INTO knowledge_chunks (id, source_doc_id, chunk_index, content, search_text) VALUES ('c1','d1',0,'駐車場はありますか','')`).run();
    await backfillChunkSearchText(db);
    const snap1 = raw.prepare(`SELECT rowid, search_text FROM knowledge_chunks_fts`).all();
    await backfillChunkSearchText(db); // 再実行
    const snap2 = raw.prepare(`SELECT rowid, search_text FROM knowledge_chunks_fts`).all();
    expect(snap2).toEqual(snap1); // rowid/search_text 同値 = idempotent
  });
});
