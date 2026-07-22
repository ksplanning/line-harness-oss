import { jstNow } from './utils.js';
import type { SheetsSyncLeaseGuard } from './sheets-connections.js';

export type FormRenderBackend = 'formaloo' | 'internal';
export type InternalFormOriginChannel = 'line' | 'embed' | 'invalid';

export interface InternalFormSubmission {
  id: string;
  form_id: string;
  friend_id: string | null;
  answers_json: string;
  origin_channel: InternalFormOriginChannel;
  edit_version: number;
  submitted_at: string;
  created_at: string;
}

export interface UpdateLatestInternalFormSubmissionAnswersForSheetsInput {
  lineAccountId: string;
  connectionId: string;
  connectionVersion: number;
  formId: string;
  friendId: string;
  submissionId: string;
  expectedAnswersJson: string;
  answers: Record<string, unknown>;
  lease: SheetsSyncLeaseGuard;
}

export interface UpdateInternalFormSubmissionAnswersForSheetsBySubmissionIdInput {
  lineAccountId: string;
  connectionId: string;
  connectionVersion: number;
  formId: string;
  submissionId: string;
  expectedAnswersJson: string;
  answers: Record<string, unknown>;
  lease: SheetsSyncLeaseGuard;
}

export type UpdateInternalFormSubmissionAnswersResult =
  | { status: 'updated'; submission: InternalFormSubmission }
  | { status: 'conflict'; submission: InternalFormSubmission | null }
  | { status: 'revoked'; submission: InternalFormSubmission };

export async function setFormRenderBackend(
  db: D1Database,
  formId: string,
  backend: FormRenderBackend,
): Promise<boolean> {
  const result = await db
    .prepare('UPDATE formaloo_forms SET render_backend = ?, updated_at = ? WHERE id = ? AND deleted = 0')
    .bind(backend, jstNow(), formId)
    .run();
  return ((result as { meta?: { changes?: number } }).meta?.changes ?? 0) === 1;
}

/**
 * Claim the Formaloo definition-save lane only while this form still uses
 * Formaloo. Provider switching checks the same sync row, so exactly one side
 * can win without holding a transaction across a network request.
 */
export async function beginFormalooDefinitionSave(
  db: D1Database,
  formId: string,
  expectedFormUpdatedAt: string,
  startedAt = jstNow(),
): Promise<boolean> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO formaloo_sync_state (form_id, sync_status, last_error, updated_at)
       SELECT ?, 'idle', NULL, ?
       WHERE EXISTS (
         SELECT 1 FROM formaloo_forms
         WHERE id = ? AND deleted = 0 AND render_backend = 'formaloo' AND updated_at = ?
       )`,
    )
    .bind(formId, startedAt, formId, expectedFormUpdatedAt)
    .run();
  const result = await db
    .prepare(
      `UPDATE formaloo_sync_state
       SET sync_status = 'pushing', last_error = NULL, updated_at = ?
       WHERE form_id = ? AND sync_status <> 'pushing'
         AND EXISTS (
           SELECT 1 FROM formaloo_forms
           WHERE id = ? AND deleted = 0 AND render_backend = 'formaloo' AND updated_at = ?
         )`,
    )
    .bind(startedAt, formId, formId, expectedFormUpdatedAt)
    .run();
  return ((result as { meta?: { changes?: number } }).meta?.changes ?? 0) === 1;
}

/** Switch provider and force draft, unless an in-flight Formaloo save owns the claim. */
export async function switchFormRenderBackendToDraft(
  db: D1Database,
  input: {
    formId: string;
    expectedBackend: FormRenderBackend;
    nextBackend: FormRenderBackend;
    expectedDefinitionJson: string;
    expectedUpdatedAt: string;
    updatedAt?: string;
    nowMs?: number;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE formaloo_forms
       SET render_backend = ?, builder_status = 'draft', updated_at = ?,
           formaloo_webhook_enabled = CASE WHEN ? = 'internal' THEN 0 ELSE formaloo_webhook_enabled END,
           formaloo_webhook_pull_processed_generation = CASE
             WHEN ? = 'internal' THEN formaloo_webhook_pull_generation
             ELSE formaloo_webhook_pull_processed_generation
           END
       WHERE id = ? AND deleted = 0 AND render_backend = ?
         AND definition_json = ? AND updated_at = ?
         AND (formaloo_webhook_lock_token IS NULL
           OR formaloo_webhook_lock_until IS NULL
           OR formaloo_webhook_lock_until <= ?)
         AND (formaloo_webhook_pull_lock_token IS NULL
           OR formaloo_webhook_pull_lock_until IS NULL
           OR formaloo_webhook_pull_lock_until <= ?)
         AND NOT EXISTS (
           SELECT 1 FROM formaloo_sync_state
           WHERE form_id = ? AND sync_status = 'pushing'
         )
         AND (? <> 'internal' OR NOT EXISTS (
           SELECT 1 FROM formaloo_recurring_submissions
           WHERE form_id = ? AND (status != 'cancelled' OR sync_state != 'synced')
         ))`,
    )
    .bind(
      input.nextBackend,
      input.updatedAt ?? jstNow(),
      input.nextBackend,
      input.nextBackend,
      input.formId,
      input.expectedBackend,
      input.expectedDefinitionJson,
      input.expectedUpdatedAt,
      input.nowMs ?? Date.now(),
      input.nowMs ?? Date.now(),
      input.formId,
      input.nextBackend,
      input.formId,
    )
    .run();
  return ((result as { meta?: { changes?: number } }).meta?.changes ?? 0) === 1;
}

