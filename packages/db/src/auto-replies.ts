import { jstNow } from './utils.js';
// =============================================================================
// Auto-Replies — Keyword-triggered automatic responses (L社 自動応答 equivalent)
// =============================================================================

export interface AutoReply {
  id: string;
  keyword: string;
  match_type: 'exact' | 'contains';
  response_type: string;
  response_content: string;
  response_messages: string | null;
  on_reply_actions_json: string | null;
  template_id: string | null;
  line_account_id: string | null;
  keep_in_unresponded: number;
  is_active: number;
  created_at: string;
}

export interface AutoReplyResponseMessage {
  messageType: string;
  messageContent: string;
}

// ── CRUD ─────────────────────────────────────────────────────────────────────

export async function getAutoReplies(
  db: D1Database,
  lineAccountId?: string,
): Promise<AutoReply[]> {
  if (lineAccountId) {
    const result = await db
      .prepare(`SELECT * FROM auto_replies WHERE (line_account_id IS NULL OR line_account_id = ?) ORDER BY created_at DESC`)
      .bind(lineAccountId)
      .all<AutoReply>();
    return result.results;
  }
  const result = await db
    .prepare(`SELECT * FROM auto_replies ORDER BY created_at DESC`)
    .all<AutoReply>();
  return result.results;
}

export async function getAutoReplyById(
  db: D1Database,
  id: string,
): Promise<AutoReply | null> {
  return db
    .prepare(`SELECT * FROM auto_replies WHERE id = ?`)
    .bind(id)
    .first<AutoReply>();
}

export interface CreateAutoReplyInput {
  keyword: string;
  matchType?: 'exact' | 'contains';
  responseType?: string;
  responseContent: string;
  responseMessages?: AutoReplyResponseMessage[] | null;
  onReplyActionsJson?: string | null;
  templateId?: string | null;
  lineAccountId?: string | null;
  keepInUnresponded?: boolean;
}

export async function createAutoReply(
  db: D1Database,
  input: CreateAutoReplyInput,
): Promise<AutoReply> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const firstMessage = input.responseMessages?.[0];

  await db
    .prepare(
      `INSERT INTO auto_replies
         (id, keyword, match_type, response_type, response_content, response_messages,
          on_reply_actions_json, template_id, line_account_id, keep_in_unresponded, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .bind(
      id,
      input.keyword,
      input.matchType ?? 'exact',
      firstMessage?.messageType ?? input.responseType ?? 'text',
      firstMessage?.messageContent ?? input.responseContent,
      input.responseMessages === undefined || input.responseMessages === null
        ? null
        : JSON.stringify(input.responseMessages),
      input.onReplyActionsJson ?? null,
      firstMessage ? null : (input.templateId ?? null),
      input.lineAccountId ?? null,
      input.keepInUnresponded ? 1 : 0,
      now,
    )
    .run();

  return (await getAutoReplyById(db, id))!;
}

export interface UpdateAutoReplyInput {
  keyword?: string;
  matchType?: 'exact' | 'contains';
  responseType?: string;
  responseContent?: string;
  responseMessages?: AutoReplyResponseMessage[] | null;
  onReplyActionsJson?: string | null;
  templateId?: string | null;
  lineAccountId?: string | null;
  keepInUnresponded?: boolean;
  isActive?: boolean;
}

export async function updateAutoReply(
  db: D1Database,
  id: string,
  input: UpdateAutoReplyInput,
): Promise<AutoReply | null> {
  const existing = await getAutoReplyById(db, id);
  if (!existing) return null;

  const now = jstNow();
  const firstMessage = input.responseMessages?.[0];
  const responseMessages = 'responseMessages' in input
    ? (input.responseMessages === null ? null : JSON.stringify(input.responseMessages))
    : existing.response_messages;

  await db
    .prepare(
      `UPDATE auto_replies
       SET keyword = ?,
           match_type = ?,
           response_type = ?,
           response_content = ?,
           response_messages = ?,
           on_reply_actions_json = ?,
           template_id = ?,
           line_account_id = ?,
           keep_in_unresponded = ?,
           is_active = ?,
           created_at = ?
       WHERE id = ?`,
    )
    .bind(
      input.keyword ?? existing.keyword,
      input.matchType ?? existing.match_type,
      firstMessage?.messageType ?? input.responseType ?? existing.response_type,
      firstMessage?.messageContent ?? input.responseContent ?? existing.response_content,
      responseMessages,
      'onReplyActionsJson' in input
        ? (input.onReplyActionsJson ?? null)
        : existing.on_reply_actions_json,
      firstMessage ? null : ('templateId' in input ? (input.templateId ?? null) : existing.template_id),
      'lineAccountId' in input ? (input.lineAccountId ?? null) : existing.line_account_id,
      'keepInUnresponded' in input
        ? (input.keepInUnresponded ? 1 : 0)
        : (existing.keep_in_unresponded ?? 0),
      'isActive' in input ? (input.isActive ? 1 : 0) : existing.is_active,
      existing.created_at,
      id,
    )
    .run();

  return getAutoReplyById(db, id);
}

export async function deleteAutoReply(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM auto_replies WHERE id = ?`).bind(id).run();
}
