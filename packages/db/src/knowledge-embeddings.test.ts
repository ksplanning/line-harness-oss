/**
 * T-D6 (Phase B B-4) — migration 093 (chunk embed 状態追跡) + db helper (markChunksEmbedded /
 * getUnembeddedChunks / getChunksBySourceDoc)。
 *  - 093 は ALTER ADD COLUMN embedded_at/embed_model の 2 列のみ (additive・DROP/RENAME/_new なし)。
 *  - 実 093 .sql を「pre-093 の knowledge_chunks (行入り)」に適用し、既存行が無改変で 2 列が NULL default。
 *  - check-migrations pass (POLICY_CUTOFF=041 additive)・093 が台帳最大 092 超の最小未使用。
 *  - markChunksEmbedded が upsert 確認後に embedded_at/embed_model をセット (冪等 backfill の基盤)。
 *  - getUnembeddedChunks が embedded_at IS NULL の chunk のみ account スコープで返す。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import {
  createKnowledgeDocument,
  insertKnowledgeChunks,
  markChunksEmbedded,
  getUnembeddedChunks,
  getChunksBySourceDoc,
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

// D1 互換 mock (batch 対応 / knowledge.test.ts と同型)。
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

const MIG_093 = '093_phase_b_chunk_embeddings.sql';

describe('migration 093 — additive ALTER (T-D6)', () => {
  const sql093 = readFileSync(join(MIGRATIONS_DIR, MIG_093), 'utf8');

  test('ALTER ADD COLUMN embedded_at + embed_model の 2 列のみ (DROP/RENAME/_new なし)', () => {
    // -- 行コメントを除去してから DDL を評価 (comment の説明文が regex を汚さない / check-migrations 同法)。
    const code = sql093.split('\n').map((l) => { const i = l.indexOf('--'); return i === -1 ? l : l.slice(0, i); }).join('\n');
    const alters = splitStatements(code).filter((s) => /^ALTER TABLE/i.test(s));
    expect(alters).toHaveLength(2);
    expect(code).toMatch(/ADD COLUMN embedded_at TEXT/);
    expect(code).toMatch(/ADD COLUMN embed_model TEXT/);
    // 破壊的構文が無い (additive-only)。
    expect(code).not.toMatch(/\bDROP\b|\bRENAME\b|_new\b/i);
  });

  test('additive-only policy pass (check-migrations RULES と同法・exception 追記不要)', () => {
    // scripts/check-migrations.ts の禁止パターン (comment 除去後に評価)。cross-package import は
    // db package の tsc rootDir 外になるため、同一ルールを test 内に写して additive を assert。
    const code = sql093.split('\n').map((l) => { const i = l.indexOf('--'); return i === -1 ? l : l.slice(0, i); }).join('\n');
    const forbidden: RegExp[] = [
      /\bDROP\s+TABLE\b/i,
      /\bDROP\s+COLUMN\b/i,
      /\bRENAME\s+COLUMN\b/i,
      /\bALTER\s+COLUMN\s+\S+\s+TYPE\b/i,
      /\bALTER\s+TABLE\s+\S+\s+RENAME\s+TO\b/i,
      /\bADD\s+COLUMN\s+\S+[^,;]*?\bNOT\s+NULL\b(?![^,;]*\bDEFAULT\b)/i,
      /\bADD\s+UNIQUE\b/i,
      /\bADD\s+CONSTRAINT\s+\S+\s+UNIQUE\b/i,
    ];
    for (const re of forbidden) expect(code).not.toMatch(re);
  });

  test('093 が 092 の直後に単一で存在する (Phase B chunk_embeddings の順序不変)', () => {
    const nums = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d+_/.test(f))
      .map((f) => Number(f.slice(0, f.indexOf('_'))));
    // Phase B は 092→093 が正順で単一であること (093 の位置不変) を保証する。
    // 094 以降は後続バッチ (F6-1 = formaloo_workspaces) が最小未使用を順次 claim する。
    expect(nums).toContain(93);
    expect(nums.filter((n) => n === 93)).toHaveLength(1);
    expect(nums.filter((n) => n === 92)).toHaveLength(1);
    expect(nums.filter((n) => n < 93).every((n) => n <= 92)).toBe(true);
  });

  test('実 093 を pre-093 の行入り knowledge_chunks に適用 → 既存行が無改変・2 列 NULL default', () => {
    const raw = new Database(':memory:');
    // pre-093 の knowledge_chunks (embedded_at/embed_model 無し) を最小構築し行を入れる。
    raw.exec(`CREATE TABLE knowledge_chunks (
      id TEXT PRIMARY KEY, source_doc_id TEXT NOT NULL, line_account_id TEXT,
      chunk_index INTEGER NOT NULL, content TEXT NOT NULL, search_text TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000')`);
    raw.prepare(`INSERT INTO knowledge_chunks (id, source_doc_id, line_account_id, chunk_index, content, search_text, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run('ch-1', 'doc-1', 'acc-1', 0, '既存本文', 'きそ', '2026-06-30T12:00:00.000');
    // 実 093 の ALTER を適用。
    for (const s of splitStatements(sql093)) raw.exec(s);
    const row = raw.prepare(`SELECT * FROM knowledge_chunks WHERE id='ch-1'`).get() as Record<string, unknown>;
    expect(row.content).toBe('既存本文');           // 既存列は無改変
    expect(row.created_at).toBe('2026-06-30T12:00:00.000');
    expect(row.embedded_at).toBeNull();             // 新列は NULL default
    expect(row.embed_model).toBeNull();
    raw.close();
  });
});

describe('markChunksEmbedded / getUnembeddedChunks / getChunksBySourceDoc (T-D6)', () => {
  let raw: Database.Database;
  let db: D1Database;
  beforeEach(() => {
    raw = new Database(':memory:');
    replayAll(raw);
    db = d1(raw);
  });

  async function seedDoc(accountId: string | null, n: number): Promise<{ docId: string; ids: string[] }> {
    const doc = await createKnowledgeDocument(db, { lineAccountId: accountId, sourceType: 'text' });
    await insertKnowledgeChunks(
      db,
      doc.id,
      accountId,
      Array.from({ length: n }, (_, i) => ({ chunkIndex: i, content: `本文${i}`, searchText: `t${i}` })),
    );
    const chunks = await getChunksBySourceDoc(db, doc.id);
    return { docId: doc.id, ids: chunks.map((c) => c.id) };
  }

  test('getChunksBySourceDoc が doc の全 chunk を chunk_index 順で返す (embedded_at/embed_model 列を含む)', async () => {
    const { docId, ids } = await seedDoc('acc-1', 3);
    const chunks = await getChunksBySourceDoc(db, docId);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.chunk_index)).toEqual([0, 1, 2]);
    expect(chunks[0].embedded_at).toBeNull();
    expect(chunks[0].embed_model).toBeNull();
    expect(ids).toHaveLength(3);
  });

  test('markChunksEmbedded が指定 id の embedded_at/embed_model をセットし他行に触れない', async () => {
    const { ids } = await seedDoc('acc-1', 3);
    await markChunksEmbedded(db, [ids[0], ids[2]], '@cf/qwen/qwen3-embedding-0.6b');
    const row = (id: string) => raw.prepare(`SELECT embedded_at, embed_model FROM knowledge_chunks WHERE id=?`).get(id) as { embedded_at: string | null; embed_model: string | null };
    expect(row(ids[0]).embedded_at).not.toBeNull();
    expect(row(ids[0]).embed_model).toBe('@cf/qwen/qwen3-embedding-0.6b');
    expect(row(ids[2]).embedded_at).not.toBeNull();
    expect(row(ids[1]).embedded_at).toBeNull(); // 対象外は未 embed のまま
  });

  test('markChunksEmbedded は空配列で no-op', async () => {
    const { ids } = await seedDoc(null, 1);
    await markChunksEmbedded(db, [], 'm');
    expect((raw.prepare(`SELECT embedded_at FROM knowledge_chunks WHERE id=?`).get(ids[0]) as { embedded_at: string | null }).embedded_at).toBeNull();
  });

  test('getUnembeddedChunks が embedded_at IS NULL の chunk のみ account スコープで返す', async () => {
    const a = await seedDoc('acc-1', 2);
    const g = await seedDoc(null, 1); // global
    await seedDoc('acc-2', 2);        // 別 account (返らない)
    await markChunksEmbedded(db, [a.ids[0]], 'm'); // 1 件 embed 済 → 未 embed に残るのは a.ids[1] + global
    const unembedded = await getUnembeddedChunks(db, 'acc-1');
    const gotIds = unembedded.map((c) => c.id).sort();
    expect(gotIds).toEqual([a.ids[1], g.ids[0]].sort());
    // acc-2 の chunk は含まれない (cross-account 漏洩なし)。
    expect(unembedded.every((c) => c.line_account_id === 'acc-1' || c.line_account_id === null)).toBe(true);
  });

  test('getUnembeddedChunks は limit を尊重する', async () => {
    await seedDoc('acc-1', 5);
    const unembedded = await getUnembeddedChunks(db, 'acc-1', 2);
    expect(unembedded).toHaveLength(2);
  });
});
