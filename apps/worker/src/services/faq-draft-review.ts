import { jstNow } from '@line-crm/db';
import { LineClient } from '@line-crm/line-sdk';

export interface InlineAiFaqDraft {
  id: string;
  question: string;
  draftAnswer: string;
  createdAt: string;
  updatedAt: string;
  questionMessageId: string | null;
}

interface InlineDraftRow {
  id: string;
  question: string;
  draft_answer: string;
  created_at: string;
  updated_at: string;
  question_message_id: string | null;
}

interface ReviewContextRow {
  id: string;
  line_account_id: string | null;
  friend_id: string;
  question: string;
  draft_answer: string;
  status: string;
  created_at: string;
  updated_at: string;
  line_user_id: string;
  friend_account_id: string | null;
  channel_access_token: string | null;
  account_is_active: number | null;
}

export interface ReviewedDraft {
  id: string;
  question: string;
  draftAnswer: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export class FaqDraftReviewError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 500 | 502,
  ) {
    super(message);
    this.name = 'FaqDraftReviewError';
  }
}

function serializeDraft(row: Pick<ReviewContextRow, 'id' | 'question' | 'draft_answer' | 'status' | 'created_at' | 'updated_at'>): ReviewedDraft {
  return {
    id: row.id,
    question: row.question,
    draftAnswer: row.draft_answer,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Pending drafts for one friend, paired to the newest same-text incoming message before
 * draft creation. Draft timestamps are legacy suffix-less JST, so normalize them by -9h.
 */
export async function listInlineAiFaqDrafts(
  db: D1Database,
  friendId: string,
): Promise<InlineAiFaqDraft[]> {
  const result = await db.prepare(
    `SELECT
       d.id,
       d.question,
       d.draft_answer,
       d.created_at,
       d.updated_at,
       (
         SELECT m.id
           FROM messages_log m
          WHERE m.friend_id = d.friend_id
            AND m.direction = 'incoming'
            AND m.message_type = 'text'
            AND m.content = d.question
            AND julianday(m.created_at) <= julianday(d.created_at, '-9 hours')
          ORDER BY julianday(m.created_at) DESC, m.id DESC
          LIMIT 1
       ) AS question_message_id
      FROM ai_faq_drafts d
     WHERE d.friend_id = ? AND d.status = 'pending'
     ORDER BY julianday(d.created_at, '-9 hours') ASC, d.id ASC`,
  ).bind(friendId).all<InlineDraftRow>();
  return result.results.map((row) => ({
    id: row.id,
    question: row.question,
    draftAnswer: row.draft_answer,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    questionMessageId: row.question_message_id,
  }));
}

async function getReviewContext(
  db: D1Database,
  draftId: string,
  friendId: string,
): Promise<ReviewContextRow | null> {
  return db.prepare(
    `SELECT
       d.id,
       d.line_account_id,
       d.friend_id,
       d.question,
       d.draft_answer,
       d.status,
       d.created_at,
       d.updated_at,
       f.line_user_id,
       f.line_account_id AS friend_account_id,
       la.channel_access_token,
       la.is_active AS account_is_active
      FROM ai_faq_drafts d
      JOIN friends f ON f.id = d.friend_id
      LEFT JOIN line_accounts la ON la.id = f.line_account_id
     WHERE d.id = ? AND d.friend_id = ?`,
  ).bind(draftId, friendId).first<ReviewContextRow>();
}

function validateDraftScope(row: ReviewContextRow | null): ReviewContextRow {
  if (!row) throw new FaqDraftReviewError('下書きが見つかりません', 404);
  if (row.line_account_id !== null && row.line_account_id !== row.friend_account_id) {
    throw new FaqDraftReviewError('下書きと友だちのLINEアカウントが一致しません', 409);
  }
  return row;
}

async function claimPending(
  db: D1Database,
  draftId: string,
  friendId: string,
  claimStatus: 'editing' | 'discarding' | 'sending',
): Promise<ReviewContextRow> {
  const initial = validateDraftScope(await getReviewContext(db, draftId, friendId));
  if (initial.status !== 'pending') {
    throw new FaqDraftReviewError('この下書きはすでに処理されています', 409);
  }
  const claimedAt = jstNow();
  const claim = await db.prepare(
    `UPDATE ai_faq_drafts
        SET status = ?, updated_at = ?
      WHERE id = ? AND friend_id = ? AND status = 'pending'`,
  ).bind(claimStatus, claimedAt, draftId, friendId).run();
  if ((claim.meta.changes ?? 0) !== 1) {
    throw new FaqDraftReviewError('この下書きは別の操作で処理中です', 409);
  }
  const claimed = await getReviewContext(db, draftId, friendId);
  if (!claimed || claimed.status !== claimStatus) {
    throw new FaqDraftReviewError('下書きの処理状態を確認できません', 500);
  }
  return claimed;
}

function auditStatement(
  db: D1Database,
  row: ReviewContextRow,
  actorStaffId: string,
  action: 'edited' | 'approved' | 'discarded' | 'send_failed',
  createdAt: string,
) {
  return db.prepare(
    `INSERT INTO ai_faq_draft_audit_log
       (id, draft_id, line_account_id, friend_id, actor_staff_id, action, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    row.id,
    row.line_account_id,
    row.friend_id,
    actorStaffId,
    action,
    createdAt,
  );
}

export async function editAiFaqDraft(input: {
  db: D1Database;
  draftId: string;
  friendId: string;
  actorStaffId: string;
  draftAnswer: string;
}): Promise<ReviewedDraft> {
  const answer = input.draftAnswer.trim();
  if (!answer || answer.length > 5_000) {
    throw new FaqDraftReviewError('下書き本文は1〜5000文字で入力してください', 400);
  }
  const claimed = await claimPending(input.db, input.draftId, input.friendId, 'editing');
  const now = jstNow();
  await input.db.batch([
    input.db.prepare(
      `UPDATE ai_faq_drafts
          SET draft_answer = ?, status = 'pending', updated_at = ?
        WHERE id = ? AND friend_id = ? AND status = 'editing'`,
    ).bind(answer, now, input.draftId, input.friendId),
    auditStatement(input.db, claimed, input.actorStaffId, 'edited', now),
  ]);
  const updated = validateDraftScope(await getReviewContext(input.db, input.draftId, input.friendId));
  return serializeDraft(updated);
}

export async function discardAiFaqDraft(input: {
  db: D1Database;
  draftId: string;
  friendId: string;
  actorStaffId: string;
}): Promise<ReviewedDraft> {
  const claimed = await claimPending(input.db, input.draftId, input.friendId, 'discarding');
  const now = jstNow();
  await input.db.batch([
    input.db.prepare(
      `UPDATE ai_faq_drafts
          SET status = 'discarded', updated_at = ?
        WHERE id = ? AND friend_id = ? AND status = 'discarding'`,
    ).bind(now, input.draftId, input.friendId),
    auditStatement(input.db, claimed, input.actorStaffId, 'discarded', now),
  ]);
  const updated = validateDraftScope(await getReviewContext(input.db, input.draftId, input.friendId));
  return serializeDraft(updated);
}

export async function approveAiFaqDraft(input: {
  db: D1Database;
  draftId: string;
  friendId: string;
  actorStaffId: string;
}): Promise<{ draft: ReviewedDraft; message: {
  id: string;
  direction: 'outgoing';
  messageType: 'text';
  content: string;
  createdAt: string;
} }> {
  const initial = validateDraftScope(await getReviewContext(input.db, input.draftId, input.friendId));
  if (
    !initial.friend_account_id
    || initial.account_is_active !== 1
    || !initial.channel_access_token
  ) {
    throw new FaqDraftReviewError('送信できるLINEアカウントが見つかりません', 409);
  }
  const claimed = await claimPending(input.db, input.draftId, input.friendId, 'sending');
  // Re-check after the CAS claim and use this row's answer. An edit cannot win after this point.
  if (
    !claimed.friend_account_id
    || claimed.account_is_active !== 1
    || !claimed.channel_access_token
  ) {
    throw new FaqDraftReviewError('送信できるLINEアカウントが見つかりません', 409);
  }

  try {
    await new LineClient(claimed.channel_access_token).pushTextMessage(
      claimed.line_user_id,
      claimed.draft_answer,
    );
  } catch {
    // LINE may have accepted a request even when the response is lost. Never return this
    // draft to pending automatically; doing so would make a retry capable of double-send.
    const failedAt = jstNow();
    try {
      await input.db.batch([
        input.db.prepare(
          `UPDATE ai_faq_drafts
              SET status = 'send_failed', updated_at = ?
            WHERE id = ? AND friend_id = ? AND status = 'sending'`,
        ).bind(failedAt, input.draftId, input.friendId),
        auditStatement(input.db, claimed, input.actorStaffId, 'send_failed', failedAt),
      ]);
    } catch (auditError) {
      console.error('FAQ draft send failure audit failed:', auditError instanceof Error ? auditError.name : 'unknown');
    }
    throw new FaqDraftReviewError('LINEへの送信結果を確認できませんでした。再送せず管理者へ確認してください', 502);
  }

  const sentAt = jstNow();
  const messageId = crypto.randomUUID();
  // Final status, message ledger, chat state and immutable audit commit together. If this
  // batch fails after LINE accepts the push, the prior `sending` claim remains and blocks retry.
  await input.db.batch([
    input.db.prepare(
      `UPDATE ai_faq_drafts
          SET status = 'approved', updated_at = ?
        WHERE id = ? AND friend_id = ? AND status = 'sending'`,
    ).bind(sentAt, input.draftId, input.friendId),
    input.db.prepare(
      `INSERT INTO messages_log
         (id, friend_id, direction, message_type, content, broadcast_id, scenario_step_id,
          delivery_type, source, line_account_id, created_at)
       VALUES (?, ?, 'outgoing', 'text', ?, NULL, NULL, 'push', 'faq_bot', ?, ?)`,
    ).bind(messageId, claimed.friend_id, claimed.draft_answer, claimed.friend_account_id, sentAt),
    input.db.prepare(
      `UPDATE chats
          SET status = 'in_progress', last_message_at = ?, updated_at = ?
        WHERE id = (SELECT id FROM chats WHERE friend_id = ? ORDER BY created_at DESC LIMIT 1)`,
    ).bind(sentAt, sentAt, claimed.friend_id),
    auditStatement(input.db, claimed, input.actorStaffId, 'approved', sentAt),
  ]);

  const updated = validateDraftScope(await getReviewContext(input.db, input.draftId, input.friendId));
  return {
    draft: serializeDraft(updated),
    message: {
      id: messageId,
      direction: 'outgoing',
      messageType: 'text',
      content: claimed.draft_answer,
      createdAt: sentAt,
    },
  };
}
