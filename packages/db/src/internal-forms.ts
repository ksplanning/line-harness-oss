import { jstNow } from './utils.js';

export type FormRenderBackend = 'formaloo' | 'internal';

export interface InternalFormSubmission {
  id: string;
  form_id: string;
  friend_id: string | null;
  answers_json: string;
  submitted_at: string;
  created_at: string;
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