/** Save an internal definition and return it to draft in the same row update. */
export async function saveInternalFormDefinition(
  db: D1Database,
  input: {
    formId: string;
    definitionJson: string;
    title: string;
    description: string | null;
    updatedAt?: string;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE formaloo_forms
       SET definition_json = ?, title = ?, description = ?, builder_status = 'draft', updated_at = ?
       WHERE id = ? AND deleted = 0 AND render_backend = 'internal'`,
    )
    .bind(
      input.definitionJson,
      input.title,
      input.description,
      input.updatedAt ?? jstNow(),
      input.formId,
    )
    .run();
  return ((result as { meta?: { changes?: number } }).meta?.changes ?? 0) === 1;
}

/** Publish compare-and-set for the exact internal form snapshot shown in confirmation. */
export async function publishInternalFormDefinition(
  db: D1Database,
  input: {
    formId: string;
    definitionJson: string;
    title: string | null;
    description: string | null;
    updatedAt: string;
    publishedAt?: string;
  },
): Promise<boolean> {
  const now = input.publishedAt ?? jstNow();
  const result = await db
    .prepare(
      `UPDATE formaloo_forms
       SET builder_status = 'published', published_at = COALESCE(published_at, ?), updated_at = ?
       WHERE id = ? AND deleted = 0 AND render_backend = 'internal'
         AND builder_status IN ('draft', 'in_review', 'published')
         AND definition_json = ?
         AND title IS ?
         AND description IS ?
         AND updated_at = ?`,
    )
    .bind(
      now,
      now,
      input.formId,
      input.definitionJson,
      input.title,
      input.description,
      input.updatedAt,
    )
    .run();
  return ((result as { meta?: { changes?: number } }).meta?.changes ?? 0) === 1;
}

/** Unpublish only the exact internal snapshot the operator was viewing. */
export async function unpublishInternalFormDefinition(
  db: D1Database,
  input: {
    formId: string;
    definitionJson: string;
    title: string | null;
    description: string | null;
    updatedAt: string;
    unpublishedAt?: string;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE formaloo_forms
       SET builder_status = 'draft', updated_at = ?
       WHERE id = ? AND deleted = 0 AND render_backend = 'internal'
         AND builder_status = 'published'
         AND definition_json = ?
         AND title IS ?
         AND description IS ?
         AND updated_at = ?`,
    )
    .bind(
      input.unpublishedAt ?? jstNow(),
      input.formId,
      input.definitionJson,
      input.title,
      input.description,
      input.updatedAt,
    )
    .run();
  return ((result as { meta?: { changes?: number } }).meta?.changes ?? 0) === 1;
}

