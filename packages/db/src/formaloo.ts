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
  gsheet_connected: number;
  gsheet_url: string | null;
  // migration 095 (F6-2): 表示スコープ + 作成先 workspace。
  line_account_id: string | null;  // NULL=全アカウント共通表示 (後方互換)
  workspace_id: string | null;     // NULL=既定=env 単一鍵 fallback (作成先 workspace 鍵)
  // migration 096 (F6-3): ハーネス側フォルダ分類 (NULL=未分類)。
  folder_id: string | null;
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
  // migration 098 (formaloo-auto-pull): drift 検知の別軸 (sync_status と直交)。既存行は既定値で後方互換。
  remote_definition_hash: string | null; // baseline fingerprint (NULL=未 bootstrap)
  pending_remote_hash: string | null;    // 通知中 drift の fingerprint (dedup キー)
  drift_status: string;                  // none|detected|applied|conflict
  drift_detected_at: string | null;      // 最新 drift 検知時刻 (JST ISO)
  remote_updated_at: string | null;      // optional: list timestamp フィルタ用
}

/** Formaloo 定義 drift の監査履歴行 (migration 098 / R5)。 */
export interface FormalooDriftEventRow {
  id: string;
  form_id: string;
  detected_at: string;
  action: string; // notified | auto_applied | conflict_held | bootstrapped
  remote_hash: string | null;
  prev_hash: string | null;
  has_warnings: number; // 1/0
  warnings_json: string | null;
  sync_status_at: string | null;
  detail: string | null;
  created_at: string;
}

export interface CreateFormalooFormInput {
  title: string;
  description?: string | null;
  onSubmitTagId?: string | null;
  onSubmitScenarioId?: string | null;
  submitMessage?: string | null;
  // F6-2: 表示スコープ + 作成先 workspace。workspaceId は route 側で §3.4 解決順序を経た確定値のみ渡す
  // (client body を無条件採用しない = server 権威 / Codex B#1)。未指定は両 NULL (env 鍵 / 共通表示)。
  lineAccountId?: string | null;
  workspaceId?: string | null;
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
          submit_count, deleted, builder_status, line_account_id, workspace_id, created_at, updated_at)
       VALUES (?, ?, ?, '{"fields":[],"logic":[]}', ?, ?, ?, 0, 0, 'draft', ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.title,
      input.description ?? null,
      input.onSubmitTagId ?? null,
      input.onSubmitScenarioId ?? null,
      input.submitMessage ?? null,
      input.lineAccountId ?? null,
      input.workspaceId ?? null,
      now,
      now,
    )
    .run();
  return (await getFormalooForm(db, id))!;
}

// ─── F6-2 作成先 workspace 解決 (server 権威 / account_binding 台帳) ──────────────

export interface FormalooAccountBinding {
  line_account_id: string;
  default_workspace_id: string | null;
  created_at: string;
  updated_at: string;
}

/** 登録済 かつ active な Formaloo workspace か (参照整合性 / 作成先の server 検証 / Codex M#4)。 */
export async function isActiveFormalooWorkspace(db: D1Database, workspaceId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS ok FROM formaloo_workspaces WHERE id = ? AND is_active = 1')
    .bind(workspaceId)
    .first<{ ok: number }>();
  return row != null;
}

/** account→既定 workspace の binding を全件取得 (owner-gated GET 用)。 */
export async function listFormalooAccountBindings(db: D1Database): Promise<FormalooAccountBinding[]> {
  const r = await db
    .prepare('SELECT * FROM formaloo_account_bindings ORDER BY line_account_id ASC')
    .all<FormalooAccountBinding>();
  return r.results;
}

export async function getFormalooAccountBinding(
  db: D1Database,
  lineAccountId: string,
): Promise<FormalooAccountBinding | null> {
  return db
    .prepare('SELECT * FROM formaloo_account_bindings WHERE line_account_id = ?')
    .bind(lineAccountId)
    .first<FormalooAccountBinding>();
}

