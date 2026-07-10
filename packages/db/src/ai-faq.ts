import { jstNow } from './utils.js';

/**
 * UTC 日 'YYYY-MM-DD'。Cloudflare Workers AI 無料枠は 00:00 UTC でリセットするため、
 * budget の bucket は UTC 日付の等値キーで持つ (julianday 範囲比較の窓歪みを原理的に回避)。
 */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export interface AiUsageDelta {
  lineAccountId: string;
  usageDate: string; // utcDay()
  llmNeurons?: number;
  embedNeurons?: number;
  imageNeurons?: number;
  replyCount?: number;
}

/**
 * ai_usage_budget の UTC 日 bucket に neuron/reply を UPSERT 積算する。
 * UNIQUE(line_account_id, usage_date) 衝突時は加算 (D1 は 1 行 atomic increment)。
 */
export async function recordAiUsage(db: D1Database, input: AiUsageDelta): Promise<void> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO ai_usage_budget
         (id, line_account_id, usage_date, llm_neurons, embed_neurons, image_neurons, reply_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(line_account_id, usage_date) DO UPDATE SET
         llm_neurons   = llm_neurons   + excluded.llm_neurons,
         embed_neurons = embed_neurons + excluded.embed_neurons,
         image_neurons = image_neurons + excluded.image_neurons,
         reply_count   = reply_count   + excluded.reply_count,
         updated_at    = excluded.updated_at`,
    )
    .bind(
      id,
      input.lineAccountId,
      input.usageDate,
      input.llmNeurons ?? 0,
      input.embedNeurons ?? 0,
      input.imageNeurons ?? 0,
      input.replyCount ?? 0,
      now,
      now,
    )
    .run();
}

/** 当該 account の当日 (UTC) 消費 neuron 合計 (llm + embed + image)。 */
export async function getAiUsageToday(
  db: D1Database,
  lineAccountId: string,
  usageDate: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT (llm_neurons + embed_neurons + image_neurons) AS total
         FROM ai_usage_budget
        WHERE line_account_id = ? AND usage_date = ?`,
    )
    .bind(lineAccountId, usageDate)
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

/**
 * 全 account 合算の当日 (UTC) 消費 neuron 合計。
 * Cloudflare 無料枠は「アカウント全体」で共有されるため、これがグローバル判定の主軸。
 */
export async function getAiUsageGlobalToday(db: D1Database, usageDate: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(llm_neurons + embed_neurons + image_neurons), 0) AS total
         FROM ai_usage_budget
        WHERE usage_date = ?`,
    )
    .bind(usageDate)
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

export interface AiBudgetLimits {
  lineAccountId: string;
  usageDate: string;
  globalBudget: number; // AI_DAILY_NEURON_BUDGET_GLOBAL (共有無料枠の安全上限)
  perAccountBudget: number; // AI_DAILY_NEURON_BUDGET_PER_ACCOUNT
}

/**
 * (a) 全 account 合算 vs グローバル上限 と (b) 当該 account vs per-account 上限 の OR 判定。
 * どちらか到達で true (= AI 呼出前に未対応インボックスへ退避)。
 * 呼び手は DB 例外を握り潰さず「判別不能 = 退避」で fail-closed 側に倒すこと。
 */
export async function isOverAiBudget(db: D1Database, limits: AiBudgetLimits): Promise<boolean> {
  const global = await getAiUsageGlobalToday(db, limits.usageDate);
  if (global >= limits.globalBudget) return true;
  const account = await getAiUsageToday(db, limits.lineAccountId, limits.usageDate);
  return account >= limits.perAccountBudget;
}

export interface InsertAiFaqDraftInput {
  lineAccountId: string | null;
  friendId: string | null;
  question: string;
  draftAnswer: string;
  evidenceFaqIds?: string[];
}

/** answer_mode=draft の AI 回答草案を status='pending' で保存 (送信しない / 承認 UI は B-5)。 */
export async function insertAiFaqDraft(db: D1Database, input: InsertAiFaqDraftInput): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO ai_faq_drafts
         (id, line_account_id, friend_id, question, draft_answer, evidence_faq_ids, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    )
    .bind(
      id,
      input.lineAccountId,
      input.friendId,
      input.question,
      input.draftAnswer,
      JSON.stringify(input.evidenceFaqIds ?? []),
    )
    .run();
  return id;
}