export async function createInternalFormSubmission(
  db: D1Database,
  input: {
    formId: string;
    friendId?: string | null;
    answers: Record<string, unknown>;
    originChannel?: InternalFormOriginChannel;
    submittedAt?: string;
  },
): Promise<InternalFormSubmission> {
  const id = `ifs_${crypto.randomUUID()}`;
  const now = input.submittedAt ?? jstNow();
  await db
    .prepare(
      `INSERT INTO internal_form_submissions
         (id, form_id, friend_id, answers_json, origin_channel, submitted_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.formId,
      input.friendId ?? null,
      JSON.stringify(input.answers),
      input.originChannel ?? 'embed',
      now,
      now,
    )
    .run();
  return (await getInternalFormSubmission(db, input.formId, id))!;
}

/** A single SQL statement keeps the response-limit check and insert atomic. */
export async function createInternalFormSubmissionWithinLimit(
  db: D1Database,
  input: {
    formId: string;
    friendId?: string | null;
    answers: Record<string, unknown>;
    maxSubmissions: number;
    submittedAt?: string;
  },
): Promise<InternalFormSubmission | null> {
  const id = `ifs_${crypto.randomUUID()}`;
  const now = input.submittedAt ?? jstNow();
  const limit = Math.max(1, Math.trunc(input.maxSubmissions));
  const result = await db
    .prepare(
      `INSERT INTO internal_form_submissions
         (id, form_id, friend_id, answers_json, submitted_at, created_at)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM internal_form_submissions WHERE form_id = ?) < ?`,
    )
    .bind(
      id,
      input.formId,
      input.friendId ?? null,
      JSON.stringify(input.answers),
      now,
      now,
      input.formId,
      limit,
    )
    .run();
  if (((result as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) return null;
  return getInternalFormSubmission(db, input.formId, id);
}

/**
 * Public-form insert gate. The definition and publish state are checked in the
 * same SQL statement as the INSERT, so an unpublish or edit that wins the race
 * cannot receive an answer rendered from an older definition.
 */
export async function createInternalFormSubmissionForPublishedDefinition(
  db: D1Database,
  input: {
    formId: string;
    definitionJson: string;
    friendId?: string | null;
    answers: Record<string, unknown>;
    originChannel?: InternalFormOriginChannel;
    maxSubmissions?: number;
    submitStartTime: string | null;
    submitEndTime: string | null;
    submittedAt?: string;
  },
): Promise<InternalFormSubmission | null> {
  const id = `ifs_${crypto.randomUUID()}`;
  const now = input.submittedAt ?? jstNow();
  const answersJson = JSON.stringify(input.answers);
  const limit = input.maxSubmissions === undefined
    ? null
    : Math.max(1, Math.trunc(input.maxSubmissions));
  const result = await db
    .prepare(
      `INSERT INTO internal_form_submissions
         (id, form_id, friend_id, answers_json, origin_channel, submitted_at, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM formaloo_forms
         WHERE id = ? AND deleted = 0 AND render_backend = 'internal'
           AND builder_status = 'published' AND definition_json = ?
       )
       AND (? IS NULL OR (
         SELECT COUNT(*) FROM internal_form_submissions WHERE form_id = ?
       ) < ?)
       AND (? IS NULL OR julianday(?) >= julianday(?))
       AND (? IS NULL OR julianday(?) < julianday(?))`,
    )
    .bind(
      id,
      input.formId,
      input.friendId ?? null,
      answersJson,
      input.originChannel ?? 'embed',
      now,
      now,
      input.formId,
      input.definitionJson,
      limit,
      input.formId,
      limit,
      input.submitStartTime,
      now,
      input.submitStartTime,
      input.submitEndTime,
      now,
      input.submitEndTime,
    )
    .run();
  if (((result as { meta?: { changes?: number } }).meta?.changes ?? 0) !== 1) return null;
  return {
    id,
    form_id: input.formId,
    friend_id: input.friendId ?? null,
    answers_json: answersJson,
    origin_channel: input.originChannel ?? 'embed',
    edit_version: 0,
    submitted_at: now,
    created_at: now,
  };
}

export async function listInternalFormSubmissions(
  db: D1Database,
  formId: string,
  params: { limit: number; offset: number },
): Promise<{ rows: InternalFormSubmission[]; total: number }> {
  const limit = Math.max(1, Math.min(100, Math.trunc(params.limit)));
  const offset = Math.max(0, Math.trunc(params.offset));
  const totalRow = await db
    .prepare('SELECT COUNT(*) AS n FROM internal_form_submissions WHERE form_id = ?')
    .bind(formId)
    .first<{ n: number }>();
  const rows = await db
    .prepare(
      `SELECT * FROM internal_form_submissions
       WHERE form_id = ?
       ORDER BY julianday(submitted_at) DESC, rowid DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(formId, limit, offset)
    .all<InternalFormSubmission>();
  return { rows: rows.results, total: totalRow?.n ?? 0 };
}

/**
 * Returns every anonymous answer plus one verified internal answer per friend.
 * Friend-backed rows are tenant-verified; anonymous rows are scoped by the
 * requested form. Equal friend submission timestamps are resolved by SQLite
 * insertion order so repeated reads select the same row.
 */
