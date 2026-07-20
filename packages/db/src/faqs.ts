import { jstNow } from './utils.js';

export interface Faq {
  id: string;
  line_account_id: string | null;
  question: string;
  variants: string;
  answer: string;
  is_active: number;
  hit_count: number;
  created_at: string;
  updated_at: string;
  /** Phase B B-2 (091): 全文検索索引列。worker faq-fts.ts が normalize→2-gram→空白連結で計算 (db は保存のみ)。 */
  search_text: string;
}

export interface UnmatchedQuestion {
  id: string;
  line_account_id: string | null;
  friend_id: string | null;
  question: string;
  top_score: number | null;
  resolved_faq_id: string | null;
  created_at: string;
}

export async function getFaqs(db: D1Database, lineAccountId?: string): Promise<Faq[]> {
  if (lineAccountId) {
    const result = await db
      .prepare(`SELECT * FROM faqs WHERE (line_account_id IS NULL OR line_account_id = ?) ORDER BY created_at DESC`)
      .bind(lineAccountId)
      .all<Faq>();
    return result.results;
  }
  const result = await db.prepare(`SELECT * FROM faqs ORDER BY created_at DESC`).all<Faq>();
  return result.results;
}

export async function getActiveFaqsForMatch(db: D1Database, lineAccountId: string | null): Promise<Faq[]> {
  if (lineAccountId) {
    const result = await db
      .prepare(`SELECT * FROM faqs WHERE is_active = 1 AND (line_account_id IS NULL OR line_account_id = ?) ORDER BY created_at DESC`)
      .bind(lineAccountId)
      .all<Faq>();
    return result.results;
  }
  const result = await db
    .prepare(`SELECT * FROM faqs WHERE is_active = 1 AND line_account_id IS NULL ORDER BY created_at DESC`)
    .all<Faq>();
  return result.results;
}

export async function getFaqById(db: D1Database, id: string): Promise<Faq | null> {
  return db.prepare(`SELECT * FROM faqs WHERE id = ?`).bind(id).first<Faq>();
}

export interface CreateFaqInput {
  question: string;
  variants?: string[];
  answer: string;
  lineAccountId?: string | null;
  isActive?: boolean;
  /**
   * Phase B B-2 (T-B5-a): 全文検索索引列 (2-gram 空白連結)。値は worker 層 (faq-fts.buildFaqSearchText)
   * が計算して渡す (db は保存のみ・計算しない = 依存方向。packages/db は apps/worker を import しない)。
   * 省略時は '' (additive default)。実呼出は必ず渡す。
   */
  searchText?: string;
}

export async function createFaq(db: D1Database, input: CreateFaqInput): Promise<Faq> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO faqs
         (id, line_account_id, question, variants, answer, is_active, created_at, updated_at, search_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.lineAccountId ?? null,
      input.question,
      JSON.stringify(input.variants ?? []),
      input.answer,
      input.isActive === false ? 0 : 1,
      now,
      now,
      input.searchText ?? '',
    )
    .run();
  return (await getFaqById(db, id))!;
}

export interface UpdateFaqInput {
  question?: string;
  variants?: string[];
  answer?: string;
  lineAccountId?: string | null;
  isActive?: boolean;
  /**
   * Phase B B-2 (T-B5-a): 全文検索索引列。question/variants が変わる時に worker 層が最終値から
   * 再計算して渡す (db は保存のみ)。省略時は既存 search_text を保持 (answer/isActive のみ変更時)。
   */
  searchText?: string;
}