/** account の既定 workspace を UPSERT (set)。default_workspace_id の active 検証は route 側の責務。 */
export async function upsertFormalooAccountBinding(
  db: D1Database,
  lineAccountId: string,
  defaultWorkspaceId: string | null,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO formaloo_account_bindings (line_account_id, default_workspace_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(line_account_id) DO UPDATE SET
         default_workspace_id = excluded.default_workspace_id,
         updated_at = excluded.updated_at`,
    )
    .bind(lineAccountId, defaultWorkspaceId, now, now)
    .run();
}

/** binding を削除 (clear)。 */
export async function clearFormalooAccountBinding(db: D1Database, lineAccountId: string): Promise<void> {
  await db.prepare('DELETE FROM formaloo_account_bindings WHERE line_account_id = ?').bind(lineAccountId).run();
}

/**
 * 作成時の既定 workspace を解決 (Codex M#7)。binding が指す workspace が **登録済 active のとき** だけ
 * default_workspace_id を返す。binding 無 / default NULL / 未登録 / 無効化 (is_active=0) は NULL に落とす
 * (無効な workspace を指す新規 form を最初から孤立させない・binding は cascade 消去しない)。
 */
export async function resolveDefaultWorkspace(
  db: D1Database,
  lineAccountId: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT b.default_workspace_id AS wid
       FROM formaloo_account_bindings b
       JOIN formaloo_workspaces w ON w.id = b.default_workspace_id AND w.is_active = 1
       WHERE b.line_account_id = ?`,
    )
    .bind(lineAccountId)
    .first<{ wid: string }>();
  return row?.wid ?? null;
}

/**
 * ④ workspace 自動紐付け: active workspace が正確に 1 件だけならその id を返す (0 件 or 2 件以上は NULL)。
 * キー登録前に作られた form (workspace_id=NULL) を「唯一の active workspace」へ曖昧さ無く自動採用するための解決。
 * 2 件以上は「どれに送るべきか」曖昧なので採用せず NULL (env fallback 維持 / 誤送信防止)。
 */
export async function resolveSoleActiveWorkspace(db: D1Database): Promise<string | null> {
  const r = await db
    .prepare('SELECT id FROM formaloo_workspaces WHERE is_active = 1 LIMIT 2')
    .all<{ id: string }>();
  return r.results.length === 1 ? r.results[0].id : null;
}

/** ④ form の作成先 workspace を再バインド (save 時 auto-adopt で NULL→唯一 active を D1 に確定)。 */
export async function setFormalooFormWorkspace(db: D1Database, id: string, workspaceId: string): Promise<void> {
  await db
    .prepare('UPDATE formaloo_forms SET workspace_id = ?, updated_at = ? WHERE id = ?')
    .bind(workspaceId, jstNow(), id)
    .run();
}

/** 未分類 (folder_id IS NULL) を絞る sentinel。実 folder id (`ff_*`) と衝突しない予約語 (F6-3 §3.3b / Codex M#4)。 */
export const FORM_FOLDER_UNFILED = 'none';

/**
 * 一覧取得。lineAccountId 指定時は「そのアカウントの form + 共通(line_account_id NULL)」だけに絞る
 * (F6-2 表示スコープ / broadcasts:152 getBroadcasts と同型)。無引数/undefined は従来通り全件 (後方互換 D-1)。
 * これは表示フィルタ (運用ミス防止) であってアクセス強制ではない (URL 直打ちは G2 依存 / N-17)。
 *
 * F6-3: folderId で account 絞りに folder 絞りを **重ねる** (直交 / §3.3b の 3 状態):
 *   - undefined       → folder では絞らない (全フォルダ + 未分類)。
 *   - 'none' sentinel → AND folder_id IS NULL (未分類のみ)。
 *   - 実 id           → AND folder_id = ? (その特定フォルダ)。
 */