export async function listLatestVerifiedInternalFormSubmissions(
  db: D1Database,
  lineAccountId: string,
  formId: string,
): Promise<InternalFormSubmission[]> {
  const rows = await db.prepare(
    `SELECT submission.id, submission.form_id, submission.friend_id,
            submission.answers_json, submission.submitted_at, submission.created_at
     FROM internal_form_submissions submission
     LEFT JOIN friends friend
       ON friend.id = submission.friend_id AND friend.line_account_id = ?
     INNER JOIN formaloo_forms form
       ON form.id = submission.form_id
     WHERE submission.form_id = ?
       AND (submission.friend_id IS NULL OR friend.id IS NOT NULL)
       AND form.deleted = 0 AND form.render_backend = 'internal'
       AND (form.line_account_id = ? OR form.line_account_id IS NULL)
       AND NOT EXISTS (
         SELECT 1
         FROM internal_form_submissions newer
         WHERE newer.form_id = submission.form_id
           AND newer.friend_id = submission.friend_id
           AND (
             julianday(newer.submitted_at) > julianday(submission.submitted_at)
             OR (
               julianday(newer.submitted_at) = julianday(submission.submitted_at)
               AND newer.rowid > submission.rowid
             )
           )
       )
     ORDER BY submission.friend_id ASC`,
  ).bind(lineAccountId, formId, lineAccountId).all<InternalFormSubmission>();
  return rows.results;
}

/**
 * Applies a Sheets edit to an existing answer using compare-and-swap. It never
 * inserts a partial submission and stops a stale sync worker after a re-answer,
 * settings change, tenant mismatch, or lost lease.
 */
export async function updateLatestInternalFormSubmissionAnswersForSheets(
  db: D1Database,
  input: UpdateLatestInternalFormSubmissionAnswersForSheetsInput,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE internal_form_submissions
     SET answers_json = ?
     WHERE id = ? AND form_id = ? AND friend_id = ? AND answers_json = ?
       AND EXISTS (
         SELECT 1 FROM friends friend
         WHERE friend.id = internal_form_submissions.friend_id
           AND friend.line_account_id = ?
       )
       AND EXISTS (
         SELECT 1 FROM formaloo_forms form
         WHERE form.id = internal_form_submissions.form_id
           AND form.deleted = 0 AND form.render_backend = 'internal'
           AND (form.line_account_id = ? OR form.line_account_id IS NULL)
       )
       AND NOT EXISTS (
         SELECT 1 FROM internal_form_submissions newer
         WHERE newer.form_id = internal_form_submissions.form_id
           AND newer.friend_id = internal_form_submissions.friend_id
           AND (
             julianday(newer.submitted_at) > julianday(internal_form_submissions.submitted_at)
             OR (
               julianday(newer.submitted_at) = julianday(internal_form_submissions.submitted_at)
               AND newer.rowid > internal_form_submissions.rowid
             )
           )
       )
       AND EXISTS (
         SELECT 1 FROM sheets_connections connection
         WHERE connection.id = ? AND connection.line_account_id = ?
           AND connection.form_id = internal_form_submissions.form_id
           AND connection.config_version = ? AND connection.friend_ledger_enabled = 1
           AND connection.is_active = 1 AND connection.deleted_at IS NULL
           AND connection.sync_lock_token = ?
           AND connection.sync_lock_expires_at IS NOT NULL
           AND julianday(connection.sync_lock_expires_at) > julianday(?)
       )`,
  ).bind(
    JSON.stringify(input.answers),
    input.submissionId,
    input.formId,
    input.friendId,
    input.expectedAnswersJson,
    input.lineAccountId,
    input.lineAccountId,
    input.connectionId,
    input.lineAccountId,
    input.connectionVersion,
    input.lease.token,
    input.lease.now,
  ).run();
  return (result.meta.changes ?? 0) === 1;
}

/**
 * Returns every tenant-owned or anonymous internal answer row of a form
 * (1 submission = 1 results-tab row). Friend-backed rows are tenant-verified;
 * anonymous rows are scoped by the form and connection. Ordering matches
 * SQLite binary order so a chunk cursor over (submitted_at, id) resumes
 * deterministically.
 */
export async function listVerifiedInternalFormSubmissionsForSheets(
  db: D1Database,
  lineAccountId: string,
  formId: string,
): Promise<InternalFormSubmission[]> {
  const rows = await db.prepare(
    `SELECT submission.id, submission.form_id, submission.friend_id,
            submission.answers_json, submission.submitted_at, submission.created_at
     FROM internal_form_submissions submission
     LEFT JOIN friends friend
       ON friend.id = submission.friend_id AND friend.line_account_id = ?
     INNER JOIN formaloo_forms form
       ON form.id = submission.form_id
     WHERE submission.form_id = ?
       AND (submission.friend_id IS NULL OR friend.id IS NOT NULL)
       AND form.deleted = 0 AND form.render_backend = 'internal'
       AND (form.line_account_id = ? OR form.line_account_id IS NULL)
     ORDER BY submission.submitted_at ASC, submission.id ASC`,
  ).bind(lineAccountId, formId, lineAccountId).all<InternalFormSubmission>();
  return rows.results;
}

/**
 * Applies a results-tab Sheets edit to one exact submission using
 * compare-and-swap on answers_json. Unlike the combined-sheet variant there is
 * deliberately NO newer-submission guard: the results tab keys 1 submission =
 * 1 row, so an older submission's row stays editable after a re-answer.
 * Gated on form_results_enabled and the connection lease.
 */
export async function updateInternalFormSubmissionAnswersForSheetsBySubmissionId(
  db: D1Database,
  input: UpdateInternalFormSubmissionAnswersForSheetsBySubmissionIdInput,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE internal_form_submissions
     SET answers_json = ?
     WHERE id = ? AND form_id = ? AND answers_json = ?
       AND (
         friend_id IS NULL
         OR EXISTS (
           SELECT 1 FROM friends friend
           WHERE friend.id = internal_form_submissions.friend_id
             AND friend.line_account_id = ?
         )
       )
       AND EXISTS (
         SELECT 1 FROM formaloo_forms form
         WHERE form.id = internal_form_submissions.form_id
           AND form.deleted = 0 AND form.render_backend = 'internal'
           AND (form.line_account_id = ? OR form.line_account_id IS NULL)
       )
       AND EXISTS (
         SELECT 1 FROM sheets_connections connection
         WHERE connection.id = ? AND connection.line_account_id = ?
           AND connection.form_id = internal_form_submissions.form_id
           AND connection.config_version = ? AND connection.form_results_enabled = 1
           AND connection.is_active = 1 AND connection.deleted_at IS NULL
           AND connection.sync_lock_token = ?
           AND connection.sync_lock_expires_at IS NOT NULL
           AND julianday(connection.sync_lock_expires_at) > julianday(?)
       )`,
  ).bind(
    JSON.stringify(input.answers),
    input.submissionId,
    input.formId,
    input.expectedAnswersJson,
    input.lineAccountId,
    input.lineAccountId,
    input.connectionId,
    input.lineAccountId,
    input.connectionVersion,
    input.lease.token,
    input.lease.now,
  ).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function getInternalFormSubmission(
  db: D1Database,
  formId: string,
  submissionId: string,
): Promise<InternalFormSubmission | null> {
  return db
    .prepare('SELECT * FROM internal_form_submissions WHERE id = ? AND form_id = ?')
    .bind(submissionId, formId)
    .first<InternalFormSubmission>();
}

