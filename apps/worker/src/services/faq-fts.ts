import { type Faq } from '@line-crm/db';
import { normalize, ngrams, scoreFaq, type FaqMatch, type FaqMatchDetail, type MatchableFaq } from './faq-match.js';

/**
 * Phase B B-2 — FAQ 全文検索 (D1 FTS5) の worker 層。
 *
 * FTS5 のカスタムトークナイザに JS normalize は注入できない (親 §2-3b) ため、アプリ層で
 * normalize→2-gram→空白区切り列 (search_text) を作り、FTS5 は単純トークナイザ (unicode61) で
 * その列を索引する。normalize/ngrams は faq-match.ts を import 再利用 (自前再実装禁止・Dice drift
 * 防止 / D-1)。search_text の計算は worker 層のみ (packages/db は apps/worker を import しない)。
 */

/** normalize→2-gram→空白連結 (クエリ側)。 */
export function buildQuerySearchText(text: string): string {
  return [...ngrams(normalize(text), 2)].join(' ');
}

/** FAQ 側索引テキスト: question + 全 variants の bigram を空白連結 (Phase A の question+variants 対称)。 */
export function buildFaqSearchText(question: string, variants: string[]): string {
  const grams: string[] = [];
  for (const part of [question, ...variants]) {
    for (const g of ngrams(normalize(part), 2)) grams.push(g);
  }
  return grams.join(' ');
}

function parseVariants(variants: string): string[] {
  try {
    const parsed = JSON.parse(variants) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * FTS5 recall (account スコープ・is_active=1・top-K)。差替の candidate 供給元 (§3-3)。
 * MATCH は bigram を OR 連結 (FTS5 既定 AND は厳しすぎ → recall のため OR)。各 bigram は "…" phrase
 * quote (normalize が FTS5 特殊文字 " ( ) : 等を除去済のため安全だが防御的に quote)。
 * 空 bigram (極短文) は FTS を叩かず [] 返し。
 */
export async function retrieveFaqCandidates(
  db: D1Database,
  question: string,
  lineAccountId: string | null,
  limit = 5,
): Promise<MatchableFaq[]> {
  const bigrams = buildQuerySearchText(question).split(' ').filter(Boolean);
  if (bigrams.length === 0) return [];
  const match = bigrams.map((b) => `"${b}"`).join(' OR ');
  // account スコープ = getActiveFaqsForMatch (faqs.ts:40) と同一式 (cross-account 漏洩防止 / M-account-scope)。
  const result = await db
    .prepare(
      `SELECT f.* FROM faqs_fts fts
         JOIN faqs f ON f.rowid = fts.rowid
        WHERE faqs_fts MATCH ?
          AND f.is_active = 1
          AND (f.line_account_id IS NULL OR f.line_account_id = ?)
        ORDER BY bm25(faqs_fts)
        LIMIT ?`,
    )
    .bind(match, lineAccountId, limit)
    .all<Faq>();
  return result.results.map((f) => ({ ...f, variants: parseVariants(f.variants) }));
}

/**
 * 既存 faqs 全行の search_text を JS (buildFaqSearchText) で計算して埋める backfill (T-B5-b/d)。
 * migration 091 は列/仮想表/トリガを additive で足すが「既存行」は未索引 (search_text='') のまま
 * → 本 backfill が全行に search_text を書き、AU トリガ経由で faqs_fts を構築する。normalize は JS 依存
 * につき純 SQL migration では不可 → deploy 手順のワンショット (再実行は同値を書くだけ = idempotent)。
 * search_text 以外の列 (question/variants/answer/updated_at 等) は触らない (TRINA 既存データ無改変)。
 * worker 層に置く (計算 + UPDATE) = db → worker 依存方向を保つ。返り値 = 更新行数。
 */
export async function backfillFaqsSearchText(db: D1Database): Promise<number> {
  const result = await db
    .prepare(`SELECT id, question, variants FROM faqs`)
    .all<{ id: string; question: string; variants: string }>();
  let updated = 0;
  for (const row of result.results) {
    const searchText = buildFaqSearchText(row.question, parseVariants(row.variants));
    // search_text のみ更新 (updated_at 等は不変)。AU トリガが faqs_fts に反映。
    await db.prepare(`UPDATE faqs SET search_text = ? WHERE id = ?`).bind(searchText, row.id).run();
    updated += 1;
  }
  return updated;
}

/**
 * retrieveFaqCandidates + 既存 scoreFaq (Dice) 再ランク → FaqMatchDetail。
 * B-1 の暫定検索 (Dice-over-all の detail.best) の「供給元」をこれに差し替える (§3-3)。
 * runFaqAiAnswer は本 detail の best / topScore のみ参照 (match は使わない = null)。topScore は
 * scoreFaq の [0,1] 有界値 = 既存 ai.retrievalFloor と同一尺度 (検索スコア下限を保持 / FATAL 修正)。
 */
export async function retrieveAndRankFaq(
  db: D1Database,
  question: string,
  lineAccountId: string | null,
  limit = 5,
): Promise<FaqMatchDetail> {
  const candidates = await retrieveFaqCandidates(db, question, lineAccountId, limit);
  let best: FaqMatch | null = null;
  for (const faq of candidates) {
    const score = scoreFaq(question, faq);
    if (!best || score > best.score) best = { faq, score };
  }
  return { match: null, best, topScore: best ? best.score : null };
}
