import { jstNow } from './utils.js';

const MAX_AI_ANALYSIS_SUBMISSIONS = 50;
const AI_CHAT_PENDING_TTL_MS = 5 * 60_000;

export interface FormalooAiAnalysisSubmission {
  answersJson: string;
  /** Day precision is enough for trends and avoids sending exact respondent timestamps. */
  submittedDate: string;
}

interface FormalooAiAnalysisSubmissionRow {
  answers_json: string;
  submitted_date: string;
}

/**
 * Read the smallest useful D1 projection for AI analysis.
 * Unverified webhook rows and all respondent/submission identifiers are deliberately excluded.
 */
export async function listFormalooAiAnalysisSubmissions(
  db: D1Database,
  formId: string,
  limit = MAX_AI_ANALYSIS_SUBMISSIONS,
): Promise<FormalooAiAnalysisSubmission[]> {
  const boundedLimit = Math.max(1, Math.min(MAX_AI_ANALYSIS_SUBMISSIONS, Math.floor(limit)));
  const result = await db.prepare(
    `SELECT answers_json, substr(submitted_at, 1, 10) AS submitted_date
     FROM formaloo_submissions
     WHERE form_id = ? AND verified = 1
     ORDER BY submitted_at DESC, id DESC
     LIMIT ?`,
  ).bind(formId, boundedLimit).all<FormalooAiAnalysisSubmissionRow>();
  return result.results.map((row) => ({
    answersJson: row.answers_json,
    submittedDate: row.submitted_date,
  }));
}

export type FormalooAiChatHistoryStatus = 'pending' | 'completed' | 'failed';

export interface FormalooAiChatHistory {
  id: string;
  tenantScope: string;
  lineAccountId: string;
  formId: string;
  question: string;
  answer: Record<string, unknown> | null;
  answerText: string | null;
  analysisSlug: string | null;
  status: FormalooAiChatHistoryStatus;
  providerStatus: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  creditsConsumed: boolean;
  creditReserved: boolean;
  createdAt: string;
  updatedAt: string;
}

interface FormalooAiChatHistoryRow {
  id: string;
  tenant_scope: string;
  line_account_id: string;
  form_id: string;
  question: string;
  answer_json: string | null;
  answer_text: string | null;
  analysis_slug: string | null;
  status: FormalooAiChatHistoryStatus;
  provider_status: string | null;
  error_code: string | null;
  error_message: string | null;
  credits_consumed: number;
  credit_reserved: number;
  created_at: string;
  updated_at: string;
}

