/**
 * T-D2 (Phase B B-4) — embed() + Vectorize ラッパ + マージ検索 (retrieveChunkEvidence)。
 *  - WorkersAiProvider.embed が ai.run(embedModel,{text})→data[0] を返し、未設定は LlmConfigError。
 *  - cosine/normalizeCosine が既知ベクトルで正しい・Cloudflare cosine [-1,1] を [0,1] 写像。
 *  - upsert/query の metadata account sentinel + filter・delete/getByIds ラッパ。
 *  - retrieveChunkEvidence: cosine >= floor のみ採用 (bm25 単独/欠損ベクトルは不採用)・他 account を D1 で弾く・
 *    dedup・Vectorize 未 binding で [] (faqs-only degrade)・embedNeurons を戻す。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { WorkersAiProvider, type WorkersAiBinding, type WorkersAiRunResult } from './llm/workers-ai.js';
import { LlmConfigError } from './llm/llm-provider.js';
import {
  cosine,
  normalizeCosine,
  computeEmbedNeurons,
  retrieveChunkEvidence,
  buildChunkSearchText,
  type ChunkEvidenceConfig,
} from './knowledge.js';
import {
  upsertChunkVectors,
  queryChunkVectors,
  deleteChunkVectors,
  getVectorsByIds,
  chunkAccountMetadata,
  CHUNK_GLOBAL_SENTINEL,
  type VectorizeIndex,
  type VectorizeQueryOptions,
} from './vectorize.js';

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

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const s = db.prepare(sql);
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

// ── mock Vectorize (in-memory store) ────────────────────────────────────────
interface StoredVec { values: number[]; metadata: Record<string, unknown> }
function matchesFilter(meta: Record<string, unknown>, filter: Record<string, unknown> | undefined): boolean {
  if (!filter) return true;
  for (const [k, cond] of Object.entries(filter)) {
    const val = meta[k];
    if (cond && typeof cond === 'object' && '$in' in (cond as object)) {
      if (!(cond as { $in: unknown[] }).$in.includes(val)) return false;
    } else if (val !== cond) return false;
  }
  return true;
}
function mockVectorize(
  seed: Array<{ id: string; values: number[]; accountId: string | null }> = [],
  opts: { queryReturns?: string[]; ignoreFilter?: boolean; captureQuery?: (o?: VectorizeQueryOptions) => void } = {},
): VectorizeIndex {
  const store = new Map<string, StoredVec>();
  for (const s of seed) store.set(s.id, { values: s.values, metadata: { line_account_id: chunkAccountMetadata(s.accountId) } });
  return {
    async upsert(vectors) { for (const v of vectors) store.set(v.id, { values: v.values, metadata: v.metadata ?? {} }); return {}; },
    async query(_vec, options) {
      opts.captureQuery?.(options);
      const candidateIds = opts.queryReturns ?? [...store.keys()];
      const matches = candidateIds
        .filter((id) => store.has(id))
        .filter((id) => opts.ignoreFilter || matchesFilter(store.get(id)!.metadata, options?.filter))
        .slice(0, options?.topK ?? candidateIds.length)
        .map((id) => ({ id, score: 0.9 }));
      return { matches };
    },
    async deleteByIds(ids) { for (const id of ids) store.delete(id); return {}; },
    async getByIds(ids) { return ids.filter((id) => store.has(id)).map((id) => ({ id, values: store.get(id)!.values, metadata: store.get(id)!.metadata })); },
  };
}

function mockAi(vector: number[] | undefined): WorkersAiBinding {
  return { async run(): Promise<WorkersAiRunResult> { return { data: vector ? [vector] : undefined }; } };
}

function baseCfg(vectorize: VectorizeIndex | null, embedVec: number[], over: Partial<ChunkEvidenceConfig> = {}): ChunkEvidenceConfig {
  return {
    provider: { async embed() { return embedVec; } },
    vectorize,
    embedModelId: '@cf/qwen/qwen3-embedding-0.6b',
    chunkRelevanceFloor: 0.6,
    embedNeuronPerMTok: 100_000,
    ...over,
  };
}

describe('WorkersAiProvider.embed (T-D2)', () => {
  test('ai.run(embedModel,{text}) の data[0] を返す', async () => {
    const p = new WorkersAiProvider(mockAi([0.1, 0.2, 0.3]), 'gen-model', '@cf/qwen/qwen3-embedding-0.6b');
    expect(await p.embed('質問')).toEqual([0.1, 0.2, 0.3]);
  });
  test('embedModelId 未設定 → LlmConfigError (fail-safe)', async () => {
    const p = new WorkersAiProvider(mockAi([0.1]), 'gen-model', undefined);
    await expect(p.embed('質問')).rejects.toBeInstanceOf(LlmConfigError);
  });
  test('data 欠損 → LlmConfigError', async () => {
    const p = new WorkersAiProvider(mockAi(undefined), 'gen-model', 'embed-model');
    await expect(p.embed('質問')).rejects.toBeInstanceOf(LlmConfigError);
  });
});

describe('cosine / normalizeCosine / computeEmbedNeurons (T-D2)', () => {
  test('同一ベクトル cosine=1 → 正規化 1', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(normalizeCosine(cosine([1, 2, 3], [1, 2, 3]))).toBeCloseTo(1);
  });
  test('直交 cosine=0 → 正規化 0.5 / 逆向き -1 → 正規化 0', () => {
    expect(normalizeCosine(cosine([1, 0], [0, 1]))).toBeCloseTo(0.5);
    expect(normalizeCosine(cosine([1, 0], [-1, 0]))).toBeCloseTo(0);
  });
  test('零長/長さ不一致 → 0', () => {
    expect(cosine([], [])).toBe(0);
    expect(cosine([1, 2], [1])).toBe(0);
  });
  test('computeEmbedNeurons は text 長 × 係数で正 (fail-safe 高め)', () => {
    expect(computeEmbedNeurons('営業時間を教えて', 100_000)).toBeGreaterThan(0);
  });
});

describe('Vectorize ラッパ (T-D2/T-D7)', () => {
  test('upsertChunkVectors: metadata に account/global sentinel + source_doc_id (null 不可回避)', async () => {
    const idx = mockVectorize();
    await upsertChunkVectors(idx, [
      { id: 'c1', values: [1, 0], accountId: 'acc-1', sourceDocId: 'd1' },
      { id: 'c2', values: [0, 1], accountId: null, sourceDocId: 'd1' },
    ]);
    const stored = await getVectorsByIds(idx, ['c1', 'c2']);
    expect(stored.find((v) => v.id === 'c1')?.metadata).toMatchObject({ line_account_id: 'acc-1', source_doc_id: 'd1' });
    expect(stored.find((v) => v.id === 'c2')?.metadata).toMatchObject({ line_account_id: CHUNK_GLOBAL_SENTINEL });
  });
  test('queryChunkVectors: account 指定は $in[account,__global__]、global は __global__ のみ', async () => {
    let captured: VectorizeQueryOptions | undefined;
    const idx = mockVectorize([], { captureQuery: (o) => { captured = o; } });
    await queryChunkVectors(idx, [1, 0], { topK: 5, accountId: 'acc-1' });
    expect(captured?.filter).toEqual({ line_account_id: { $in: ['acc-1', CHUNK_GLOBAL_SENTINEL] } });
    await queryChunkVectors(idx, [1, 0], { topK: 5, accountId: null });
    expect(captured?.filter).toEqual({ line_account_id: CHUNK_GLOBAL_SENTINEL });
  });
  test('deleteChunkVectors が id を削除', async () => {
    const idx = mockVectorize([{ id: 'c1', values: [1, 0], accountId: 'acc-1' }]);
    await deleteChunkVectors(idx, ['c1']);
    expect(await getVectorsByIds(idx, ['c1'])).toHaveLength(0);
  });
});

describe('retrieveChunkEvidence — cosine 統一 floor + account 二重確認 (T-D2/T-D3/T-D7)', () => {
  let raw: Database.Database;
  let db: D1Database;
  beforeEach(() => {
    raw = new Database(':memory:');
    replayAll(raw);
    db = d1(raw);
  });

  function insertChunk(id: string, accountId: string | null, content: string) {
    raw.prepare(`INSERT INTO knowledge_documents (id, source_type) VALUES (?, 'text')`).run(`doc-${id}`);
    raw.prepare(`INSERT INTO knowledge_chunks (id, source_doc_id, line_account_id, chunk_index, content, search_text) VALUES (?,?,?,?,?,?)`)
      .run(id, `doc-${id}`, accountId, 0, content, buildChunkSearchText(content));
  }

  test('Vectorize 未 binding → [] (faqs-only degrade)・embedNeurons 0', async () => {
    const res = await retrieveChunkEvidence(db, baseCfg(null, [1, 0]), '営業時間', 'acc-1');
    expect(res.chunks).toEqual([]);
    expect(res.embedNeurons).toBe(0);
  });

  test('cosine >= floor の chunk のみ採用 (低 cosine=高 bm25 の FTS 候補を弾く / bm25 単独採用禁止)', async () => {
    insertChunk('A', 'acc-1', '営業時間は平日10時から19時までです');
    insertChunk('C', 'acc-1', '営業時間の一般的な話題について長々と述べます'); // FTS で当たるが cosine 低
    const idx = mockVectorize([
      { id: 'A', values: [1, 0], accountId: 'acc-1' }, // qvec=[1,0] と cosine=1 → sim01=1
      { id: 'C', values: [0, 1], accountId: 'acc-1' }, // cosine=0 → sim01=0.5 < 0.6
    ], { queryReturns: ['A'] }); // C は Vectorize 未 hit・FTS のみで recall
    const res = await retrieveChunkEvidence(db, baseCfg(idx, [1, 0]), '営業時間', 'acc-1');
    expect(res.chunks.map((c) => c.chunk.id)).toEqual(['A']); // C は cosine floor 未満で不採用
    expect(res.chunks[0].cosine).toBeCloseTo(1);
    expect(res.embedNeurons).toBeGreaterThan(0);
  });

  test('他 account の chunk は D1 account 条件で弾く (getByIds が返しても不採用 / cross-account 0)', async () => {
    insertChunk('A', 'acc-1', '営業時間は10時から19時');
    insertChunk('D', 'acc-2', '別アカウントの秘密の営業時間');
    const idx = mockVectorize([
      { id: 'A', values: [1, 0], accountId: 'acc-1' },
      { id: 'D', values: [1, 0], accountId: 'acc-2' }, // cosine 1 でも acc-1 の検索では返してはならない
    ], { queryReturns: ['A', 'D'], ignoreFilter: true }); // filter を無視させ D1 backstop を単独検証
    const res = await retrieveChunkEvidence(db, baseCfg(idx, [1, 0]), '営業時間', 'acc-1');
    expect(res.chunks.map((c) => c.chunk.id)).toEqual(['A']); // D(acc-2) は D1 SQL で fetch されない
  });

  test('query と FTS が同 id を返しても dedup (1 回だけ)', async () => {
    insertChunk('A', 'acc-1', '営業時間は10時から19時までです');
    const idx = mockVectorize([{ id: 'A', values: [1, 0], accountId: 'acc-1' }], { queryReturns: ['A'] });
    const res = await retrieveChunkEvidence(db, baseCfg(idx, [1, 0]), '営業時間', 'acc-1');
    expect(res.chunks.map((c) => c.chunk.id)).toEqual(['A']);
  });

  test('欠損ベクトル (getByIds が values を返さない) は不採用 (default-deny)', async () => {
    insertChunk('A', 'acc-1', '営業時間は10時から19時までです');
    const idx: VectorizeIndex = {
      async upsert() { return {}; },
      async query() { return { matches: [{ id: 'A', score: 0.9 }] }; },
      async deleteByIds() { return {}; },
      async getByIds() { return [{ id: 'A' }]; }, // values 欠損
    };
    const res = await retrieveChunkEvidence(db, baseCfg(idx, [1, 0]), '営業時間', 'acc-1');
    expect(res.chunks).toEqual([]);
    expect(res.embedNeurons).toBeGreaterThan(0); // embed 済は計上対象
  });
});
