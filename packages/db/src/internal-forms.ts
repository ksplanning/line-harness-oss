import { jstNow } from './utils.js';
import type { SheetsSyncLeaseGuard } from './sheets-connections.js';

export type FormRenderBackend = 'formaloo' | 'internal';
export type InternalFormOriginChannel = 'line' | 'embed' | 'invalid';
export type InternalFormExternalEditSource = 'edit_link' | 'sheet';

export interface InternalFormExternalEditChange {
  fieldId: string;
  before: unknown;
  after: unknown;
}

export interface InternalFormSubmission {
  id: string;
  form_id: string;
  friend_id: string | null;
  answers_json: string;
  origin_channel: InternalFormOriginChannel;
  edit_version: number;
  external_edit_source: InternalFormExternalEditSource | null;
  external_edited_at: string | null;
  external_edit_approved_at: string | null;
  external_edit_changes_json: string | null;
  external_edit_notification_claimed_for_at: string | null;
  external_edit_notification_claimed_for_version: number | null;
  duplicate_reviewed_at: string | null;
  deleted_at: string | null;
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

export interface DeleteSoftDeletedInternalFormSubmissionLedgerEntriesInput {
  lineAccountId: string;
  connectionId: string;
  connectionVersion: number;
  formId: string;
  submissionIds: string[];
  lease: SheetsSyncLeaseGuard;
}

export interface FormResultsRowShiftLeaseInput {
  lineAccountId: string;
  connectionId: string;
  connectionVersion: number;
  formId: string;
  lease: SheetsSyncLeaseGuard;
}

export interface BeginFormResultsRowShiftInput extends FormResultsRowShiftLeaseInput {
  pendingUntil: string;
}

export interface CompleteFormResultsRowShiftInput extends FormResultsRowShiftLeaseInput {
  shiftedAt: string;
}

export interface FormResultsRowShiftFence {
  shiftedAt: string | null;
  pendingUntil: string | null;
}

export type UpdateInternalFormSubmissionAnswersResult =
  | { status: 'updated'; submission: InternalFormSubmission }
  | { status: 'conflict'; submission: InternalFormSubmission | null }
  | { status: 'revoked'; submission: InternalFormSubmission };

type UpdateInternalFormSubmissionAnswersInput = {
  formId: string;
  submissionId: string;
  expectedEditVersion: number;
  answers: Record<string, unknown>;
} & (
  | {
      // The calling route must enforce admin authentication/permission. The
      // stored JSON snapshot joins edit_version in the CAS because Sheets
      // write-back intentionally does not increment edit_version.
      authorization: 'admin';
      expectedAnswersJson: string;
      expectedDefinitionJson: string;
    }
  | {
      authorization: 'admin-origin';
      expectedEditLinkEpoch: number;
    }
  | {
      authorization?: 'edit-link';
      expectedEditLinkEpoch: number;
      previousAnswers: Record<string, unknown>;
    }
);

function parseAnswerSnapshot(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function externalEditChangesJson(
  beforeAnswers: Record<string, unknown>,
  afterAnswers: Record<string, unknown>,
): string | null {
  const fieldIds = new Set([
    ...Object.keys(beforeAnswers),
    ...Object.keys(afterAnswers),
  ]);
  const changes: InternalFormExternalEditChange[] = [];
  for (const fieldId of fieldIds) {
    const before = Object.prototype.hasOwnProperty.call(beforeAnswers, fieldId)
      ? beforeAnswers[fieldId]
      : null;
    const after = Object.prototype.hasOwnProperty.call(afterAnswers, fieldId)
      ? afterAnswers[fieldId]
      : null;
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    changes.push({ fieldId, before, after });
  }
  return changes.length > 0 ? JSON.stringify(changes) : null;
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
       WHERE (SELECT COUNT(*) FROM internal_form_submissions
              WHERE form_id = ? AND deleted_at IS NULL) < ?`,
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
  if (((result as { meta?: { changes?: number } }).meta?.changes ?? 0) < 1) return null;
  return getInternalFormSubmission(db, input.formId, id);
}

type PublishedInternalFormSubmissionInput = {
  formId: string;
  definitionJson: string;
  friendId?: string | null;
  answers: Record<string, unknown>;
  originChannel?: InternalFormOriginChannel;
  maxSubmissions?: number;
  submitStartTime: string | null;
  submitEndTime: string | null;
  submittedAt?: string;
  deduplicationVolatileAnswerFragments?: readonly string[];
};

export type DeduplicatedInternalFormSubmissionResult =
  | { status: 'created'; submission: InternalFormSubmission }
  | { status: 'deduplicated'; submission: InternalFormSubmission }
  | { status: 'guard_unavailable' };

type RapidDuplicateAnswerMatch = {
  sql: string;
  binding: string;
};

function utf8Hex(value: string): string {
  return [...new TextEncoder().encode(value)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function rapidDuplicateAnswerMatch(
  answersJson: string,
  volatileFragments: readonly string[] | undefined,
): RapidDuplicateAnswerMatch {
  if (!volatileFragments?.length) {
    return { sql: 'recent.answers_json = ?', binding: answersJson };
  }
  let cursor = 0;
  let hexGlob = '';
  for (const fragment of volatileFragments) {
    if (fragment.length === 0) {
      return { sql: 'recent.answers_json = ?', binding: answersJson };
    }
    const index = answersJson.indexOf(fragment, cursor);
    if (index < 0) {
      return { sql: 'recent.answers_json = ?', binding: answersJson };
    }
    hexGlob += `${utf8Hex(answersJson.slice(cursor, index))}*`;
    cursor = index + fragment.length;
  }
  hexGlob += utf8Hex(answersJson.slice(cursor));
  return { sql: 'hex(recent.answers_json) GLOB ?', binding: hexGlob };
}

function insertedInternalFormSubmission(
  input: PublishedInternalFormSubmissionInput,
  id: string,
  answersJson: string,
  now: string,
): InternalFormSubmission {
  return {
    id,
    form_id: input.formId,
    friend_id: input.friendId ?? null,
    answers_json: answersJson,
    origin_channel: input.originChannel ?? 'embed',
    edit_version: 0,
    external_edit_source: null,
    external_edited_at: null,
    external_edit_approved_at: null,
    external_edit_changes_json: null,
    external_edit_notification_claimed_for_at: null,
    external_edit_notification_claimed_for_version: null,
    duplicate_reviewed_at: null,
    deleted_at: null,
    submitted_at: now,
    created_at: now,
  };
}

/**
 * Public-form insert gate. The definition and publish state are checked in the
 * same SQL statement as the INSERT, so an unpublish or edit that wins the race
 * cannot receive an answer rendered from an older definition.
 */
async function insertInternalFormSubmissionForPublishedDefinition(
  db: D1Database,
  input: PublishedInternalFormSubmissionInput,
  deduplicateWithinSeconds = 0,
): Promise<InternalFormSubmission | null> {
  const id = `ifs_${crypto.randomUUID()}`;
  const now = input.submittedAt ?? jstNow();
  const answersJson = JSON.stringify(input.answers);
  const limit = input.maxSubmissions === undefined
    ? null
    : Math.max(1, Math.trunc(input.maxSubmissions));
  const duplicateWindow = Number.isFinite(deduplicateWithinSeconds)
    ? Math.max(0, deduplicateWithinSeconds)
    : 0;
  const deduplicateFriendId = duplicateWindow > 0 ? input.friendId ?? null : null;
  const answerMatch = rapidDuplicateAnswerMatch(
    answersJson,
    input.deduplicationVolatileAnswerFragments,
  );
  const rapidDuplicateClause = deduplicateFriendId === null
    ? ''
    : ` AND NOT EXISTS ( /* rapid-submit-dedup */
         SELECT 1
         FROM internal_form_submissions recent
         WHERE recent.form_id = ?
           AND recent.friend_id = ?
           AND ${answerMatch.sql}
           AND recent.deleted_at IS NULL
           AND julianday(recent.submitted_at) >= julianday(?, '-' || ? || ' seconds')
           AND julianday(recent.submitted_at) <= julianday(?)
       )`;
  const rapidDuplicateBindings = deduplicateFriendId === null
    ? []
    : [input.formId, deduplicateFriendId, answerMatch.binding, now, duplicateWindow, now];
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
         SELECT COUNT(*) FROM internal_form_submissions
         WHERE form_id = ? AND deleted_at IS NULL
       ) < ?)
       AND (? IS NULL OR julianday(?) >= julianday(?))
       AND (? IS NULL OR julianday(?) < julianday(?))
       ${rapidDuplicateClause}`,
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
      ...rapidDuplicateBindings,
    )
    .run();
  if (((result as { meta?: { changes?: number } }).meta?.changes ?? 0) < 1) return null;
  return insertedInternalFormSubmission(input, id, answersJson, now);
}

export function createInternalFormSubmissionForPublishedDefinition(
  db: D1Database,
  input: PublishedInternalFormSubmissionInput,
): Promise<InternalFormSubmission | null> {
  return insertInternalFormSubmissionForPublishedDefinition(db, input);
}

async function findRapidDuplicateForPublishedDefinition(
  db: D1Database,
  input: PublishedInternalFormSubmissionInput,
  now: string,
  duplicateWindow: number,
): Promise<InternalFormSubmission | null> {
  const friendId = input.friendId ?? null;
  if (!friendId || duplicateWindow === 0) return null;
  const answersJson = JSON.stringify(input.answers);
  const answerMatch = rapidDuplicateAnswerMatch(
    answersJson,
    input.deduplicationVolatileAnswerFragments,
  );
  return db.prepare(
    `SELECT recent.*
     FROM internal_form_submissions recent
     WHERE recent.form_id = ?
       AND recent.friend_id = ?
       AND ${answerMatch.sql} /* rapid-submit-dedup-probe */
       AND recent.deleted_at IS NULL
       AND julianday(recent.submitted_at) >= julianday(?, '-' || ? || ' seconds')
       AND julianday(recent.submitted_at) <= julianday(?)
       AND EXISTS (
         SELECT 1 FROM formaloo_forms
         WHERE id = ? AND deleted = 0 AND render_backend = 'internal'
           AND builder_status = 'published' AND definition_json = ?
       )
       AND (? IS NULL OR julianday(?) >= julianday(?))
       AND (? IS NULL OR julianday(?) < julianday(?))
     ORDER BY julianday(recent.submitted_at) DESC, recent.rowid DESC
     LIMIT 1`,
  ).bind(
    input.formId,
    friendId,
    answerMatch.binding,
    now,
    duplicateWindow,
    now,
    input.formId,
    input.definitionJson,
    input.submitStartTime,
    now,
    input.submitStartTime,
    input.submitEndTime,
    now,
    input.submitEndTime,
  ).first<InternalFormSubmission>();
}

/**
 * Atomically suppress a rapid retry for a verified friend while preserving
 * anonymous submissions, changed answers, and retries outside the time window.
 */
export async function createInternalFormSubmissionForPublishedDefinitionDeduplicated(
  db: D1Database,
  input: PublishedInternalFormSubmissionInput & { deduplicateWithinSeconds: number },
): Promise<DeduplicatedInternalFormSubmissionResult | null> {
  const now = input.submittedAt ?? jstNow();
  const normalizedInput = { ...input, submittedAt: now };
  const friendId = input.friendId ?? null;
  const duplicateWindow = Number.isFinite(input.deduplicateWithinSeconds)
    ? Math.max(0, input.deduplicateWithinSeconds)
    : 0;
  if (friendId && duplicateWindow > 0) {
    try {
      await findRapidDuplicateForPublishedDefinition(
        db,
        normalizedInput,
        now,
        duplicateWindow,
      );
    } catch {
      return { status: 'guard_unavailable' };
    }
  }
  const created = await insertInternalFormSubmissionForPublishedDefinition(
    db,
    normalizedInput,
    input.deduplicateWithinSeconds,
  );
  if (created) return { status: 'created', submission: created };

  if (!friendId || duplicateWindow === 0) return null;
  const duplicate = await findRapidDuplicateForPublishedDefinition(
    db,
    normalizedInput,
    now,
    duplicateWindow,
  );
  return duplicate ? { status: 'deduplicated', submission: duplicate } : null;
}

export async function listInternalFormSubmissions(
  db: D1Database,
  formId: string,
  params: {
    limit: number;
    offset: number;
    externalEditReview?: 'pending';
  },
): Promise<{ rows: InternalFormSubmission[]; total: number }> {
  const limit = Math.max(1, Math.min(100, Math.trunc(params.limit)));
  const offset = Math.max(0, Math.trunc(params.offset));
  const reviewWhere = params.externalEditReview === 'pending'
    ? ` AND external_edit_source IS NOT NULL
        AND external_edit_approved_at IS NULL
        AND COALESCE(json_array_length(
          CASE WHEN json_valid(external_edit_changes_json)
            THEN external_edit_changes_json ELSE '[]' END
        ), 0) > 0`
    : '';
  const totalRow = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM internal_form_submissions
       WHERE form_id = ? AND deleted_at IS NULL${reviewWhere}`,
    )
    .bind(formId)
    .first<{ n: number }>();
  const rows = await db
    .prepare(
      `SELECT * FROM internal_form_submissions
       WHERE form_id = ? AND deleted_at IS NULL${reviewWhere}
       ORDER BY julianday(submitted_at) DESC, rowid DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(formId, limit, offset)
    .all<InternalFormSubmission>();
  return { rows: rows.results, total: totalRow?.n ?? 0 };
}

export async function listInternalFormSubmissionsForDuplicateReview(
  db: D1Database,
  formId: string,
): Promise<InternalFormSubmission[]> {
  const rows = await db
    .prepare(
      `SELECT * FROM internal_form_submissions
       WHERE form_id = ? AND deleted_at IS NULL
       ORDER BY julianday(submitted_at) DESC, rowid DESC`,
    )
    .bind(formId)
    .all<InternalFormSubmission>();
  return rows.results;
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
            submission.answers_json, submission.origin_channel, submission.edit_version,
            submission.external_edit_source, submission.external_edited_at,
            submission.external_edit_approved_at, submission.external_edit_changes_json,
            submission.deleted_at, submission.submitted_at, submission.created_at
     FROM internal_form_submissions submission
     LEFT JOIN friends friend
       ON friend.id = submission.friend_id AND friend.line_account_id = ?
     INNER JOIN formaloo_forms form
       ON form.id = submission.form_id
     WHERE submission.form_id = ?
       AND submission.deleted_at IS NULL
       AND (submission.friend_id IS NULL OR friend.id IS NOT NULL)
       AND form.deleted = 0 AND form.render_backend = 'internal'
       AND (form.line_account_id = ? OR form.line_account_id IS NULL)
       AND NOT EXISTS (
         SELECT 1
         FROM internal_form_submissions newer
         WHERE newer.form_id = submission.form_id
           AND newer.friend_id = submission.friend_id
           AND newer.deleted_at IS NULL
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
  const changesJson = externalEditChangesJson(
    parseAnswerSnapshot(input.expectedAnswersJson),
    input.answers,
  );
  const externalEditedAt = changesJson === null ? null : jstNow();
  const result = await db.prepare(
    `UPDATE internal_form_submissions
     SET answers_json = ?,
         external_edit_source = COALESCE(?, external_edit_source),
         external_edited_at = COALESCE(?, external_edited_at),
         external_edit_approved_at = CASE
           WHEN ? IS NULL THEN external_edit_approved_at ELSE NULL END,
         external_edit_changes_json = COALESCE(?, external_edit_changes_json)
     WHERE id = ? AND form_id = ? AND friend_id = ? AND answers_json = ?
       AND deleted_at IS NULL
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
           AND newer.deleted_at IS NULL
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
    changesJson === null ? null : 'sheet',
    externalEditedAt,
    changesJson,
    changesJson,
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
  return (result.meta.changes ?? 0) >= 1;
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
            submission.answers_json, submission.origin_channel, submission.edit_version,
            submission.external_edit_source, submission.external_edited_at,
            submission.external_edit_approved_at, submission.external_edit_changes_json,
            submission.deleted_at, submission.submitted_at, submission.created_at
     FROM internal_form_submissions submission
     LEFT JOIN friends friend
       ON friend.id = submission.friend_id AND friend.line_account_id = ?
     INNER JOIN formaloo_forms form
       ON form.id = submission.form_id
     WHERE submission.form_id = ?
       AND submission.deleted_at IS NULL
       AND (submission.friend_id IS NULL OR friend.id IS NOT NULL)
       AND form.deleted = 0 AND form.render_backend = 'internal'
       AND (form.line_account_id = ? OR form.line_account_id IS NULL)
     ORDER BY submission.submitted_at ASC, submission.id ASC`,
  ).bind(lineAccountId, formId, lineAccountId).all<InternalFormSubmission>();
  return rows.results;
}

export async function listSoftDeletedInternalFormSubmissionIdsForSheets(
  db: D1Database,
  lineAccountId: string,
  formId: string,
): Promise<string[]> {
  const rows = await db.prepare(
    `SELECT submission.id
     FROM internal_form_submissions submission
     INNER JOIN formaloo_forms form ON form.id = submission.form_id
     WHERE submission.form_id = ? AND submission.deleted_at IS NOT NULL
       AND form.deleted = 0 AND form.render_backend = 'internal'
       AND (form.line_account_id = ? OR form.line_account_id IS NULL)
     ORDER BY submission.id ASC`,
  ).bind(formId, lineAccountId).all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

export async function deleteSoftDeletedInternalFormSubmissionLedgerEntries(
  db: D1Database,
  input: DeleteSoftDeletedInternalFormSubmissionLedgerEntriesInput,
): Promise<boolean> {
  const submissionIds = [...new Set(input.submissionIds)];
  if (submissionIds.length === 0) return true;
  const result = await db.prepare(
    `DELETE FROM sheets_sync_ledger
     WHERE connection_id = ? AND connection_version = ?
       AND record_key IN (
         SELECT 'sub:' || CAST(value AS TEXT) FROM json_each(?)
       )
       AND EXISTS (
         SELECT 1 FROM internal_form_submissions submission
         WHERE submission.id = substr(sheets_sync_ledger.record_key, 5)
           AND submission.form_id = ? AND submission.deleted_at IS NOT NULL
       )
       AND EXISTS (
         SELECT 1 FROM sheets_connections connection
         WHERE connection.id = sheets_sync_ledger.connection_id
           AND connection.line_account_id = ? AND connection.form_id = ?
           AND connection.config_version = ? AND connection.form_results_enabled = 1
           AND connection.is_active = 1 AND connection.deleted_at IS NULL
           AND connection.sync_lock_token = ?
           AND connection.sync_lock_expires_at IS NOT NULL
           AND julianday(connection.sync_lock_expires_at) > julianday(?)
       )`,
  ).bind(
    input.connectionId,
    input.connectionVersion,
    JSON.stringify(submissionIds),
    input.formId,
    input.lineAccountId,
    input.formId,
    input.connectionVersion,
    input.lease.token,
    input.lease.now,
  ).run();
  return (result.meta.changes ?? 0) === submissionIds.length;
}

export async function beginFormResultsRowShift(
  db: D1Database,
  input: BeginFormResultsRowShiftInput,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE sheets_connections
     SET form_results_row_shifted_at = CASE
           WHEN form_results_row_shift_pending_until IS NOT NULL
             AND (
               form_results_row_shifted_at IS NULL
               OR julianday(form_results_row_shift_pending_until)
                  > julianday(form_results_row_shifted_at)
             )
             THEN form_results_row_shift_pending_until
           ELSE form_results_row_shifted_at
         END,
         form_results_row_shift_pending_until = ?
     WHERE id = ? AND line_account_id = ? AND form_id = ? AND config_version = ?
       AND form_results_enabled = 1 AND is_active = 1 AND deleted_at IS NULL
       AND sync_lock_token = ? AND sync_lock_expires_at IS NOT NULL
       AND julianday(sync_lock_expires_at) > julianday(?)`,
  ).bind(
    input.pendingUntil,
    input.connectionId,
    input.lineAccountId,
    input.formId,
    input.connectionVersion,
    input.lease.token,
    input.lease.now,
  ).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function completeFormResultsRowShift(
  db: D1Database,
  input: CompleteFormResultsRowShiftInput,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE sheets_connections
     SET form_results_row_shifted_at = CASE
           WHEN form_results_row_shifted_at IS NULL
             OR julianday(?) > julianday(form_results_row_shifted_at)
             THEN ?
           ELSE form_results_row_shifted_at
         END,
         form_results_row_shift_pending_until = NULL
     WHERE id = ? AND line_account_id = ? AND form_id = ? AND config_version = ?
       AND form_results_enabled = 1 AND is_active = 1 AND deleted_at IS NULL
       AND sync_lock_token = ? AND sync_lock_expires_at IS NOT NULL
       AND julianday(sync_lock_expires_at) > julianday(?)`,
  ).bind(
    input.shiftedAt,
    input.shiftedAt,
    input.connectionId,
    input.lineAccountId,
    input.formId,
    input.connectionVersion,
    input.lease.token,
    input.lease.now,
  ).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function cancelFormResultsRowShift(
  db: D1Database,
  input: FormResultsRowShiftLeaseInput,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE sheets_connections
     SET form_results_row_shift_pending_until = NULL
     WHERE id = ? AND line_account_id = ? AND form_id = ? AND config_version = ?
       AND form_results_enabled = 1 AND is_active = 1 AND deleted_at IS NULL
       AND sync_lock_token = ? AND sync_lock_expires_at IS NOT NULL
       AND julianday(sync_lock_expires_at) > julianday(?)`,
  ).bind(
    input.connectionId,
    input.lineAccountId,
    input.formId,
    input.connectionVersion,
    input.lease.token,
    input.lease.now,
  ).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function getFormResultsRowShiftFence(
  db: D1Database,
  lineAccountId: string,
  connectionId: string,
  connectionVersion: number,
): Promise<FormResultsRowShiftFence> {
  const row = await db.prepare(
    `SELECT form_results_row_shifted_at, form_results_row_shift_pending_until
     FROM sheets_connections
     WHERE id = ? AND line_account_id = ? AND config_version = ?
       AND is_active = 1 AND deleted_at IS NULL`,
  ).bind(connectionId, lineAccountId, connectionVersion).first<{
    form_results_row_shifted_at: string | null;
    form_results_row_shift_pending_until: string | null;
  }>();
  return {
    shiftedAt: row?.form_results_row_shifted_at ?? null,
    pendingUntil: row?.form_results_row_shift_pending_until ?? null,
  };
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
  const changesJson = externalEditChangesJson(
    parseAnswerSnapshot(input.expectedAnswersJson),
    input.answers,
  );
  const externalEditedAt = changesJson === null ? null : jstNow();
  const result = await db.prepare(
    `UPDATE internal_form_submissions
     SET answers_json = ?,
         external_edit_source = COALESCE(?, external_edit_source),
         external_edited_at = COALESCE(?, external_edited_at),
         external_edit_approved_at = CASE
           WHEN ? IS NULL THEN external_edit_approved_at ELSE NULL END,
         external_edit_changes_json = COALESCE(?, external_edit_changes_json)
     WHERE id = ? AND form_id = ? AND answers_json = ?
       AND deleted_at IS NULL
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
    changesJson === null ? null : 'sheet',
    externalEditedAt,
    changesJson,
    changesJson,
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
  return (result.meta.changes ?? 0) >= 1;
}

export async function getInternalFormSubmission(
  db: D1Database,
  formId: string,
  submissionId: string,
): Promise<InternalFormSubmission | null> {
  return db
    .prepare(
      'SELECT * FROM internal_form_submissions WHERE id = ? AND form_id = ? AND deleted_at IS NULL',
    )
    .bind(submissionId, formId)
    .first<InternalFormSubmission>();
}

export async function softDeleteInternalFormSubmission(
  db: D1Database,
  formId: string,
  submissionId: string,
  deletedAt = jstNow(),
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE internal_form_submissions
     SET deleted_at = ?
     WHERE id = ? AND form_id = ? AND deleted_at IS NULL
       AND EXISTS (
         SELECT 1 FROM formaloo_forms form
         WHERE form.id = internal_form_submissions.form_id
           AND form.deleted = 0 AND form.render_backend = 'internal'
       )`,
  ).bind(deletedAt, submissionId, formId).run();
  return (result.meta.changes ?? 0) >= 1;
}

export async function updateInternalFormSubmissionAnswers(
  db: D1Database,
  input: UpdateInternalFormSubmissionAnswersInput,
): Promise<UpdateInternalFormSubmissionAnswersResult> {
  const changesJson = input.authorization === undefined || input.authorization === 'edit-link'
    ? externalEditChangesJson(input.previousAnswers, input.answers)
    : null;
  const updated = input.authorization === 'admin'
    ? await db
        .prepare(
          `UPDATE internal_form_submissions
           SET answers_json = ?, edit_version = edit_version + 1
           WHERE id = ? AND form_id = ? AND edit_version = ? AND answers_json = ?
             AND deleted_at IS NULL
             AND EXISTS (
               SELECT 1
               FROM formaloo_forms AS form
               WHERE form.id = internal_form_submissions.form_id
                 AND form.deleted = 0
                 AND form.render_backend = 'internal'
                 AND form.allow_post_edit = 1
                 AND form.definition_json = ?
             )
           RETURNING *`,
        )
        .bind(
          JSON.stringify(input.answers),
          input.submissionId,
          input.formId,
          input.expectedEditVersion,
          input.expectedAnswersJson,
          input.expectedDefinitionJson,
        )
        .first<InternalFormSubmission>()
    : input.authorization === 'admin-origin'
      ? await db
          .prepare(
            `UPDATE internal_form_submissions
             SET answers_json = ?, edit_version = edit_version + 1
             WHERE id = ? AND form_id = ? AND edit_version = ?
               AND deleted_at IS NULL
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
          .first<InternalFormSubmission>()
    : await db
        .prepare(
          `UPDATE internal_form_submissions
           SET answers_json = ?,
               edit_version = edit_version + 1,
               external_edit_source = COALESCE(?, external_edit_source),
               external_edited_at = COALESCE(?, external_edited_at),
               external_edit_approved_at = CASE
                 WHEN ? IS NULL THEN external_edit_approved_at ELSE NULL END,
               external_edit_changes_json = COALESCE(?, external_edit_changes_json)
           WHERE id = ? AND form_id = ? AND edit_version = ?
             AND deleted_at IS NULL
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
          changesJson === null ? null : 'edit_link',
          changesJson === null ? null : jstNow(),
          changesJson,
          changesJson,
          input.submissionId,
          input.formId,
          input.expectedEditVersion,
          input.expectedEditLinkEpoch,
        )
        .first<InternalFormSubmission>();
  if (updated) return { status: 'updated', submission: updated };

  const submission = await getInternalFormSubmission(db, input.formId, input.submissionId);
  if (!submission) return { status: 'conflict', submission: null };
  if (input.authorization === 'admin') return { status: 'conflict', submission };
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

export async function claimInternalFormExternalEditNotification(
  db: D1Database,
  input: {
    formId: string;
    submissionId: string;
    externalEditedAt: string;
    expectedEditVersion: number;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE internal_form_submissions
       SET external_edit_notification_claimed_for_at = ?,
           external_edit_notification_claimed_for_version = ?
       WHERE id = ? AND form_id = ? AND deleted_at IS NULL
         AND external_edit_source = 'edit_link'
         AND external_edited_at = ?
         AND edit_version = ?
         AND (
           external_edit_notification_claimed_for_at IS NOT ?
           OR external_edit_notification_claimed_for_version IS NOT ?
         )
         AND COALESCE(json_array_length(
           CASE WHEN json_valid(external_edit_changes_json)
             THEN external_edit_changes_json ELSE '[]' END
         ), 0) > 0`,
    )
    .bind(
      input.externalEditedAt,
      input.expectedEditVersion,
      input.submissionId,
      input.formId,
      input.externalEditedAt,
      input.expectedEditVersion,
      input.externalEditedAt,
      input.expectedEditVersion,
    )
    .run();
  return (result.meta.changes ?? 0) === 1;
}

export async function countPendingInternalFormExternalEdits(
  db: D1Database,
  formId: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n
       FROM internal_form_submissions
       WHERE form_id = ? AND deleted_at IS NULL
         AND external_edit_source IS NOT NULL
         AND external_edit_approved_at IS NULL
         AND COALESCE(json_array_length(
           CASE WHEN json_valid(external_edit_changes_json)
             THEN external_edit_changes_json ELSE '[]' END
         ), 0) > 0`,
    )
    .bind(formId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function approveInternalFormSubmissionExternalEdit(
  db: D1Database,
  input: {
    formId: string;
    submissionId: string;
    expectedSource: InternalFormExternalEditSource | null;
    expectedEditedAt: string | null;
    expectedAnswersJson: string;
    approvedAt?: string;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE internal_form_submissions
       SET external_edit_approved_at = ?
       WHERE id = ? AND form_id = ? AND deleted_at IS NULL
         AND external_edit_source IS NOT NULL
         AND external_edit_approved_at IS NULL
         AND external_edit_source IS ?
         AND external_edited_at IS ?
         AND answers_json = ?`,
    )
    .bind(
      input.approvedAt ?? jstNow(),
      input.submissionId,
      input.formId,
      input.expectedSource,
      input.expectedEditedAt,
      input.expectedAnswersJson,
    )
    .run();
  return (result.meta.changes ?? 0) === 1;
}

export async function markInternalFormSubmissionDuplicateReviewed(
  db: D1Database,
  input: {
    formId: string;
    submissionId: string;
    expectedFriendId: string | null;
    expectedAnswersJson: string;
    expectedGeneration: number;
    expectedDefinitionJson: string;
    reviewedAt?: string;
  },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE internal_form_submissions
       SET duplicate_reviewed_at = ?
       WHERE id = ? AND form_id = ? AND deleted_at IS NULL
         AND duplicate_reviewed_at IS NULL
         AND friend_id IS ?
         AND answers_json = ?
         AND EXISTS (
           SELECT 1 FROM formaloo_forms form
           WHERE form.id = ?
             AND form.deleted = 0
             AND form.render_backend = 'internal'
             AND form.submission_duplicate_review_generation = ?
             AND form.definition_json = ?
         )`,
    )
    .bind(
      input.reviewedAt ?? jstNow(),
      input.submissionId,
      input.formId,
      input.expectedFriendId,
      input.expectedAnswersJson,
      input.formId,
      input.expectedGeneration,
      input.expectedDefinitionJson,
    )
    .run();
  return (result.meta.changes ?? 0) === 1;
}

export async function countInternalFormSubmissionsForForm(
  db: D1Database,
  formId: string,
): Promise<number> {
  const row = await db
    .prepare(
      'SELECT COUNT(*) AS n FROM internal_form_submissions WHERE form_id = ? AND deleted_at IS NULL',
    )
    .bind(formId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
