import type { KnowledgeChunk } from '@line-crm/db';
import { normalize, ngrams } from './faq-match.js';
import { buildQuerySearchText } from './faq-fts.js';

/**
 * Phase B B-3 — 取込ナレッジの worker 層 (計算/検索)。
 *
 * search_text の計算 (normalize→2-gram→空白連結) は faqs (B-2) と同方式で faq-match の normalize/ngrams を
 * import 再利用 (自前再実装禁止・Dice/検索 drift 防止 / D-1)。検索クエリ側は faq-fts の buildQuerySearchText を
 * 再利用 (query drift 防止 / Codex #16)。search_text 計算は worker 層のみ (packages/db は apps/worker を
 * import しない = 依存方向)。**本 batch は chunks を live RAG 経路に結線しない** (基盤・B-4 で結線 / §7)。
 */

// splitIntoChunks の境界パラメータ (決定的な純関数 / §5-4)。
const CHUNK_TARGET = 400;
const CHUNK_MAX = 1000;
const CHUNK_MIN = 20;
const CHUNK_CAP = 200;

/** チャンク本文の索引テキスト = normalize→2-gram→空白連結 (buildQuerySearchText と同一式・drift 防止)。 */
export function buildChunkSearchText(content: string): string {
  return [...ngrams(normalize(content), 2)].join(' ');
}

/** MAX 超の段落を文境界 (。．！？.!? / 改行) で分割し、それでも超える片は文字数で hard-split。 */
function hardSplit(paragraph: string): string[] {
  const parts = paragraph.split(/(?<=[。．！？!?\n])/);
  const out: string[] = [];
  let cur = '';
  const flushOversize = () => {
    while (cur.length > CHUNK_MAX) {
      out.push(cur.slice(0, CHUNK_MAX));
      cur = cur.slice(CHUNK_MAX);
    }
  };
  for (const s of parts) {
    if (cur === '') cur = s;
    else if (cur.length + s.length > CHUNK_MAX) {
      out.push(cur);
      cur = s;
    } else cur += s;
    flushOversize();
  }
  if (cur) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * 段落 (空行) 境界で分割し ~400 字目標に greedy pack (最大 ~1000・最小 ~20 は捨てる・1 資料上限 200)。
 * 決定的な純関数。極小片のみの短文書は 1 チャンクとして保持 (全捨て防止)。
 */
export function splitIntoChunks(text: string): string[] {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const units: string[] = [];
  for (const p of paras) {
    if (p.length <= CHUNK_MAX) units.push(p);
    else units.push(...hardSplit(p));
  }
  const chunks: string[] = [];
  let cur = '';
  for (const u of units) {
    if (cur === '') cur = u;
    else if (cur.length >= CHUNK_TARGET || cur.length + 1 + u.length > CHUNK_MAX) {
      chunks.push(cur);
      cur = u;
    } else cur += `\n${u}`;
  }
  if (cur) chunks.push(cur);
  let result = chunks.filter((c) => c.trim().length >= CHUNK_MIN);
  // 極小片しか残らなかった短文書は最長片を 1 つ残す (取込内容を全捨てしない)。
  if (result.length === 0 && chunks.length > 0) {
    result = [chunks.reduce((a, b) => (a.length >= b.length ? a : b))];
  }
  return result.slice(0, CHUNK_CAP);
}

export interface ChunkCandidate {
  chunk: KnowledgeChunk;
  bm25: number;
}

/**
 * FTS5 recall (account スコープ・top-K・**bm25 返却**)。B-4 のマージ検索用**基盤** (bm25/Dice/similarity を
 * 比較・正規化してマージ)。MATCH は bigram を OR 連結 (faq-fts.retrieveFaqCandidates と同一手順・query drift
 * 防止 / Codex #16)。account スコープ式は faqs 検索 (faqs.ts:40) と同一 (M-account-scope)。
 * **本 batch は live RAG (faq-reply.ts:132) に結線しない** (§7)。空 bigram (極短文) は [] 返し。
 */
export async function retrieveChunkCandidates(
  db: D1Database,
  question: string,
  lineAccountId: string | null,
  limit = 5,
): Promise<ChunkCandidate[]> {
  const bigrams = buildQuerySearchText(question).split(' ').filter(Boolean);
  if (bigrams.length === 0) return [];
  const match = bigrams.map((b) => `"${b}"`).join(' OR ');
  const result = await db
    .prepare(
      `SELECT c.*, bm25(knowledge_chunks_fts) AS bm25 FROM knowledge_chunks_fts fts
         JOIN knowledge_chunks c ON c.rowid = fts.rowid
        WHERE knowledge_chunks_fts MATCH ?
          AND (c.line_account_id IS NULL OR c.line_account_id = ?)
        ORDER BY bm25(knowledge_chunks_fts)
        LIMIT ?`,
    )
    .bind(match, lineAccountId, limit)
    .all<KnowledgeChunk & { bm25: number }>();
  return result.results.map((r) => {
    const { bm25, ...chunk } = r;
    return { chunk: chunk as KnowledgeChunk, bm25 };
  });
}

/**
 * 既存 knowledge_chunks 全行の search_text を JS (buildChunkSearchText) で計算して埋める backfill。
 * migration 092 直後 (既存行 search_text='') / 再構築時のワンショット。AU トリガ経由で FTS を構築。
 * 再実行は同値を書くだけ = idempotent (backfillFaqsSearchText / faq-fts.ts:75 同型)。返り値 = 更新行数。
 */
export async function backfillChunkSearchText(db: D1Database): Promise<number> {
  const result = await db.prepare(`SELECT id, content FROM knowledge_chunks`).all<{ id: string; content: string }>();
  let updated = 0;
  for (const row of result.results) {
    const searchText = buildChunkSearchText(row.content);
    await db.prepare(`UPDATE knowledge_chunks SET search_text = ? WHERE id = ?`).bind(searchText, row.id).run();
    updated += 1;
  }
  return updated;
}
