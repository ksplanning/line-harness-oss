import { jstNow } from './utils.js';

// =============================================================================
// Formaloo 高機能フォーム D1 台帳/ミラー helper (F-2 / migration 079-080)
// -----------------------------------------------------------------------------
// SoT (§4): Formaloo = 定義の権威。D1 は表示用キャッシュ + マッピング台帳 + 同期状態。
// builder の保存は「定義全体」を渡す前提 → field_map は delete+insert で全置換相当。
// feature 検証や logic マッピングは shared (formaloo-forms) / worker 層。ここは純 CRUD。
// =============================================================================

export interface FormalooForm {
  id: string;
  formaloo_slug: string | null;
  title: string;
  description: string | null;
  definition_json: string;
  on_submit_tag_id: string | null;
  on_submit_scenario_id: string | null;
  submit_message: string | null;
  submit_count: number;
  deleted: number;
  builder_status: string;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FormalooFieldMapRow {
  id: string;
  form_id: string;
  formaloo_field_slug: string | null;
  field_type: string;
  label: string;
  position: number;
  config_json: string;
  created_at: string;
  updated_at: string;
}

export interface FormalooSyncState {
  form_id: string;
  last_pushed_at: string | null;
  last_pulled_at: string | null;
  sync_status: string;
  last_error: string | null;
  updated_at: string;
}

export interface CreateFormalooFormInput {
  title: string;
  description?: string | null;
  onSubmitTagId?: string | null;
  onSubmitScenarioId?: string | null;
  submitMessage?: string | null;
}

export async function createFormalooForm(
  db: D1Database,
  input: CreateFormalooFormInput,
): Promise<FormalooForm> {
  const id = `fa_${crypto.randomUUID()}`;
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO formaloo_forms
         (id, title, description, definition_json, on_submit_tag_id, on_submit_scenario_id, submit_message,
          submit_count, deleted, builder_status, created_at, updated_at)
       VALUES (?, ?, ?, '{"fields":[],"logic":[]}', ?, ?, ?, 0, 0, 'draft', ?, ?)`,
    )
    .bind(
      id,
      input.title,
      input.description ?? null,
      input.onSubmitTagId ?? null,
      input.onSubmitScenarioId ?? null,
      input.submitMessage ?? null,
      now,
      now,
    )
    .run();
  return (await getFormalooForm(db, id))!;
}

export async function listFormalooForms(db: D1Database): Promise<FormalooForm[]> {
  const r = await db
    .prepare('SELECT * FROM formaloo_forms WHERE deleted = 0 ORDER BY updated_at DESC')
    .all<FormalooForm>();
  return r.results;
}

export async function getFormalooForm(db: D1Database, id: string): Promise<FormalooForm | null> {
  return db.prepare('SELECT * FROM formaloo_forms WHERE id = ?').bind(id).first<FormalooForm>();
}

export async function getFormalooFieldMap(
  db: D1Database,
  formId: string,
): Promise<FormalooFieldMapRow[]> {
  const r = await db
    .prepare('SELECT * FROM formaloo_field_map WHERE form_id = ? ORDER BY position ASC')
    .bind(formId)
    .all<FormalooFieldMapRow>();
  return r.results;
}

export interface SaveDefinitionField {
  id: string;
  formalooFieldSlug?: string | null;
  fieldType: string;
  label: string;
  position: number;
  configJson: string;
}

/**
 * builder が保存する定義全体を D1 に反映。field_map は全置換 (delete+insert)。
 * definition_json は表示用キャッシュ (fields+logic のスナップショット)。formalooSlug は push 後に確定。
 */
export async function saveFormalooDefinition(
  db: D1Database,
  id: string,
  params: { definitionJson: string; fields: SaveDefinitionField[]; formalooSlug?: string | null },
): Promise<void> {
  const now = jstNow();
  await db.prepare('DELETE FROM formaloo_field_map WHERE form_id = ?').bind(id).run();
  for (const f of params.fields) {
    await db
      .prepare(
        `INSERT INTO formaloo_field_map
           (id, form_id, formaloo_field_slug, field_type, label, position, config_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(f.id, id, f.formalooFieldSlug ?? null, f.fieldType, f.label, f.position, f.configJson, now, now)
      .run();
  }
  const sets: string[] = ['definition_json = ?', 'updated_at = ?'];
  const vals: (string | number | null)[] = [params.definitionJson, now];
  if (params.formalooSlug !== undefined) {
    sets.push('formaloo_slug = ?');
    vals.push(params.formalooSlug);
  }
  vals.push(id);
  await db.prepare(`UPDATE formaloo_forms SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
}

/** publish gate 遷移。published にする時は publishedAt を記録 (未指定なら jstNow)。 */
export async function updateFormalooBuilderStatus(
  db: D1Database,
  id: string,
  status: string,
  publishedAt?: string | null,
): Promise<void> {
  const now = jstNow();
  if (status === 'published') {
    const pub = publishedAt ?? now;
    await db
      .prepare(
        `UPDATE formaloo_forms
           SET builder_status = ?, published_at = COALESCE(published_at, ?), updated_at = ?
         WHERE id = ?`,
      )
      .bind(status, pub, now, id)
      .run();
  } else {
    await db
      .prepare('UPDATE formaloo_forms SET builder_status = ?, updated_at = ? WHERE id = ?')
      .bind(status, now, id)
      .run();
  }
}

/** 論理削除 (N-11 tombstone)。 */
export async function softDeleteFormalooForm(db: D1Database, id: string): Promise<void> {
  const now = jstNow();
  await db
    .prepare('UPDATE formaloo_forms SET deleted = 1, updated_at = ? WHERE id = ?')
    .bind(now, id)
    .run();
}

export async function setFormalooSyncState(
  db: D1Database,
  formId: string,
  params: { syncStatus: string; lastError?: string | null; lastPushedAt?: string | null; lastPulledAt?: string | null },
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO formaloo_sync_state (form_id, sync_status, last_error, last_pushed_at, last_pulled_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(form_id) DO UPDATE SET
         sync_status = excluded.sync_status,
         last_error = excluded.last_error,
         last_pushed_at = COALESCE(excluded.last_pushed_at, formaloo_sync_state.last_pushed_at),
         last_pulled_at = COALESCE(excluded.last_pulled_at, formaloo_sync_state.last_pulled_at),
         updated_at = excluded.updated_at`,
    )
    .bind(formId, params.syncStatus, params.lastError ?? null, params.lastPushedAt ?? null, params.lastPulledAt ?? null, now)
    .run();
}

export async function getFormalooSyncState(
  db: D1Database,
  formId: string,
): Promise<FormalooSyncState | null> {
  return db
    .prepare('SELECT * FROM formaloo_sync_state WHERE form_id = ?')
    .bind(formId)
    .first<FormalooSyncState>();
}

// ─── F-3 回答データ経路 (migration 081) ──────────────────────────────────────

export interface FormalooSubmissionRow {
  id: string;
  form_id: string;
  formaloo_slug: string | null;
  friend_id: string | null;
  answers_json: string;
  submitted_at: string;
  synced_at: string;
  line_processed: number;
  verified: number;
}

/** webhook 経路: formaloo_slug から台帳を引く (回答をどの harness form に紐付けるか)。 */
export async function getFormalooFormBySlug(db: D1Database, slug: string): Promise<FormalooForm | null> {
  return db.prepare('SELECT * FROM formaloo_forms WHERE formaloo_slug = ? AND deleted = 0').bind(slug).first<FormalooForm>();
}

export interface UpsertFormalooSubmissionInput {
  id: string;
  formId: string;
  formalooSlug?: string | null;
  friendId?: string | null;
  answersJson: string;
  submittedAt: string;
  verified?: boolean;
}

/**
 * 回答ミラーへ冪等 upsert。PK=submission id で dedup (N-3・順序非依存)。
 * verified は 0→1 の一方向のみ (MAX で再送が verified を落とさない)。answers/friend/時刻は最新で更新。
 * 「LINE 後処理を 1 回だけ」は本 upsert ではなく claimFormalooLineProcessing (line_processed の atomic claim) が担保する。
 */
export async function upsertFormalooSubmission(
  db: D1Database,
  input: UpsertFormalooSubmissionInput,
): Promise<void> {
  const now = jstNow();
  const v = input.verified ? 1 : 0;
  await db
    .prepare(
      `INSERT INTO formaloo_submissions (id, form_id, formaloo_slug, friend_id, answers_json, submitted_at, synced_at, line_processed, verified)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(id) DO UPDATE SET
         answers_json = excluded.answers_json,
         friend_id    = COALESCE(excluded.friend_id, formaloo_submissions.friend_id),
         submitted_at = excluded.submitted_at,
         synced_at    = excluded.synced_at,
         verified     = MAX(formaloo_submissions.verified, excluded.verified)`,
    )
    .bind(input.id, input.formId, input.formalooSlug ?? null, input.friendId ?? null, input.answersJson, input.submittedAt, now, v)
    .run();
}

/**
 * LINE 後処理の atomic claim。line_processed 0→1 に更新でき、changes=1 のときだけ true。
 * 再送・並行でも 1 回だけ true になる (N-3 二重発火防止の要)。
 */
export async function claimFormalooLineProcessing(db: D1Database, submissionId: string): Promise<boolean> {
  const res = await db
    .prepare('UPDATE formaloo_submissions SET line_processed = 1 WHERE id = ? AND line_processed = 0')
    .bind(submissionId)
    .run();
  return ((res as { meta?: { changes?: number } }).meta?.changes ?? 0) === 1;
}

/** 未署名隔離を解除 (署名検証 or pull-verify 成功時に verified=1)。 */
export async function markFormalooSubmissionVerified(db: D1Database, submissionId: string): Promise<void> {
  await db.prepare('UPDATE formaloo_submissions SET verified = 1 WHERE id = ?').bind(submissionId).run();
}

/** 台帳の回答数カウンタを +1 (post-processing 発火時のみ = 冪等の可視化)。 */
export async function incrementFormalooSubmitCount(db: D1Database, formId: string): Promise<void> {
  await db
    .prepare('UPDATE formaloo_forms SET submit_count = submit_count + 1, updated_at = ? WHERE id = ?')
    .bind(jstNow(), formId)
    .run();
}

export async function getFormalooSubmission(db: D1Database, id: string): Promise<FormalooSubmissionRow | null> {
  return db.prepare('SELECT * FROM formaloo_submissions WHERE id = ?').bind(id).first<FormalooSubmissionRow>();
}
