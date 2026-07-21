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

export interface PendingAiFaqDraftReview extends ReviewedDraft {
  friendName: string;
}

export class FaqDraftReviewError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 500 | 502,
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
      JOIN friends f ON f.id = d.friend_id
     WHERE d.friend_id = ?
       AND d.status = 'pending'
       AND (d.line_account_id IS NULL OR d.line_account_id = f.line_account_id)
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

/** Pending central-inbox rows for exactly one account; internal friend/account IDs stay server-side. */
export async function listPendingAiFaqDraftReviews(
  db: D1Database,
  accountId: string,
): Promise<PendingAiFaqDraftReview[]> {
  const result = await db.prepare(
    `SELECT d.id, d.question, d.draft_answer, d.status, d.created_at, d.updated_at,
            f.display_name AS friend_name
       FROM ai_faq_drafts d
       JOIN friends f ON f.id = d.friend_id
      WHERE d.status = 'pending'
        AND f.line_account_id = ?
        AND (d.line_account_id IS NULL OR d.line_account_id = ?)
      ORDER BY julianday(d.created_at, '-9 hours') DESC, d.id DESC
      LIMIT 500`,
  ).bind(accountId, accountId).all<Pick<
    ReviewContextRow,
    'id' | 'question' | 'draft_answer' | 'status' | 'created_at' | 'updated_at'
  > & { friend_name: string | null }>();
  return result.results.map((row) => ({
    ...serializeDraft(row),
    friendName: row.friend_name || '名前なし',
  }));
}