export async function updateInternalFormSubmissionAnswers(
  db: D1Database,
  input: {
    formId: string;
    submissionId: string;
    expectedEditVersion: number;
    expectedEditLinkEpoch: number;
    answers: Record<string, unknown>;
  },
): Promise<UpdateInternalFormSubmissionAnswersResult> {
  const updated = await db
    .prepare(
      `UPDATE internal_form_submissions
       SET answers_json = ?, edit_version = edit_version + 1
       WHERE id = ? AND form_id = ? AND edit_version = ?
         AND EXISTS (
           SELECT 1
           FROM internal_form_notification_settings AS notification_settings
           WHERE notification_settings.form_id = internal_form_submissions.form_id
             AND notification_settings.edit_link_epoch = ?
         )
       RETURNING *`,
    )
    .bind(
      JSON.stringify(input.answers),
      input.submissionId,
      input.formId,
      input.expectedEditVersion,
      input.expectedEditLinkEpoch,
    )
    .first<InternalFormSubmission>();
  if (updated) return { status: 'updated', submission: updated };

  const submission = await getInternalFormSubmission(db, input.formId, input.submissionId);
  if (!submission) return { status: 'conflict', submission: null };
  const currentEpoch = await db
    .prepare('SELECT edit_link_epoch FROM internal_form_notification_settings WHERE form_id = ?')
    .bind(input.formId)
    .first<{ edit_link_epoch: number }>();
  if (!currentEpoch || currentEpoch.edit_link_epoch !== input.expectedEditLinkEpoch) {
    return { status: 'revoked', submission };
  }
  return {
    status: 'conflict',
    submission,
  };
}

export async function countInternalFormSubmissionsForForm(
  db: D1Database,
  formId: string,
): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM internal_form_submissions WHERE form_id = ?')
    .bind(formId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
