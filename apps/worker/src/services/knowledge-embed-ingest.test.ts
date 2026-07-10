/**
 * T-D5 (Phase B B-4) — 取込時 embed の予算合算ガード (embedChunksForDocument)。
 *  - 予算内: 全 chunk を embed → Vectorize upsert (account/__global__ metadata) → embedded_at set → embed_neurons 計上。
 *  - 予測 delta 事前予約: batch 前に残枠を確認し超過 batch 以降を defer (embedded_at=null・FTS で機能)。
 *  - 冪等: 既 embed (embedded_at != null) は skip。
 *  - per-chunk embed 失敗はその chunk のみ skip (他は embed)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { embedChunksForDocument, type EmbedIngestConfig } from './knowledge.js';
import { chunkAccountMetadata, type VectorizeIndex, type VectorizeVectorInput } from './vectorize.js';
import { createKnowledgeDocument, insertKnowledgeChunks, getChunksBySourceDoc, utcDay } from '@line-crm/db';

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

function capturingVectorize(upserts: VectorizeVectorInput[], opts: { failContent?: string } = {}): VectorizeIndex {
  return {
    async upsert(vectors) { upserts.push(...vectors); return {}; },
    async query() { return { matches: [] }; },
    async deleteByIds() { return {}; },
    async getByIds() { return []; },
  };
  void opts;
}

/** provider.embed: content が failContent なら throw、それ以外は固定ベクトルを返す。 */
function embedProvider(failContent?: string) {
  return { async embed(text: string) { if (failContent && text.includes(failContent)) throw new Error('embed fail'); return [1, 0, 0]; } };
}

const DAY = utcDay();
let raw: Database.Database;
let db: D1Database;
beforeEach(() => { raw = new Database(':memory:'); replayAll(raw); db = d1(raw); });

async function seedDoc(account: string | null, contents: string[]): Promise<string> {
  const doc = await createKnowledgeDocument(db, { lineAccountId: account, sourceType: 'text' });
  await insertKnowledgeChunks(db, doc.id, account, contents.map((content, i) => ({ chunkIndex: i, content, searchText: `t${i}` })));
  return doc.id;
}
function embedNeurons(account: string): number {
  const r = raw.prepare(`SELECT embed_neurons FROM ai_usage_budget WHERE line_account_id=? AND usage_date=?`).get(account, DAY) as { embed_neurons: number } | undefined;
  return r?.embed_neurons ?? 0;
}
function seedUsage(account: string, neurons: number) {
  raw.prepare(`INSERT INTO ai_usage_budget (id, line_account_id, usage_date, llm_neurons) VALUES (?,?,?,?)`).run(`u-${account}`, account, DAY, neurons);
}
function cfg(vectorize: VectorizeIndex, over: Partial<EmbedIngestConfig> = {}): EmbedIngestConfig {
  return { provider: embedProvider(), vectorize, embedModelId: '@cf/qwen/qwen3-embedding-0.6b', embedNeuronPerMTok: 100_000, globalBudget: 9000, perAccountBudget: 9000, ...over };
}

describe('embedChunksForDocument — 予算合算 + 冪等 (T-D5/T-D7)', () => {
  test('予算内: 全 chunk を embed → upsert(account metadata) → embedded_at set → embed_neurons 計上', async () => {
    const docId = await seedDoc('acc-1', ['本文その一', '本文その二', '本文その三']);
    const upserts: VectorizeVectorInput[] = [];
    const res = await embedChunksForDocument(db, cfg(capturingVectorize(upserts)), docId, 'acc-1');
    expect(res.embedded).toBe(3);
    expect(res.skipped).toBe(0);
    expect(res.embedNeurons).toBeGreaterThan(0);
    expect(embedNeurons('acc-1')).toBe(res.embedNeurons);
    // 全 chunk が embedded_at セット済。
    const chunks = await getChunksBySourceDoc(db, docId);
    expect(chunks.every((c) => c.embedded_at != null && c.embed_model === '@cf/qwen/qwen3-embedding-0.6b')).toBe(true);
    // upsert metadata に account (null 不可回避)。
    expect(upserts).toHaveLength(3);
    expect(upserts[0].metadata?.line_account_id).toBe('acc-1');
  });

  test('global(null) chunk は metadata line_account_id = __global__ sentinel', async () => {
    const docId = await seedDoc(null, ['グローバル本文']);
    const upserts: VectorizeVectorInput[] = [];
    await embedChunksForDocument(db, cfg(capturingVectorize(upserts)), docId, null);
    expect(upserts[0].metadata?.line_account_id).toBe(chunkAccountMetadata(null));
  });

  test('予測 delta 事前予約: 残枠を超える batch 以降を defer (embedded_at=null・過消費ゼロ)', async () => {
    // content 200字 → inTok 100 → 100 * 100000/1e6 = 10 neuron/chunk。batchSize=2 → 20/batch。
    const content = 'あ'.repeat(200);
    const docId = await seedDoc('acc-1', [content, content, content, content]); // 4 chunk = 2 batch
    seedUsage('acc-1', 0);
    const upserts: VectorizeVectorInput[] = [];
    // budget=25: 1 batch 目 (20) は通る・2 batch 目 (20+20=40>25) は defer。
    const res = await embedChunksForDocument(db, cfg(capturingVectorize(upserts), { batchSize: 2, globalBudget: 25, perAccountBudget: 25 }), docId, 'acc-1');
    expect(res.embedded).toBe(2);
    expect(res.skipped).toBe(2);
    const chunks = await getChunksBySourceDoc(db, docId);
    expect(chunks.filter((c) => c.embedded_at != null)).toHaveLength(2); // 2 件のみ embed
    expect(chunks.filter((c) => c.embedded_at == null)).toHaveLength(2); // 残り 2 件は FTS のみ (backfill 対象)
    expect(upserts).toHaveLength(2);
  });

  test('冪等: 既 embed 済 (embedded_at != null) の chunk は再 embed しない', async () => {
    const docId = await seedDoc('acc-1', ['本文A', '本文B']);
    const upserts: VectorizeVectorInput[] = [];
    await embedChunksForDocument(db, cfg(capturingVectorize(upserts)), docId, 'acc-1'); // 1 回目 = 2 embed
    const again = await embedChunksForDocument(db, cfg(capturingVectorize(upserts)), docId, 'acc-1'); // 2 回目 = 全 skip
    expect(again.embedded).toBe(0);
    expect(again.skipped).toBe(0);
    expect(upserts).toHaveLength(2); // 追加 upsert なし
  });

  test('per-chunk embed 失敗はその chunk のみ skip (他は embed)', async () => {
    const docId = await seedDoc('acc-1', ['正常本文1', 'BADCHUNK 壊れた本文', '正常本文2']);
    const upserts: VectorizeVectorInput[] = [];
    const res = await embedChunksForDocument(db, cfg(capturingVectorize(upserts), { provider: embedProvider('BADCHUNK') }), docId, 'acc-1');
    expect(res.embedded).toBe(2); // BADCHUNK 以外
    const chunks = await getChunksBySourceDoc(db, docId);
    const bad = chunks.find((c) => c.content.includes('BADCHUNK'));
    expect(bad?.embedded_at).toBeNull(); // 失敗 chunk は未 embed のまま (backfill 対象)
  });

  test('Vectorize 未 binding 相当: chunk 0 (pending なし) は embed_neurons 0', async () => {
    const docId = await seedDoc('acc-1', []);
    const res = await embedChunksForDocument(db, cfg(capturingVectorize([])), docId, 'acc-1');
    expect(res).toEqual({ embedded: 0, skipped: 0, embedNeurons: 0 });
  });
});
