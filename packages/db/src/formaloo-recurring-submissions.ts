import { jstNow } from './utils.js';

export type FormalooRecurringStatus = 'resumed' | 'paused' | 'cancelled';
export type FormalooRecurringSyncState = 'pending' | 'synced' | 'failed';

export interface FormalooRecurringSchedule {
  interval: Record<string, string>;
  start_time: string;
  end_time?: string | null;
}

export interface FormalooRecurringSubmissionMirror {
  id: string;
  formId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  remoteSlug: string | null;
  schedule: FormalooRecurringSchedule;
  submissionData: Record<string, unknown>;
  status: FormalooRecurringStatus;
  syncState: FormalooRecurringSyncState;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export class FormalooRecurringReservationUnavailableError extends Error {
  constructor() {
    super('Formaloo recurring reservation is unavailable for this provider');
    this.name = 'FormalooRecurringReservationUnavailableError';
  }
}

interface FormalooRecurringSubmissionRow {
  id: string;
  form_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  remote_slug: string | null;
  schedule_json: string;
  submission_data_json: string;
  status: FormalooRecurringStatus;
  sync_state: FormalooRecurringSyncState;
  last_error: string | null;
  operation_token: string | null;
  operation_lock_until: number | null;
  created_at: string;
  updated_at: string;
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function serialize(row: FormalooRecurringSubmissionRow): FormalooRecurringSubmissionMirror {
  return {
    id: row.id,
    formId: row.form_id,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    remoteSlug: row.remote_slug,
    schedule: parseRecord(row.schedule_json) as unknown as FormalooRecurringSchedule,
    submissionData: parseRecord(row.submission_data_json),
    status: row.status,
    syncState: row.sync_state,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getById(
  db: D1Database,
  id: string,
): Promise<FormalooRecurringSubmissionMirror | null> {
  const row = await db.prepare('SELECT * FROM formaloo_recurring_submissions WHERE id = ?')
    .bind(id).first<FormalooRecurringSubmissionRow>();
  return row ? serialize(row) : null;
}

export async function listFormalooRecurringSubmissions(
  db: D1Database,
  formId: string,
): Promise<FormalooRecurringSubmissionMirror[]> {
  const result = await db
    .prepare('SELECT * FROM formaloo_recurring_submissions WHERE form_id = ? ORDER BY created_at DESC, id DESC')
    .bind(formId)
    .all<FormalooRecurringSubmissionRow>();
  return result.results.map(serialize);
}

export async function getFormalooRecurringSubmissionByIdempotencyKey(
  db: D1Database,
  formId: string,
  idempotencyKey: string,
): Promise<FormalooRecurringSubmissionMirror | null> {
  const row = await db
    .prepare('SELECT * FROM formaloo_recurring_submissions WHERE form_id = ? AND idempotency_key = ?')
    .bind(formId, idempotencyKey)
    .first<FormalooRecurringSubmissionRow>();
  return row ? serialize(row) : null;
}

export async function getFormalooRecurringSubmissionByFingerprint(
  db: D1Database,
  formId: string,
  requestFingerprint: string,
): Promise<FormalooRecurringSubmissionMirror | null> {
  const row = await db
    .prepare(
      `SELECT * FROM formaloo_recurring_submissions
       WHERE form_id = ? AND request_fingerprint = ? AND status != 'cancelled'`,
    )
    .bind(formId, requestFingerprint)
    .first<FormalooRecurringSubmissionRow>();
  return row ? serialize(row) : null;
}

export async function hasBlockingFormalooRecurringSubmissions(
  db: D1Database,
  formId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS present FROM formaloo_recurring_submissions
       WHERE form_id = ? AND (status != 'cancelled' OR sync_state != 'synced')
       LIMIT 1`,
    )
    .bind(formId)
    .first<{ present: number }>();
  return row !== null;
}

export async function getFormalooRecurringSubmissionBySlug(
  db: D1Database,
  formId: string,
  remoteSlug: string,
): Promise<FormalooRecurringSubmissionMirror | null> {
  const row = await db
    .prepare('SELECT * FROM formaloo_recurring_submissions WHERE form_id = ? AND remote_slug = ?')
    .bind(formId, remoteSlug)
    .first<FormalooRecurringSubmissionRow>();
  return row ? serialize(row) : null;
}

export async function reserveFormalooRecurringSubmission(
  db: D1Database,
  input: {
    formId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    schedule: FormalooRecurringSchedule;
    submissionData: Record<string, unknown>;
    status: FormalooRecurringStatus;
  },
): Promise<FormalooRecurringSubmissionMirror> {
  const now = jstNow();
  await db.prepare(
    `INSERT OR IGNORE INTO formaloo_recurring_submissions
       (id, form_id, idempotency_key, request_fingerprint, schedule_json, submission_data_json, status,
        sync_state, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?
     WHERE EXISTS (
       SELECT 1 FROM formaloo_forms
       WHERE id = ? AND deleted = 0 AND render_backend = 'formaloo'
     )`,
  ).bind(
    `frs_${crypto.randomUUID()}`,
    input.formId,
    input.idempotencyKey,
    input.requestFingerprint,
    JSON.stringify(input.schedule),
    JSON.stringify(input.submissionData),
    input.status,
    now,
    now,
    input.formId,
  ).run();
  const row = await getFormalooRecurringSubmissionByIdempotencyKey(
    db,
    input.formId,
    input.idempotencyKey,
  ) ?? await getFormalooRecurringSubmissionByFingerprint(
    db,
    input.formId,
    input.requestFingerprint,
  );
  if (!row) throw new FormalooRecurringReservationUnavailableError();
  return row;
}

export async function claimFormalooRecurringSubmission(
  db: D1Database,
  id: string,
  input: { token: string; nowMs: number; leaseMs: number },
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE formaloo_recurring_submissions
     SET operation_token = ?, operation_lock_until = ?
     WHERE id = ? AND (
       operation_token IS NULL OR operation_lock_until IS NULL OR operation_lock_until <= ?
     )`,
  ).bind(input.token, input.nowMs + input.leaseMs, id, input.nowMs).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function releaseFormalooRecurringSubmissionClaim(
  db: D1Database,
  id: string,
  token: string,
): Promise<void> {
  await db.prepare(
    `UPDATE formaloo_recurring_submissions
     SET operation_token = NULL, operation_lock_until = NULL
     WHERE id = ? AND operation_token = ?`,
  ).bind(id, token).run();
}

export async function completeFormalooRecurringSubmission(
  db: D1Database,
  id: string,
  input: {
    token: string;
    remoteSlug: string;
    requestFingerprint: string;
    schedule: FormalooRecurringSchedule;
    submissionData: Record<string, unknown>;
    status: FormalooRecurringStatus;
  },
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE formaloo_recurring_submissions
     SET remote_slug = ?, request_fingerprint = ?, schedule_json = ?, submission_data_json = ?, status = ?,
         sync_state = 'synced', last_error = NULL,
         operation_token = NULL, operation_lock_until = NULL, updated_at = ?
     WHERE id = ? AND operation_token = ?`,
  ).bind(
    input.remoteSlug,
    input.requestFingerprint,
    JSON.stringify(input.schedule),
    JSON.stringify(input.submissionData),
    input.status,
    jstNow(),
    id,
    input.token,
  ).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function markFormalooRecurringSubmissionFailed(
  db: D1Database,
  id: string,
  input: { token: string; candidateSlug: string | null; error: string },
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE formaloo_recurring_submissions
     SET remote_slug = COALESCE(?, remote_slug), sync_state = 'failed', last_error = ?, updated_at = ?
     WHERE id = ? AND operation_token = ?`,
  ).bind(input.candidateSlug, input.error, jstNow(), id, input.token).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function refreshFormalooRecurringSubmission(
  db: D1Database,
  id: string,
): Promise<FormalooRecurringSubmissionMirror | null> {
  return getById(db, id);
}
