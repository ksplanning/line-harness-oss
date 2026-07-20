import { jstNow } from './utils.js';
import type { SheetsSyncLeaseGuard } from './sheets-connections.js';

export type FormRenderBackend = 'formaloo' | 'internal';

export interface InternalFormSubmission {
  id: string;
  form_id: string;
  friend_id: string | null;
  answers_json: string;
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

export async function createInternalFormSubmission(
  db: D1Database,
  input: {
    formId: string;
    friendId?: string | null;
    answers: Record<string, unknown>;
    submittedAt?: string;
  },
): Promise<InternalFormSubmission> {
  const id = `ifs_${crypto.randomUUID()}`;
  const now = input.submittedAt ?? jstNow();
  await db
    .prepare(
      `INSERT INTO internal_form_submissions
         (id, form_id, friend_id, answers_json, submitted_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.formId, input.friendId ?? null, JSON.stringify(input.answers), now, now)
    .run();
  return (await getInternalFormSubmission(db, input.formId, id))!;
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
 * Returns one verified internal answer row per friend. A friend join supplies
 * both identity verification and tenant scope; equal submission timestamps are
 * resolved by SQLite insertion order so repeated reads select the same row.
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
     INNER JOIN friends friend
       ON friend.id = submission.friend_id AND friend.line_account_id = ?
     INNER JOIN formaloo_forms form
       ON form.id = submission.form_id
     WHERE submission.form_id = ? AND submission.friend_id IS NOT NULL
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