/** Resolve a central-inbox draft to its friend only after enforcing the selected account. */
export async function resolveAiFaqDraftReviewFriend(
  db: D1Database,
  draftId: string,
  accountId: string,
): Promise<string> {
  const row = await db.prepare(
    `SELECT
       d.friend_id,
       d.line_account_id AS draft_account_id,
       f.line_account_id AS friend_account_id
      FROM ai_faq_drafts d
      LEFT JOIN friends f ON f.id = d.friend_id
     WHERE d.id = ?`,
  ).bind(draftId).first<{
    friend_id: string | null;
    draft_account_id: string | null;
    friend_account_id: string | null;
  }>();
  if (!row?.friend_id || !row.friend_account_id) {
    throw new FaqDraftReviewError('下書きが見つかりません', 404);
  }
  if (
    row.friend_account_id !== accountId
    || (row.draft_account_id !== null && row.draft_account_id !== accountId)
  ) {
    throw new FaqDraftReviewError('下書きのLINEアカウントが一致しません', 403);
  }
  return row.friend_id;
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

function validateDraftScope(
  row: ReviewContextRow | null,
  expectedLineAccountId?: string,
): ReviewContextRow {
  if (!row) throw new FaqDraftReviewError('下書きが見つかりません', 404);
  if (expectedLineAccountId && row.friend_account_id !== expectedLineAccountId) {
    throw new FaqDraftReviewError('下書きのLINEアカウントが一致しません', 403);
  }
  if (row.line_account_id !== null && row.line_account_id !== row.friend_account_id) {
    throw new FaqDraftReviewError('下書きと友だちのLINEアカウントが一致しません', 409);
  }
  return row;
}

async function releaseClaim(
  db: D1Database,
  draftId: string,
  friendId: string,
  claimStatus: 'editing' | 'discarding' | 'sending',
): Promise<void> {
  await db.prepare(
    `UPDATE ai_faq_drafts SET status = 'pending', updated_at = ?
      WHERE id = ? AND friend_id = ? AND status = ?`,
  ).bind(jstNow(), draftId, friendId, claimStatus).run();
}

async function claimPending(
  db: D1Database,
  draftId: string,
  friendId: string,
  claimStatus: 'editing' | 'discarding' | 'sending',
  expectedLineAccountId?: string,
): Promise<ReviewContextRow> {
  const initial = validateDraftScope(
    await getReviewContext(db, draftId, friendId),
    expectedLineAccountId,
  );
  if (initial.status !== 'pending') {
    throw new FaqDraftReviewError('この下書きはすでに処理されています', 409);
  }
  const claimedAt = jstNow();
  const claim = expectedLineAccountId
    ? await db.prepare(
      `UPDATE ai_faq_drafts
          SET status = ?, updated_at = ?
        WHERE id = ? AND friend_id = ? AND status = 'pending'
          AND EXISTS (
            SELECT 1 FROM friends f
             WHERE f.id = ai_faq_drafts.friend_id AND f.line_account_id = ?
          )`,
    ).bind(claimStatus, claimedAt, draftId, friendId, expectedLineAccountId).run()
    : await db.prepare(
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
  try {
    return validateDraftScope(claimed, expectedLineAccountId);
  } catch (error) {
    // No external side effect has happened yet. Release this claim if the selected
    // account changed between the guarded UPDATE and the verification read.
    await releaseClaim(db, draftId, friendId, claimStatus);
    throw error;
  }
}

function auditStatement(
  db: D1Database,
  row: ReviewContextRow,
  actorStaffId: string,
  action: 'edited' | 'approved' | 'discarded' | 'send_failed',
  createdAt: string,
  guard?: { expectedLineAccountId: string; finalizedStatus: string },
) {
  const auditId = crypto.randomUUID();
  if (guard) {
    return db.prepare(
      `INSERT INTO ai_faq_draft_audit_log
         (id, draft_id, line_account_id, friend_id, actor_staff_id, action, created_at)
       SELECT ?, d.id, COALESCE(d.line_account_id, f.line_account_id), d.friend_id, ?, ?, ?
         FROM ai_faq_drafts d
         JOIN friends f ON f.id = d.friend_id
        WHERE d.id = ? AND d.friend_id = ? AND d.status = ? AND f.line_account_id = ?`,
    ).bind(
      auditId,
      actorStaffId,
      action,
      createdAt,
      row.id,
      row.friend_id,
      guard.finalizedStatus,
      guard.expectedLineAccountId,
    );
  }
  return db.prepare(
    `INSERT INTO ai_faq_draft_audit_log
       (id, draft_id, line_account_id, friend_id, actor_staff_id, action, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    auditId,
    row.id,
    row.line_account_id ?? row.friend_account_id,
    row.friend_id,
    actorStaffId,
    action,
    createdAt,
  );
}

async function finalizeLocalReview(input: {
  db: D1Database;
  row: ReviewContextRow;
  actorStaffId: string;
  action: 'edited' | 'discarded';
  claimStatus: 'editing' | 'discarding';
  finalizedStatus: 'pending' | 'discarded';
  finalizedAt: string;
  updateStatement: D1PreparedStatement;
  expectedLineAccountId?: string;
}): Promise<void> {
  let results: D1Result[];
  try {
    results = await input.db.batch([
      input.updateStatement,
      auditStatement(
        input.db,
        input.row,
        input.actorStaffId,
        input.action,
        input.finalizedAt,
        input.expectedLineAccountId
          ? {
            expectedLineAccountId: input.expectedLineAccountId,
            finalizedStatus: input.finalizedStatus,
          }
          : undefined,
      ),
    ]);
  } catch (error) {
    // Editing/discarding has no external side effect, so a failed DB finalization
    // can safely release its claim for a later retry.
    await releaseClaim(input.db, input.row.id, input.row.friend_id, input.claimStatus);
    throw error;
  }

  const updateChanges = results[0]?.meta.changes ?? 0;
  const auditChanges = results[1]?.meta.changes ?? 0;
  if (updateChanges === 1 && auditChanges === 1) return;

  if (updateChanges === 0) {
    await releaseClaim(input.db, input.row.id, input.row.friend_id, input.claimStatus);
    const current = await getReviewContext(input.db, input.row.id, input.row.friend_id);
    if (
      input.expectedLineAccountId
      && current?.friend_account_id !== input.expectedLineAccountId
    ) {
      throw new FaqDraftReviewError('下書きのLINEアカウントが一致しません', 403);
    }
    throw new FaqDraftReviewError('この下書きは別の操作で処理中です', 409);
  }

  throw new FaqDraftReviewError('下書きの監査記録を確認できません', 500);
}

export async function editAiFaqDraft(input: {
  db: D1Database;
  draftId: string;
  friendId: string;
  actorStaffId: string;
  draftAnswer: string;
  expectedLineAccountId?: string;
}): Promise<ReviewedDraft> {
  const answer = input.draftAnswer.trim();
  if (!answer || answer.length > 5_000) {
    throw new FaqDraftReviewError('下書き本文は1〜5000文字で入力してください', 400);
  }
  const claimed = await claimPending(
    input.db,
    input.draftId,
    input.friendId,
    'editing',
    input.expectedLineAccountId,
  );
  const now = jstNow();
  const updateStatement = input.expectedLineAccountId
    ? input.db.prepare(
      `UPDATE ai_faq_drafts
          SET draft_answer = ?, status = 'pending', updated_at = ?
        WHERE id = ? AND friend_id = ? AND status = 'editing'
          AND EXISTS (
            SELECT 1 FROM friends f
             WHERE f.id = ai_faq_drafts.friend_id AND f.line_account_id = ?
          )`,
    ).bind(answer, now, input.draftId, input.friendId, input.expectedLineAccountId)
    : input.db.prepare(
      `UPDATE ai_faq_drafts
          SET draft_answer = ?, status = 'pending', updated_at = ?
        WHERE id = ? AND friend_id = ? AND status = 'editing'`,
    ).bind(answer, now, input.draftId, input.friendId);
  await finalizeLocalReview({
    db: input.db,
    row: claimed,
    actorStaffId: input.actorStaffId,
    action: 'edited',
    claimStatus: 'editing',
    finalizedStatus: 'pending',
    finalizedAt: now,
    updateStatement,
    expectedLineAccountId: input.expectedLineAccountId,
  });
  return {
    ...serializeDraft(claimed),
    draftAnswer: answer,
    status: 'pending',
    updatedAt: now,
  };
}

export async function discardAiFaqDraft(input: {
  db: D1Database;
  draftId: string;
  friendId: string;
  actorStaffId: string;
  expectedLineAccountId?: string;
}): Promise<ReviewedDraft> {
  const claimed = await claimPending(
    input.db,
    input.draftId,
    input.friendId,
    'discarding',
    input.expectedLineAccountId,
  );
  const now = jstNow();
  const updateStatement = input.expectedLineAccountId
    ? input.db.prepare(
      `UPDATE ai_faq_drafts
          SET status = 'discarded', updated_at = ?
        WHERE id = ? AND friend_id = ? AND status = 'discarding'
          AND EXISTS (
            SELECT 1 FROM friends f
             WHERE f.id = ai_faq_drafts.friend_id AND f.line_account_id = ?
          )`,
    ).bind(now, input.draftId, input.friendId, input.expectedLineAccountId)
    : input.db.prepare(
      `UPDATE ai_faq_drafts
          SET status = 'discarded', updated_at = ?
        WHERE id = ? AND friend_id = ? AND status = 'discarding'`,
    ).bind(now, input.draftId, input.friendId);
  await finalizeLocalReview({
    db: input.db,
    row: claimed,
    actorStaffId: input.actorStaffId,
    action: 'discarded',
    claimStatus: 'discarding',
    finalizedStatus: 'discarded',
    finalizedAt: now,
    updateStatement,
    expectedLineAccountId: input.expectedLineAccountId,
  });
  return {
    ...serializeDraft(claimed),
    status: 'discarded',
    updatedAt: now,
  };
}

export async function approveAiFaqDraft(input: {
  db: D1Database;
  draftId: string;
  friendId: string;
  actorStaffId: string;
  expectedLineAccountId?: string;
}): Promise<{ draft: ReviewedDraft; message: {
  id: string;
  direction: 'outgoing';
  messageType: 'text';
  content: string;
  createdAt: string;
} }> {
  const initial = validateDraftScope(
    await getReviewContext(input.db, input.draftId, input.friendId),
    input.expectedLineAccountId,
  );
  if (
    !initial.friend_account_id
    || initial.account_is_active !== 1
    || !initial.channel_access_token
  ) {
    throw new FaqDraftReviewError('送信できるLINEアカウントが見つかりません', 409);
  }
  const claimed = await claimPending(
    input.db,
    input.draftId,
    input.friendId,
    'sending',
    input.expectedLineAccountId,
  );
  // Re-check after the CAS claim and use this row's answer. An edit cannot win after this point.
  if (
    !claimed.friend_account_id
    || claimed.account_is_active !== 1
    || !claimed.channel_access_token
  ) {
    await releaseClaim(input.db, input.draftId, input.friendId, 'sending');
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

  return {
    draft: {
      ...serializeDraft(claimed),
      status: 'approved',
      updatedAt: sentAt,
    },
    message: {
      id: messageId,
      direction: 'outgoing',
      messageType: 'text',
      content: claimed.draft_answer,
      createdAt: sentAt,
    },
  };
}