function parseAnswer(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function mapHistory(row: FormalooAiChatHistoryRow): FormalooAiChatHistory {
  return {
    id: row.id,
    tenantScope: row.tenant_scope,
    lineAccountId: row.line_account_id,
    formId: row.form_id,
    question: row.question,
    answer: parseAnswer(row.answer_json),
    answerText: row.answer_text,
    analysisSlug: row.analysis_slug,
    status: row.status,
    providerStatus: row.provider_status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    creditsConsumed: row.credits_consumed === 1,
    creditReserved: row.credit_reserved === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getById(db: D1Database, id: string): Promise<FormalooAiChatHistory | null> {
  const row = await db.prepare('SELECT * FROM formaloo_ai_chat_history WHERE id = ?')
    .bind(id).first<FormalooAiChatHistoryRow>();
  return row ? mapHistory(row) : null;
}

function nextJstDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/**
 * Reserve one possible credit in the same INSERT that checks the daily limit.
 * D1 serializes writes, so concurrent isolates cannot both pass the final slot.
 */
export async function reserveFormalooAiChatHistory(
  db: D1Database,
  input: {
    tenantScope: string;
    lineAccountId: string;
    formId: string;
    question: string;
    dailyLimit: number;
    now?: string;
  },
): Promise<FormalooAiChatHistory | null> {
  const id = `fac_${crypto.randomUUID()}`;
  const now = input.now ?? jstNow();
  const day = now.slice(0, 10);
  const dayStart = `${day}T00:00:00.000+09:00`;
  const nextDayStart = `${nextJstDate(day)}T00:00:00.000+09:00`;
  const parsedNow = Date.parse(now);
  const staleBefore = Number.isFinite(parsedNow)
    ? new Date(parsedNow - AI_CHAT_PENDING_TTL_MS).toISOString()
    : now;
  await db.prepare(
    `UPDATE formaloo_ai_chat_history
     SET status = 'failed', provider_status = 'interrupted',
         error_code = 'analysis_interrupted',
         error_message = '前回の分析が中断されました。もう一度お試しください',
         credits_consumed = 1, credit_reserved = 1, updated_at = ?
     WHERE tenant_scope = ?
       AND status = 'pending'
       AND julianday(updated_at) < julianday(?)`,
  ).bind(now, input.tenantScope, staleBefore).run();
  const result = await db.prepare(
    `INSERT INTO formaloo_ai_chat_history (
       id, tenant_scope, line_account_id, form_id, question, status,
       credits_consumed, credit_reserved, created_at, updated_at
     )
     SELECT ?, ?, ?, ?, ?, 'pending', 0, 1, ?, ?
     WHERE (
       SELECT COUNT(*) FROM formaloo_ai_chat_history
       WHERE tenant_scope = ?
         AND credit_reserved = 1
         AND created_at >= ?
         AND created_at < ?
     ) < ?
       AND NOT EXISTS (
         SELECT 1 FROM formaloo_ai_chat_history
         WHERE tenant_scope = ?
           AND line_account_id = ?
           AND form_id = ?
           AND status = 'pending'
       )`,
  ).bind(
    id, input.tenantScope, input.lineAccountId, input.formId, input.question, now, now,
    input.tenantScope, dayStart, nextDayStart, input.dailyLimit,
    input.tenantScope, input.lineAccountId, input.formId,
  ).run();
  if ((result.meta.changes ?? 0) !== 1) return null;
  return getById(db, id);
}

export async function hasPendingFormalooAiChatHistory(
  db: D1Database,
  input: { tenantScope: string; lineAccountId: string; formId: string },
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS found FROM formaloo_ai_chat_history
     WHERE tenant_scope = ? AND line_account_id = ? AND form_id = ? AND status = 'pending'
     LIMIT 1`,
  ).bind(input.tenantScope, input.lineAccountId, input.formId).first<{ found: number }>();
  return row?.found === 1;
}

export async function completeFormalooAiChatHistory(
  db: D1Database,
  id: string,
  input: {
    analysisSlug: string;
    answer: Record<string, unknown>;
    answerText: string;
    providerStatus: string;
    now?: string;
  },
): Promise<FormalooAiChatHistory | null> {
  const now = input.now ?? jstNow();
  const result = await db.prepare(
    `UPDATE formaloo_ai_chat_history
     SET answer_json = ?, answer_text = ?, analysis_slug = ?, status = 'completed',
         provider_status = ?, error_code = NULL, error_message = NULL,
         credits_consumed = 1, credit_reserved = 1, updated_at = ?
     WHERE id = ? AND status = 'pending'`,
  ).bind(
    JSON.stringify(input.answer), input.answerText, input.analysisSlug,
    input.providerStatus, now, id,
  ).run();
  if ((result.meta.changes ?? 0) !== 1) return null;
  return getById(db, id);
}

export async function failFormalooAiChatHistory(
  db: D1Database,
  id: string,
  input: {
    errorCode: string;
    errorMessage: string;
    creditsConsumed: boolean;
    providerStatus?: string | null;
    analysisSlug?: string | null;
    now?: string;
  },
): Promise<FormalooAiChatHistory | null> {
  const now = input.now ?? jstNow();
  const consumed = input.creditsConsumed ? 1 : 0;
  const result = await db.prepare(
    `UPDATE formaloo_ai_chat_history
     SET analysis_slug = ?, status = 'failed', provider_status = ?, error_code = ?, error_message = ?,
         credits_consumed = ?, credit_reserved = ?, updated_at = ?
     WHERE id = ? AND status = 'pending'`,
  ).bind(
    input.analysisSlug ?? null, input.providerStatus ?? null, input.errorCode,
    input.errorMessage, consumed, consumed, now, id,
  ).run();
  if ((result.meta.changes ?? 0) !== 1) return null;
  return getById(db, id);
}

export async function listFormalooAiChatHistory(
  db: D1Database,
  input: {
    tenantScope: string;
    lineAccountId: string;
    formId?: string;
    limit?: number;
  },
): Promise<FormalooAiChatHistory[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 50)));
  const formClause = input.formId ? ' AND form_id = ?' : '';
  const binds: unknown[] = [input.tenantScope, input.lineAccountId];
  if (input.formId) binds.push(input.formId);
  binds.push(limit);
  const result = await db.prepare(
    `SELECT * FROM formaloo_ai_chat_history
     WHERE tenant_scope = ? AND line_account_id = ?${formClause}
     ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).bind(...binds).all<FormalooAiChatHistoryRow>();
  return result.results.map(mapHistory);
}