export async function updateFaq(db: D1Database, id: string, input: UpdateFaqInput): Promise<Faq | null> {
  const existing = await getFaqById(db, id);
  if (!existing) return null;
  const now = jstNow();
  await db
    .prepare(
      `UPDATE faqs
       SET line_account_id = ?,
           question = ?,
           variants = ?,
           answer = ?,
           is_active = ?,
           updated_at = ?,
           search_text = ?
       WHERE id = ?`,
    )
    .bind(
      'lineAccountId' in input ? (input.lineAccountId ?? null) : existing.line_account_id,
      input.question ?? existing.question,
      input.variants !== undefined ? JSON.stringify(input.variants) : existing.variants,
      input.answer ?? existing.answer,
      input.isActive !== undefined ? (input.isActive ? 1 : 0) : existing.is_active,
      now,
      input.searchText !== undefined ? input.searchText : existing.search_text,
      id,
    )
    .run();
  return getFaqById(db, id);
}

export async function deleteFaq(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM faqs WHERE id = ?`).bind(id).run();
}

export async function incrementFaqHitCount(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(`UPDATE faqs SET hit_count = hit_count + 1, updated_at = ? WHERE id = ?`)
    .bind(jstNow(), id)
    .run();
}

// reviewer R1-I2/F-2: messages_log は +09:00 付き、ai_faq_drafts は suffix なしの JST。
// julianday() で数値化し、草案だけ -9h して UTC に揃えることで正しく「直近 24h」を数える。
export const RECENT_FAQ_REPLY_COUNT_SQL = `WITH target(friend_id) AS (VALUES (?))
       SELECT
         (SELECT COUNT(*)
            FROM messages_log ml
            JOIN target t ON ml.friend_id = t.friend_id
           WHERE ml.direction = 'outgoing'
             AND ml.source = 'faq_bot'
             AND ml.delivery_type = 'reply'
             AND julianday(ml.created_at) >= julianday('now', '-24 hours'))
         +
         (SELECT COUNT(*)
            FROM ai_faq_drafts d
            JOIN target t ON d.friend_id = t.friend_id
           WHERE julianday(d.created_at, '-9 hours') >= julianday('now', '-24 hours'))
         AS count`;

/** 直近 24h の friend 別 FAQ 枠使用数 (実送信 + 未送信草案)。 */
export async function countRecentFaqReplies(db: D1Database, friendId: string): Promise<number> {
  const row = await db
    .prepare(RECENT_FAQ_REPLY_COUNT_SQL)
    .bind(friendId)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function getUnmatchedQuestions(db: D1Database, lineAccountId?: string): Promise<UnmatchedQuestion[]> {
  if (lineAccountId) {
    const result = await db
      .prepare(`SELECT * FROM unmatched_questions WHERE (line_account_id IS NULL OR line_account_id = ?) ORDER BY resolved_faq_id IS NOT NULL ASC, created_at DESC`)
      .bind(lineAccountId)
      .all<UnmatchedQuestion>();
    return result.results;
  }
  const result = await db
    .prepare(`SELECT * FROM unmatched_questions ORDER BY resolved_faq_id IS NOT NULL ASC, created_at DESC`)
    .all<UnmatchedQuestion>();
  return result.results;
}

export async function getUnmatchedById(db: D1Database, id: string): Promise<UnmatchedQuestion | null> {
  return db.prepare(`SELECT * FROM unmatched_questions WHERE id = ?`).bind(id).first<UnmatchedQuestion>();
}

export interface RecordUnmatchedQuestionInput {
  lineAccountId: string | null;
  friendId: string | null;
  question: string;
  topScore: number | null;
}

export async function recordUnmatchedQuestion(
  db: D1Database,
  input: RecordUnmatchedQuestionInput,
): Promise<UnmatchedQuestion> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO unmatched_questions (id, line_account_id, friend_id, question, top_score)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(id, input.lineAccountId, input.friendId, input.question, input.topScore)
    .run();
  return (await getUnmatchedById(db, id))!;
}

export async function markUnmatchedResolved(db: D1Database, id: string, faqId: string): Promise<void> {
  await db
    .prepare(`UPDATE unmatched_questions SET resolved_faq_id = ? WHERE id = ?`)
    .bind(faqId, id)
    .run();
}
