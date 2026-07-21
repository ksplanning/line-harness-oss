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
  /** false は「資料不足」草案。既存/決定的草案は省略時 true。 */
  answerable?: boolean;
}

// =============================================================================
// B-5 (T-E4) — AI ログ/コスト可視化の read helper (既存表 read のみ = migration ゼロ)。
// =============================================================================

/** ai_usage_budget の 1 日行 (per-account そのまま / global は SUM 済)。 */
export interface AiUsageBudgetRow {
  usage_date: string;
  llm_neurons: number;
  embed_neurons: number;
  image_neurons: number;
  reply_count: number;
}

// days/limit の上限 (無制限レスポンス防止 / M-3)。呼出 route も clamp するが helper 側でも hard cap。
const AI_USAGE_MAX_DAYS = 365;
const AI_DRAFTS_MAX_LIMIT = 500;

/**
 * 当該 account の日次 neuron 使用量を usage_date DESC で返す (B-5 T-E4)。line_account_id は NOT NULL のため
 * account 専用行のみ (global は listAiUsageGlobal が SUM で別途出す)。days は最大 365 に clamp。
 */
export async function listAiUsageForAccount(
  db: D1Database,
  lineAccountId: string,
  days = 30,
): Promise<AiUsageBudgetRow[]> {
  const limit = Math.min(AI_USAGE_MAX_DAYS, Math.max(1, Math.floor(days)));
  const result = await db
    .prepare(
      `SELECT usage_date, llm_neurons, embed_neurons, image_neurons, reply_count
         FROM ai_usage_budget
        WHERE line_account_id = ?
        ORDER BY usage_date DESC
        LIMIT ?`,
    )
    .bind(lineAccountId, limit)
    .all<AiUsageBudgetRow>();
  return result.results;
}

/**
 * 全 account 合算の日次 neuron 使用量を GROUP BY usage_date + SUM で返す (B-5 T-E4 / Codex B-5)。
 * ⚠️ line_account_id は NOT NULL = global 専用行は存在しない → accountId=null で global 行を引く設計は誤り。
 * Cloudflare 無料枠は account 全体で共有されるため、この SUM が無料枠 headroom の主軸。days は最大 365 に clamp。
 */
export async function listAiUsageGlobal(db: D1Database, days = 30): Promise<AiUsageBudgetRow[]> {
  const limit = Math.min(AI_USAGE_MAX_DAYS, Math.max(1, Math.floor(days)));
  const result = await db
    .prepare(
      `SELECT usage_date,
              SUM(llm_neurons)   AS llm_neurons,
              SUM(embed_neurons) AS embed_neurons,
              SUM(image_neurons) AS image_neurons,
              SUM(reply_count)   AS reply_count
         FROM ai_usage_budget
        GROUP BY usage_date
        ORDER BY usage_date DESC
        LIMIT ?`,
    )
    .bind(limit)
    .all<AiUsageBudgetRow>();
  return result.results;
}

/** ai_faq_drafts の 1 行 (route は allowlist で friend_id/evidence/account_id を露出しない / D-3)。 */
export interface AiFaqDraftRow {
  id: string;
  line_account_id: string | null;
  friend_id: string | null;
  question: string;
  draft_answer: string;
  answerable: number;
  evidence_faq_ids: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/**
 * AI 草案ログ (ai_faq_drafts = answer_mode=draft のみ・auto-send 回答は非保存) を account スコープ (global(null) +
 * 指定 account) で created_at DESC 一覧 (B-5 T-E4)。status 指定で絞る。limit は最大 500 に clamp。
 */
export async function listAiFaqDrafts(
  db: D1Database,
  lineAccountId: string | null,
  status?: string,
  limit = 100,
): Promise<AiFaqDraftRow[]> {
  const cap = Math.min(AI_DRAFTS_MAX_LIMIT, Math.max(1, Math.floor(limit)));
  if (status) {
    const result = await db
      .prepare(
        `SELECT * FROM ai_faq_drafts
          WHERE (line_account_id IS NULL OR line_account_id = ?) AND status = ?
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .bind(lineAccountId, status, cap)
      .all<AiFaqDraftRow>();
    return result.results;
  }
  const result = await db
    .prepare(
      `SELECT * FROM ai_faq_drafts
        WHERE (line_account_id IS NULL OR line_account_id = ?)
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .bind(lineAccountId, cap)
    .all<AiFaqDraftRow>();
  return result.results;
}

/** answer_mode=draft の AI 回答草案を status='pending' で保存 (送信しない / 承認 UI は B-5)。 */
export async function insertAiFaqDraft(db: D1Database, input: InsertAiFaqDraftInput): Promise<string> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO ai_faq_drafts
         (id, line_account_id, friend_id, question, draft_answer, evidence_faq_ids, answerable, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
    )
    .bind(
      id,
      input.lineAccountId,
      input.friendId,
      input.question,
      input.draftAnswer,
      JSON.stringify(input.evidenceFaqIds ?? []),
      input.answerable === false ? 0 : 1,
    )
    .run();
  return id;
}
