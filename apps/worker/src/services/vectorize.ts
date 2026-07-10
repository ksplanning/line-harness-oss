/**
 * Phase B B-4 (T-D2) — Cloudflare Vectorize の薄い mock 可能ラッパ。
 *
 * @cloudflare/workers-types の VectorizeIndex に依存せず、B-4 が使う 4 verb (upsert/query/deleteByIds/
 * getByIds) だけを structural に定義する (workers-ai.ts の WorkersAiBinding と同思想 = vitest で mock 可能)。
 * 実 binding (`[[vectorize]] binding = "VECTORIZE"`) と index/metadata-index 作成は infra 工程 (owner_role:
 * infra-ops)。本 module は型明示 + account スコープ (metadata filter) のロジックまで。
 *
 * account 分離 (地雷 B4-5 / T-D7):
 *  - Vectorize metadata に null を格納できないため、global(null) chunk は line_account_id = '__global__' sentinel。
 *  - query は metadata filter で {account, '__global__'} に絞る。D1 側の SQL account 条件と二重で cross-account 0。
 */

export const CHUNK_GLOBAL_SENTINEL = '__global__';

/** upsert 入力の 1 vector (id = chunk.id を採用 = マッピング表不要・content は D1 が真実源で載せない)。 */
export interface VectorizeVectorInput {
  id: string;
  values: number[];
  metadata?: Record<string, string | number | boolean>;
}

/** query の 1 match (score は近似・採否には使わず recall のみ / cosine は getByIds で厳密確定 / Codex high)。 */
export interface VectorizeQueryMatch {
  id: string;
  score: number;
  values?: number[];
  metadata?: Record<string, unknown>;
}

/** getByIds の戻り (values = 厳密なストア済ベクトル・cosine 統一計算の入力)。 */
export interface VectorizeStoredVector {
  id: string;
  values?: number[];
  metadata?: Record<string, unknown>;
}

export interface VectorizeQueryOptions {
  topK?: number;
  returnValues?: boolean;
  returnMetadata?: boolean | 'all' | 'none' | 'indexed';
  filter?: Record<string, unknown>;
}

/** B-4 が使う VectorizeIndex の最小 structural 型 (mock 可能)。 */
export interface VectorizeIndex {
  upsert(vectors: VectorizeVectorInput[]): Promise<unknown>;
  query(vector: number[], options?: VectorizeQueryOptions): Promise<{ matches: VectorizeQueryMatch[] }>;
  deleteByIds(ids: string[]): Promise<unknown>;
  getByIds(ids: string[]): Promise<VectorizeStoredVector[]>;
}

/** null(global) を Vectorize metadata の '__global__' sentinel へ写像 (格納可能値に正規化 / 地雷 B4-5)。 */
export function chunkAccountMetadata(accountId: string | null): string {
  return accountId ?? CHUNK_GLOBAL_SENTINEL;
}

export interface UpsertChunkVectorItem {
  id: string;
  values: number[];
  accountId: string | null;
  sourceDocId: string;
}

/**
 * chunk ベクトルを冪等 upsert (同 id 再 upsert = 上書き)。metadata に line_account_id(sentinel)/source_doc_id
 * のみ (PII/秘密値なし / D-3)。空配列は no-op。
 */
export async function upsertChunkVectors(idx: VectorizeIndex, items: UpsertChunkVectorItem[]): Promise<void> {
  if (items.length === 0) return;
  await idx.upsert(
    items.map((it) => ({
      id: it.id,
      values: it.values,
      metadata: { line_account_id: chunkAccountMetadata(it.accountId), source_doc_id: it.sourceDocId },
    })),
  );
}

/**
 * account スコープ付き semantic recall。account 指定時は {account, '__global__'}、global 問い合わせ時は
 * '__global__' のみに metadata filter で絞る (他 account の vector を最初から返さない / T-D7)。
 */
export async function queryChunkVectors(
  idx: VectorizeIndex,
  vector: number[],
  opts: { topK: number; accountId: string | null },
): Promise<VectorizeQueryMatch[]> {
  const scope = chunkAccountMetadata(opts.accountId);
  const filter =
    scope === CHUNK_GLOBAL_SENTINEL
      ? { line_account_id: CHUNK_GLOBAL_SENTINEL }
      : { line_account_id: { $in: [scope, CHUNK_GLOBAL_SENTINEL] } };
  const res = await idx.query(vector, { topK: opts.topK, returnMetadata: 'indexed', filter });
  return res.matches ?? [];
}

/** chunk ベクトルを id で削除 (資料削除時の cleanup / T-D7)。空配列は no-op。 */
export async function deleteChunkVectors(idx: VectorizeIndex, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await idx.deleteByIds(ids);
}

/** id 群のストア済ベクトルを取得 (cosine 統一計算の入力 / Codex high)。空配列は no-op。 */
export async function getVectorsByIds(idx: VectorizeIndex, ids: string[]): Promise<VectorizeStoredVector[]> {
  if (ids.length === 0) return [];
  return idx.getByIds(ids);
}