export async function listFormalooForms(
  db: D1Database,
  lineAccountId?: string,
  folderId?: string,
): Promise<FormalooForm[]> {
  const where: string[] = ['deleted = 0'];
  const binds: unknown[] = [];
  if (lineAccountId) {
    where.push('(line_account_id = ? OR line_account_id IS NULL)');
    binds.push(lineAccountId);
  }
  if (folderId === FORM_FOLDER_UNFILED) {
    where.push('folder_id IS NULL');
  } else if (folderId !== undefined) {
    where.push('folder_id = ?');
    binds.push(folderId);
  }
  const sql = `SELECT * FROM formaloo_forms WHERE ${where.join(' AND ')} ORDER BY updated_at DESC`;
  const r = await db.prepare(sql).bind(...binds).all<FormalooForm>();
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
  params: {
    definitionJson: string;
    fields: SaveDefinitionField[];
    formalooSlug?: string | null;
    title?: string;
    description?: string | null;
  },
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
  if (params.title !== undefined) {
    sets.push('title = ?');
    vals.push(params.title);
  }
  if (params.description !== undefined) {
    sets.push('description = ?');
    vals.push(params.description);
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

/** Google Sheets 連携状態を記録 (T-E1 / regenerate-gsheet-data 成功時)。 */
export async function setFormalooGsheetState(
  db: D1Database,
  id: string,
  params: { connected: boolean; url?: string | null },
): Promise<void> {
  await db
    .prepare('UPDATE formaloo_forms SET gsheet_connected = ?, gsheet_url = ?, updated_at = ? WHERE id = ?')
    .bind(params.connected ? 1 : 0, params.url ?? null, jstNow(), id)
    .run();
}

/** 論理削除 (N-11 tombstone)。 */
export async function softDeleteFormalooForm(db: D1Database, id: string): Promise<void> {
  const now = jstNow();
  await db
    .prepare('UPDATE formaloo_forms SET deleted = 1, updated_at = ? WHERE id = ?')
    .bind(now, id)
    .run();
}

/**
 * 同期状態を upsert。drift 系パラメータ (migration 098 / formaloo-auto-pull) は **additive で任意**:
 * key が渡された時だけ当該列を更新する (undefined は「触らない」= 既存値保持 / null は「明示クリア」を許可)。
 * drift key を一切渡さない既存呼出は byte-equivalent (drift 列は INSERT 時 DEFAULT / UPDATE 時無改変)。
 * last_pushed_at / last_pulled_at は従来どおり COALESCE (null で前回値を消さない)。
 */
export async function setFormalooSyncState(
  db: D1Database,
  formId: string,
  params: {
    syncStatus: string;
    lastError?: string | null;
    lastPushedAt?: string | null;
    lastPulledAt?: string | null;
    // ── migration 098 drift 追跡 (任意 / present-key で列を更新) ──
    remoteDefinitionHash?: string | null;
    pendingRemoteHash?: string | null;
    driftStatus?: string;
    driftDetectedAt?: string | null;
    remoteUpdatedAt?: string | null;
  },
): Promise<void> {
  const now = jstNow();
  const cols = ['form_id', 'sync_status', 'last_error', 'last_pushed_at', 'last_pulled_at', 'updated_at'];
  const vals: (string | number | null)[] = [
    formId,
    params.syncStatus,
    params.lastError ?? null,
    params.lastPushedAt ?? null,
    params.lastPulledAt ?? null,
    now,
  ];
  const updates = [
    'sync_status = excluded.sync_status',
    'last_error = excluded.last_error',
    'last_pushed_at = COALESCE(excluded.last_pushed_at, formaloo_sync_state.last_pushed_at)',
    'last_pulled_at = COALESCE(excluded.last_pulled_at, formaloo_sync_state.last_pulled_at)',
    'updated_at = excluded.updated_at',
  ];
  // present-key の drift 列だけを INSERT 列 + UPDATE SET に足す (explicit-null を保つため COALESCE を使わない)。
  const driftCols: [keyof typeof params, string][] = [
    ['remoteDefinitionHash', 'remote_definition_hash'],
    ['pendingRemoteHash', 'pending_remote_hash'],
    ['driftStatus', 'drift_status'],
    ['driftDetectedAt', 'drift_detected_at'],
    ['remoteUpdatedAt', 'remote_updated_at'],
  ];
  for (const [key, col] of driftCols) {
    if (key in params) {
      cols.push(col);
      vals.push((params[key] as string | null) ?? null);
      updates.push(`${col} = excluded.${col}`);
    }
  }
  const placeholders = cols.map(() => '?').join(', ');
  await db
    .prepare(
      `INSERT INTO formaloo_sync_state (${cols.join(', ')}) VALUES (${placeholders})
       ON CONFLICT(form_id) DO UPDATE SET ${updates.join(', ')}`,
    )
    .bind(...vals)
    .run();
}

/**
 * Formaloo 連携済み (formaloo_slug NOT NULL / deleted=0) の全 form を返す (drift-check 走査対象)。
 * push 済み (slug 確定) の form のみ = Formaloo 側に定義が存在する = drift 検知の対象。
 */
export async function listLinkedFormalooForms(db: D1Database): Promise<FormalooForm[]> {
  const r = await db
    .prepare('SELECT * FROM formaloo_forms WHERE formaloo_slug IS NOT NULL AND deleted = 0 ORDER BY updated_at DESC')
    .all<FormalooForm>();
  return r.results;
}

/** drift 監査履歴を 1 件記録 (R5 / de_ prefix)。detectedAt 未指定は jstNow。 */
export async function recordFormalooDriftEvent(
  db: D1Database,
  input: {
    formId: string;
    action: string;
    detectedAt?: string;
    remoteHash?: string | null;
    prevHash?: string | null;
    hasWarnings?: boolean;
    warningsJson?: string | null;
    syncStatusAt?: string | null;
    detail?: string | null;
  },
): Promise<void> {
  const id = `de_${crypto.randomUUID()}`;
  const detectedAt = input.detectedAt ?? jstNow();
  await db
    .prepare(
      `INSERT INTO formaloo_drift_events
         (id, form_id, detected_at, action, remote_hash, prev_hash, has_warnings, warnings_json, sync_status_at, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.formId,
      detectedAt,
      input.action,
      input.remoteHash ?? null,
      input.prevHash ?? null,
      input.hasWarnings ? 1 : 0,
      input.warningsJson ?? null,
      input.syncStatusAt ?? null,
      input.detail ?? null,
    )
    .run();
}

/** form の drift 監査履歴を新しい順に取得 (R5 / 履歴表示・監査)。 */
export async function listFormalooDriftEvents(
  db: D1Database,
  formId: string,
  limit = 50,
): Promise<FormalooDriftEventRow[]> {
  const r = await db
    .prepare(
      'SELECT * FROM formaloo_drift_events WHERE form_id = ? ORDER BY detected_at DESC, created_at DESC LIMIT ?',
    )
    .bind(formId, limit)
    .all<FormalooDriftEventRow>();
  return r.results;
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

// ─── F-4 データコックピット 保存フィルタ (migration 082) ──────────────────────

export interface FormalooSavedFilter {
  id: string;
  form_id: string;
  name: string;
  filter_json: string;
  created_at: string;
  updated_at: string;
}

export async function listFormalooSavedFilters(db: D1Database, formId: string): Promise<FormalooSavedFilter[]> {
  const r = await db
    .prepare('SELECT * FROM formaloo_saved_filters WHERE form_id = ? ORDER BY updated_at DESC')
    .bind(formId)
    .all<FormalooSavedFilter>();
  return r.results;
}

export async function createFormalooSavedFilter(
  db: D1Database,
  input: { formId: string; name: string; filterJson: string },
): Promise<FormalooSavedFilter> {
  const id = `ff_${crypto.randomUUID()}`;
  const now = jstNow();
  await db
    .prepare('INSERT INTO formaloo_saved_filters (id, form_id, name, filter_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, input.formId, input.name, input.filterJson, now, now)
    .run();
  return (await db.prepare('SELECT * FROM formaloo_saved_filters WHERE id = ?').bind(id).first<FormalooSavedFilter>())!;
}

/** form scope 越えの削除を防ぐため form_id も条件に含める (他フォームの保存フィルタを消せない)。 */
export async function deleteFormalooSavedFilter(db: D1Database, formId: string, id: string): Promise<void> {
  await db.prepare('DELETE FROM formaloo_saved_filters WHERE id = ? AND form_id = ?').bind(id, formId).run();
}

// ─── F-4 回答ミラー検索/統計 (migration 079 + 081) ───────────────────────────

export interface QueryFormalooSubmissionsParams {
  formId: string;
  /** answers_json / friend_id フリーワード (LIKE)。 */
  q?: string | null;
  /** 期間フィルタ (submitted_at / julianday 比較 M-4)。ISO8601。 */
  from?: string | null;
  to?: string | null;
  /** 並び順 (submitted_at のみ許可 = whitelist / SQL injection 防止)。 */
  sortDir?: 'asc' | 'desc';
  limit: number;
  offset: number;
}

/**
 * D1 ミラーに対する検索/フィルタ/ソート/ページング (T-D1)。
 * 期間は julianday 比較 (M-4)。sort は submitted_at のみ (列名を bind 不可のため whitelist で固定)。
 * 戻り値 total は同一フィルタの全件数 (ページング用)。
 */
export async function queryFormalooSubmissions(
  db: D1Database,
  params: QueryFormalooSubmissionsParams,
): Promise<{ rows: FormalooSubmissionRow[]; total: number }> {
  const where: string[] = ['form_id = ?'];
  const binds: unknown[] = [params.formId];
  if (params.q) {
    where.push('(answers_json LIKE ? OR IFNULL(friend_id, \'\') LIKE ?)');
    const like = `%${params.q}%`;
    binds.push(like, like);
  }
  if (params.from) {
    where.push('julianday(submitted_at) >= julianday(?)');
    binds.push(params.from);
  }
  if (params.to) {
    where.push('julianday(submitted_at) <= julianday(?)');
    binds.push(params.to);
  }
  const whereSql = where.join(' AND ');
  const dir = params.sortDir === 'asc' ? 'ASC' : 'DESC';

  const totalRow = await db.prepare(`SELECT COUNT(*) AS n FROM formaloo_submissions WHERE ${whereSql}`).bind(...binds).first<{ n: number }>();
  const rowsRes = await db
    .prepare(`SELECT * FROM formaloo_submissions WHERE ${whereSql} ORDER BY submitted_at ${dir} LIMIT ? OFFSET ?`)
    .bind(...binds, params.limit, params.offset)
    .all<FormalooSubmissionRow>();
  return { rows: rowsRes.results, total: totalRow?.n ?? 0 };
}

/** 期間別の日次集計 (統計カード用 / T-D2)。JST 日付でグルーピング。 */
export async function formalooSubmissionsDailyCounts(
  db: D1Database,
  formId: string,
): Promise<{ day: string; count: number }[]> {
  const r = await db
    .prepare(
      `SELECT substr(submitted_at, 1, 10) AS day, COUNT(*) AS count
       FROM formaloo_submissions WHERE form_id = ?
       GROUP BY day ORDER BY day ASC`,
    )
    .bind(formId)
    .all<{ day: string; count: number }>();
  return r.results;
}

/** owner-gated 一括削除 (T-D2 / N-9)。form scope に閉じ、指定 id 群のみ削除。戻り値=削除件数。 */
export async function bulkDeleteFormalooSubmissions(db: D1Database, formId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const res = await db
    .prepare(`DELETE FROM formaloo_submissions WHERE form_id = ? AND id IN (${placeholders})`)
    .bind(formId, ...ids)
    .run();
  return (res as { meta?: { changes?: number } }).meta?.changes ?? 0;
}
