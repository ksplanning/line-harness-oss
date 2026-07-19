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
  // migration 099 (form-media-limits ③): 回答者による後編集を許可するか (0=不可 / 1=可)。既定 0=現状挙動。
  //   Formaloo 対応プロパティ不在 (soft-200 実証) ゆえ harness 側保存のみ・push しない。実効化は弾M。
  allow_post_edit: number;
  // migration 101 (form-edit-mail-link 弾L): 編集 URL メール送付をこのフォームで有効化するか (0=送らない / 1=送る)。
  //   既定 0=byte 同等 (機能 OFF)。allow_post_edit=1 と AND gate で発火 (メール発火は Phase B)。
  allow_edit_mail: number;
  // migration 101 (OD-3/G-1): 送付先 email 欄の明示指定 slug (代理入力/複数欄での第三者送信防止)。NULL=未指定。
  edit_mail_field_slug: string | null;
  // migration 101 (G-5): 編集 URL の失効世代。bump で当該 form の既発行 token を一括失効 (開封時 live gate が照合)。
  edit_link_epoch: number;
  // migration 103: Formaloo field slug/alias → friend.metadata key。[] = 未設定・完全 no-op。
  friend_metadata_mappings_json: string;
  // migration 106: form 単位の Formaloo outbound webhook。既定 OFF・read-back 成功後のみ enabled=1。
  formaloo_webhook_enabled: number;
  formaloo_webhook_id: string | null;
  formaloo_webhook_secret: string | null;
  formaloo_webhook_url: string | null;
  formaloo_webhook_lock_token: string | null;
  formaloo_webhook_lock_until: number | null;
  formaloo_webhook_pull_generation: number;
  formaloo_webhook_pull_processed_generation: number;
  formaloo_webhook_pull_lock_token: string | null;
  formaloo_webhook_pull_lock_until: number | null;
  formaloo_webhook_pull_not_before: number;
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
  // form-design-presets ② (create-time seed): 新規フォームの definition_json に埋める初期 design。
  //   デザイン未設定フォームが Formaloo 暗色デフォルト (#37352F 同色 = 入力欄不可視) に落ちる罠の根絶。
  //   ⚠️ shared の FormDesign 型を import しない (packages/db は dependencies 空 = shared 非依存を維持 / BLOCKING2)。
  //   DAO は「渡された object を JSON へ直列化するだけ」に留め、canonical 型は route/web 側が保持する。
  //   未指定 / 空 object は旧リテラルを byte 維持 (既存 caller 後方互換)。
  design?: Record<string, string | null | undefined>;
}

export async function createFormalooForm(
  db: D1Database,
  input: CreateFormalooFormInput,
): Promise<FormalooForm> {
  const id = `fa_${crypto.randomUUID()}`;
  const now = jstNow();
  // design が非空のときだけ definition に seed する。未指定 / 空 object は旧リテラルと byte 完全一致
  // (既存 caller = POST route + db test 群は無改変で従来挙動 / 既存 design=null フォーム不可触)。
  const definitionJson = input.design && Object.keys(input.design).length > 0
    ? JSON.stringify({ fields: [], logic: [], design: input.design })
    : '{"fields":[],"logic":[]}';
  await db
    .prepare(
      `INSERT INTO formaloo_forms
         (id, title, description, definition_json, on_submit_tag_id, on_submit_scenario_id, submit_message,
          submit_count, deleted, builder_status, line_account_id, workspace_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 'draft', ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.title,
      input.description ?? null,
      definitionJson,
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

/**
 * form 単位の remote webhook 操作を D1 の atomic UPDATE で直列化する。
 * 別 isolate の同時 PUT も1件だけが changes=1 になり、request 中断時は lease 満了後に回収できる。
 */
export async function acquireFormalooWebhookOperationLock(
  db: D1Database,
  formId: string,
  input: { token: string; nowMs: number; leaseMs: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE formaloo_forms
       SET formaloo_webhook_lock_token = ?,
           formaloo_webhook_lock_until = ?
       WHERE id = ?
         AND (formaloo_webhook_lock_token IS NULL
           OR formaloo_webhook_lock_until IS NULL
           OR formaloo_webhook_lock_until <= ?)`,
    )
    .bind(input.token, input.nowMs + input.leaseMs, formId, input.nowMs)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

/** owner token が一致する request だけが lock を解除できる。 */
export async function releaseFormalooWebhookOperationLock(
  db: D1Database,
  formId: string,
  token: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE formaloo_forms
       SET formaloo_webhook_lock_token = NULL,
           formaloo_webhook_lock_until = NULL
       WHERE id = ? AND formaloo_webhook_lock_token = ?`,
    )
    .bind(formId, token)
    .run();
}

/** 期限内の owner だけが lease を延長できる（期限切れ token の復活は禁止）。 */
export async function renewFormalooWebhookOperationLock(
  db: D1Database,
  formId: string,
  input: { token: string; nowMs: number; leaseMs: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE formaloo_forms
       SET formaloo_webhook_lock_until = ?
       WHERE id = ?
         AND formaloo_webhook_lock_token = ?
         AND formaloo_webhook_lock_until > ?`,
    )
    .bind(input.nowMs + input.leaseMs, formId, input.token, input.nowMs)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

/** callback 1件を durable generation として記録する。OFF/deleted は dirty 化しない。 */
export async function markFormalooWebhookPullPending(
  db: D1Database,
  formId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE formaloo_forms
       SET formaloo_webhook_pull_generation = formaloo_webhook_pull_generation + 1
       WHERE id = ? AND deleted = 0 AND formaloo_webhook_enabled = 1`,
    )
    .bind(formId)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

export type FormalooWebhookPullClaim =
  | { claimed: true; generation: number }
  | { claimed: false; pending: boolean; retryAt: number };

/**
 * pending generation を form-global に1 worker だけが claim する。
 * not_before が pull 開始頻度の上限、lease が中断 worker の回収境界になる。
 */
export async function claimFormalooWebhookPull(
  db: D1Database,
  formId: string,
  input: { token: string; nowMs: number; leaseMs: number; cooldownMs: number },
): Promise<FormalooWebhookPullClaim> {
  const claimed = await db
    .prepare(
      `UPDATE formaloo_forms
       SET formaloo_webhook_pull_lock_token = ?,
           formaloo_webhook_pull_lock_until = ?,
           formaloo_webhook_pull_not_before = ?
       WHERE id = ?
         AND deleted = 0
         AND formaloo_webhook_enabled = 1
         AND formaloo_webhook_pull_generation > formaloo_webhook_pull_processed_generation
         AND formaloo_webhook_pull_not_before <= ?
         AND (formaloo_webhook_pull_lock_token IS NULL
           OR formaloo_webhook_pull_lock_until IS NULL
           OR formaloo_webhook_pull_lock_until <= ?)
       RETURNING formaloo_webhook_pull_generation AS generation`,
    )
    .bind(
      input.token,
      input.nowMs + input.leaseMs,
      input.nowMs + input.cooldownMs,
      formId,
      input.nowMs,
      input.nowMs,
    )
    .first<{ generation: number }>();
  if (claimed) return { claimed: true, generation: claimed.generation };

  const state = await db
    .prepare(
      `SELECT deleted, formaloo_webhook_enabled AS enabled,
              formaloo_webhook_pull_generation AS generation,
              formaloo_webhook_pull_processed_generation AS processed,
              formaloo_webhook_pull_lock_token AS lock_token,
              formaloo_webhook_pull_lock_until AS lock_until,
              formaloo_webhook_pull_not_before AS not_before
       FROM formaloo_forms WHERE id = ?`,
    )
    .bind(formId)
    .first<{
      deleted: number;
      enabled: number;
      generation: number;
      processed: number;
      lock_token: string | null;
      lock_until: number | null;
      not_before: number;
    }>();
  const pending = Boolean(
    state
    && state.deleted === 0
    && state.enabled === 1
    && state.generation > state.processed,
  );
  const activeLockUntil = state?.lock_token && (state.lock_until ?? 0) > input.nowMs
    ? state.lock_until ?? input.nowMs
    : input.nowMs;
  return {
    claimed: false,
    pending,
    retryAt: pending
      ? Math.max(input.nowMs, state?.not_before ?? input.nowMs, activeLockUntil)
      : input.nowMs,
  };
}

/** 期限内の pull owner だけが lease を延長できる（失効 token の復活は禁止）。 */
export async function renewFormalooWebhookPullLock(
  db: D1Database,
  formId: string,
  input: { token: string; nowMs: number; leaseMs: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE formaloo_forms
       SET formaloo_webhook_pull_lock_until = ?
       WHERE id = ?
         AND formaloo_webhook_pull_lock_token = ?
         AND formaloo_webhook_pull_lock_until > ?`,
    )
    .bind(input.nowMs + input.leaseMs, formId, input.token, input.nowMs)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

/**
 * claim owner だけが generation を処理済みにできる。失敗時は世代を進めず、dirty を durable に保持する。
 */
export async function completeFormalooWebhookPull(
  db: D1Database,
  formId: string,
  input: { token: string; generation: number; success: boolean },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE formaloo_forms
       SET formaloo_webhook_pull_processed_generation = CASE
             WHEN ? = 1 THEN MAX(formaloo_webhook_pull_processed_generation, ?)
             ELSE formaloo_webhook_pull_processed_generation
           END,
           formaloo_webhook_pull_lock_token = NULL,
           formaloo_webhook_pull_lock_until = NULL
       WHERE id = ? AND formaloo_webhook_pull_lock_token = ?`,
    )
    .bind(input.success ? 1 : 0, input.generation, formId, input.token)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

/**
 * read-back で submit event=true を確認できた remote webhook だけを有効登録として保存する。
 * callback secret / URL は公開 API に直返しせず、新しい受信 route の照合にだけ使う。
 */
export async function setFormalooWebhookRegistration(
  db: D1Database,
  formId: string,
  registration: { webhookId: string; secret: string; url: string },
  operationToken: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE formaloo_forms
       SET formaloo_webhook_enabled = 1,
           formaloo_webhook_id = ?,
           formaloo_webhook_secret = ?,
           formaloo_webhook_url = ?,
           updated_at = ?
       WHERE id = ? AND formaloo_webhook_lock_token = ?`,
    )
    .bind(
      registration.webhookId,
      registration.secret,
      registration.url,
      jstNow(),
      formId,
      operationToken,
    )
    .run();
  return (result.meta.changes ?? 0) === 1;
}

/**
 * remote POST より前に callback を OFF 状態で固定する。
 * 既存の組は上書きしないため、retry / lease takeover でも同じ URL を read-back して採用できる。
 */
export async function prepareFormalooWebhookRegistration(
  db: D1Database,
  formId: string,
  registration: { secret: string; url: string },
  operationToken: string,
): Promise<{ secret: string; url: string } | null> {
  await db
    .prepare(
      `UPDATE formaloo_forms
       SET formaloo_webhook_enabled = 0,
           formaloo_webhook_secret = CASE
             WHEN formaloo_webhook_secret IS NULL OR formaloo_webhook_url IS NULL THEN ?
             ELSE formaloo_webhook_secret
           END,
           formaloo_webhook_url = CASE
             WHEN formaloo_webhook_secret IS NULL OR formaloo_webhook_url IS NULL THEN ?
             ELSE formaloo_webhook_url
           END,
           updated_at = ?
       WHERE id = ? AND formaloo_webhook_lock_token = ?`,
    )
    .bind(registration.secret, registration.url, jstNow(), formId, operationToken)
    .run();
  const stored = await db
    .prepare(
      `SELECT formaloo_webhook_secret AS secret, formaloo_webhook_url AS url
       FROM formaloo_forms WHERE id = ? AND formaloo_webhook_lock_token = ?`,
    )
    .bind(formId, operationToken)
    .first<{ secret: string | null; url: string | null }>();
  return stored?.secret && stored.url ? { secret: stored.secret, url: stored.url } : null;
}

/** remote cleanup が未完でも callback を即 no-op にする。id/secret/URL は再試行用に保持する。 */
export async function disableFormalooWebhookRegistration(
  db: D1Database,
  formId: string,
  operationToken: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE formaloo_forms
       SET formaloo_webhook_enabled = 0,
           formaloo_webhook_pull_processed_generation = formaloo_webhook_pull_generation,
           formaloo_webhook_pull_lock_token = NULL,
           formaloo_webhook_pull_lock_until = NULL,
           formaloo_webhook_pull_not_before = 0,
           updated_at = ?
       WHERE id = ? AND formaloo_webhook_lock_token = ?`,
    )
    .bind(jstNow(), formId, operationToken)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

/** remote 解除成功（404=既に無しを含む）後に local 登録を既定 OFF へ戻す。 */
export async function clearFormalooWebhookRegistration(
  db: D1Database,
  formId: string,
  operationToken: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE formaloo_forms
       SET formaloo_webhook_enabled = 0,
           formaloo_webhook_id = NULL,
           formaloo_webhook_secret = NULL,
           formaloo_webhook_url = NULL,
           formaloo_webhook_pull_processed_generation = formaloo_webhook_pull_generation,
           formaloo_webhook_pull_lock_token = NULL,
           formaloo_webhook_pull_lock_until = NULL,
           formaloo_webhook_pull_not_before = 0,
           updated_at = ?
       WHERE id = ? AND formaloo_webhook_lock_token = ?`,
    )
    .bind(jstNow(), formId, operationToken)
    .run();
  return (result.meta.changes ?? 0) === 1;
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
    // form-media-limits ③: 回答者による後編集を許可するか (0|1)。present-key 更新 (未指定は変えない)。
    allowPostEdit?: number;
    // form-edit-mail-link (弾L): 編集 URL メール送付の許可 (0|1)。present-key 更新 (未指定は変えない・allow_post_edit 同型)。
    allowEditMail?: number;
    // form-edit-mail-link (弾L / OD-3): 送付先 email 欄の明示指定 slug。present-key 更新 (未指定は変えない)。
    editMailFieldSlug?: string | null;
    // row-status-friend-sync: canonical JSON array。present-key 更新 (未指定は変えない)。
    friendMetadataMappingsJson?: string;
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
  // form-media-limits ③: allow_post_edit を present-key 更新 (title/description と同型 / 未指定は変えない)。
  if (params.allowPostEdit !== undefined) {
    sets.push('allow_post_edit = ?');
    vals.push(params.allowPostEdit);
  }
  // form-edit-mail-link (弾L): allow_edit_mail / edit_mail_field_slug を present-key 更新 (未指定は変えない)。
  if (params.allowEditMail !== undefined) {
    sets.push('allow_edit_mail = ?');
    vals.push(params.allowEditMail);
  }
  if (params.editMailFieldSlug !== undefined) {
    sets.push('edit_mail_field_slug = ?');
    vals.push(params.editMailFieldSlug);
  }
  if (params.friendMetadataMappingsJson !== undefined) {
    sets.push('friend_metadata_mappings_json = ?');
    vals.push(params.friendMetadataMappingsJson);
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
  // migration 100 (form-post-edit 弾M): Formaloo row 編集の addressable identifier (row_slug)。
  //   NULL=legacy (webhook root.slug 未 capture) → rows-list resolver で lazy backfill。
  formaloo_row_slug: string | null;
  // migration 103 (form-edit-mail Phase B): submit-time receipt metadata。NULL は未提供/旧回答。
  tracking_code: string | null;
  submit_number: string | null;
  pdf_link: string | null;
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
  // migration 100 (form-post-edit 弾M): webhook root.slug 由来の row_slug。未取得 (legacy/fallback 形) は null。
  //   **write-once + null backfill**: 既存が非 null なら再送の異なる非 null でも上書きしない
  //   (COALESCE(existing, excluded))。row_slug は Formaloo 側で不変ゆえ最初に capture した値を正とする。
  rowSlug?: string | null;
  // migration 104: Formaloo webhook / row pull で取得できた submit-time receipt metadata。
  trackingCode?: string | null;
  submitNumber?: string | null;
  pdfLink?: string | null;
  /** 今回の reconcile で署名 fr_id を検証できた時だけ mapper が作る metadata 更新 intent。 */
  verifiedFriendMetadataSync?: {
    friendId: string;
    updates: Array<{
      formalooFieldKey: string;
      friendMetadataKey: string;
      value: string;
    }>;
  };
}

const FORMALOO_FRIEND_METADATA_SYNC_STATE_KEY = '__formaloo_friend_metadata_sync';
const RESERVED_FRIEND_METADATA_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * 最新 row の verified intent だけを friend.metadata へ反映する。
 * configured target は Formaloo が所有し、同値なら write せず、未 mapping key は atomic JSON merge で保持する。
 */
async function applyVerifiedFriendMetadataSync(
  db: D1Database,
  input: UpsertFormalooSubmissionInput,
): Promise<void> {
  const intent = input.verifiedFriendMetadataSync;
  if (!intent || !input.friendId || intent.friendId !== input.friendId || intent.updates.length === 0) return;

  const updates = intent.updates.filter((update) => (
    Boolean(update.friendMetadataKey)
    && !update.friendMetadataKey.startsWith('__formaloo_')
    && !RESERVED_FRIEND_METADATA_KEYS.has(update.friendMetadataKey)
    && typeof update.value === 'string'
    && update.value.length <= 10_000
  ));
  if (updates.length === 0) return;

  // JSON Merge Patch 用の null-prototype object。予約 key は上で除外済みだが、
  // 履歴キーも含め plain object の prototype setter に値を吸われないようにする。
  const patch: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const statePatch: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const updatedAt = jstNow();
  for (const update of updates) {
    patch[update.friendMetadataKey] = update.value;
    statePatch[update.friendMetadataKey] = {
      formId: input.formId,
      rowId: input.id,
      formalooFieldKey: update.formalooFieldKey,
      value: update.value,
      updatedAt,
    };
  }
  patch[FORMALOO_FRIEND_METADATA_SYNC_STATE_KEY] = statePatch;

  // 1 atomic UPDATE で「最新 row 判定 + 同値 skip + metadata merge + 由来保存」を行う。
  // reconcile 上限400行でも upsert と合わせて最大800 statements。同一時刻は
  // Formaloo rows API の newest-first 処理順を保つため、先に insert された rowid を勝たせる。
  await db.prepare(
    `UPDATE friends
     SET metadata = json_patch(metadata, json(?)), updated_at = ?
     WHERE id = ?
       AND json_valid(metadata) = 1
       AND json_type(metadata) = 'object'
       AND EXISTS (
         SELECT 1 FROM formaloo_submissions candidate
         WHERE candidate.id = ? AND candidate.form_id = ? AND candidate.friend_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM formaloo_submissions newer
             WHERE newer.form_id = candidate.form_id AND newer.friend_id = candidate.friend_id
               AND (
                 julianday(newer.submitted_at) > julianday(candidate.submitted_at)
                 OR (
                   julianday(newer.submitted_at) = julianday(candidate.submitted_at)
                   AND newer.rowid < candidate.rowid
                 )
               )
           )
       )
       AND EXISTS (
         SELECT 1 FROM json_each(json(?)) requested
         WHERE NOT EXISTS (
           SELECT 1 FROM json_each(friends.metadata) current
           WHERE current.key = json_extract(requested.value, '$.friendMetadataKey')
             AND current.type = 'text'
             AND current.atom = json_extract(requested.value, '$.value')
         )
       )`,
  ).bind(
    JSON.stringify(patch), updatedAt, intent.friendId,
    input.id, input.formId, intent.friendId,
    JSON.stringify(updates),
  ).run();
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
      `INSERT INTO formaloo_submissions (id, form_id, formaloo_slug, friend_id, answers_json, submitted_at, synced_at, line_processed, verified, formaloo_row_slug, tracking_code, submit_number, pdf_link)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         answers_json      = excluded.answers_json,
         friend_id         = COALESCE(excluded.friend_id, formaloo_submissions.friend_id),
         submitted_at      = excluded.submitted_at,
         synced_at         = excluded.synced_at,
         verified          = MAX(formaloo_submissions.verified, excluded.verified),
         formaloo_row_slug = COALESCE(formaloo_submissions.formaloo_row_slug, excluded.formaloo_row_slug),
         tracking_code     = COALESCE(formaloo_submissions.tracking_code, excluded.tracking_code),
         submit_number     = COALESCE(formaloo_submissions.submit_number, excluded.submit_number),
         pdf_link          = COALESCE(formaloo_submissions.pdf_link, excluded.pdf_link)`,
    )
    .bind(
      input.id,
      input.formId,
      input.formalooSlug ?? null,
      input.friendId ?? null,
      input.answersJson,
      input.submittedAt,
      now,
      v,
      input.rowSlug ?? null,
      input.trackingCode ?? null,
      input.submitNumber ?? null,
      input.pdfLink ?? null,
    )
    .run();
  await applyVerifiedFriendMetadataSync(db, input);
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

// ─── 弾M あと編集 (form-post-edit / migration 100) ─────────────────────────────

/**
 * ②本人再入場 prefill 用: 当該 friend の**最新** row を 1 件返す (取り違え防止の要)。
 * friend_id **完全一致** WHERE + form scope に閉じ、最新 row を返す。**別 friend の row を絶対に返さない**。
 * 最新判定 (F-I5): submitted_at は ISO-8601 TEXT で tz offset 混在時 (Z vs +09:00) に lexical DESC が非時系列に
 *   なる → `julianday(submitted_at)` で UTC 正規化してから DESC。同一 instant は rowid DESC (後挿入=新) で tie-break。
 *   julianday が NULL (壊れた timestamp) の行は最後に落ち、rowid で決まる (fail-safe)。
 */
export async function getFriendLatestSubmission(
  db: D1Database,
  formId: string,
  friendId: string,
): Promise<FormalooSubmissionRow | null> {
  return db
    .prepare(
      'SELECT * FROM formaloo_submissions WHERE form_id = ? AND friend_id = ? ORDER BY julianday(submitted_at) DESC, rowid DESC LIMIT 1',
    )
    .bind(formId, friendId)
    .first<FormalooSubmissionRow>();
}

export interface FormalooSubmissionEditRow {
  id: string;
  submission_id: string;
  form_id: string;
  editor_staff_id: string | null;
  edited_at: string;
  field_slug: string;
  old_value: string | null;
  new_value: string | null;
}

export interface RecordSubmissionEditInput {
  submissionId: string;
  formId: string;
  editorStaffId: string | null;
  fieldSlug: string;
  oldValue: string | null;
  newValue: string | null;
}

/** ④最小監査: ①管理者編集を formaloo_submission_edits に 1 行記録 (誰が いつ どの項目を 前値→後値)。 */
export async function recordSubmissionEdit(db: D1Database, input: RecordSubmissionEditInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO formaloo_submission_edits (id, submission_id, form_id, editor_staff_id, edited_at, field_slug, old_value, new_value)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(`fse_${crypto.randomUUID()}`, input.submissionId, input.formId, input.editorStaffId, jstNow(), input.fieldSlug, input.oldValue, input.newValue)
    .run();
}

/** 回答詳細の「最終編集: {staff} {日時}」表示用: 当該 submission の最新編集 1 行 (無ければ null)。 */
export async function getLatestEdit(db: D1Database, submissionId: string): Promise<FormalooSubmissionEditRow | null> {
  return db
    .prepare('SELECT * FROM formaloo_submission_edits WHERE submission_id = ? ORDER BY edited_at DESC LIMIT 1')
    .bind(submissionId)
    .first<FormalooSubmissionEditRow>();
}

/** legacy row_slug の lazy backfill: 現在 NULL の行のみ後埋め (既に capture 済の値は上書きしない)。 */
export async function updateSubmissionRowSlug(db: D1Database, submissionId: string, rowSlug: string): Promise<void> {
  await db
    .prepare('UPDATE formaloo_submissions SET formaloo_row_slug = ? WHERE id = ? AND formaloo_row_slug IS NULL')
    .bind(rowSlug, submissionId)
    .run();
}

// ─── 弾L 編集 URL メール (form-edit-mail-link / migration 101) ────────────────

export interface FormalooEditMailSendRow {
  id: string;
  submission_id: string;
  form_id: string;
  recipient_hash: string;
  requested_at: string;
  status: string; // pending | sent | failed | skipped
  attempt_count: number;
  provider_idempotency_key: string | null;
  last_attempt_at: string | null;
  provider_message_id: string | null;
  error: string | null;
}

export interface ClaimEditMailSendInput {
  submissionId: string;
  formId: string;
  recipientHash: string;
  providerIdempotencyKey?: string | null;
}

/**
 * 編集 URL メール送信の冪等 claim (Codex G-3/G-4 outbox)。
 * submission_id UNIQUE への INSERT を **status=pending 予約** で行い、初回 (changes=1) のみ true。
 * webhook 再配信/並行でも 1 回だけ true = 「1 submission=1 送信」(二重送信防止)。claim=pending ゆえ
 * claim 直後にプロセスが落ちても行が残り、cron sweep が拾って再送できる (メール永久喪失を防ぐ)。
 */
export async function claimEditMailSend(db: D1Database, input: ClaimEditMailSendInput): Promise<boolean> {
  const res = await db
    .prepare(
      `INSERT INTO formaloo_edit_mail_sends
         (id, submission_id, form_id, recipient_hash, requested_at, status, attempt_count, provider_idempotency_key)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?)
       ON CONFLICT(submission_id) DO NOTHING`,
    )
    .bind(
      `fem_${crypto.randomUUID()}`,
      input.submissionId,
      input.formId,
      input.recipientHash,
      jstNow(),
      input.providerIdempotencyKey ?? null,
    )
    .run();
  return ((res as { meta?: { changes?: number } }).meta?.changes ?? 0) === 1;
}

export interface RecordEditMailResultInput {
  submissionId: string;
  status: 'sent' | 'failed' | 'skipped';
  providerMessageId?: string | null;
  providerIdempotencyKey?: string | null;
  error?: string | null;
  /** claimEditMailAttempt が送信前に count を確保済みなら true (二重加算しない)。 */
  attemptClaimed?: boolean;
}

/**
 * 送信結果を記録し状態遷移 (pending → sent/failed/skipped)。attempt_count を +1 (再送上限判定用)。
 * provider ack (message id) / 失敗理由 (error) / provider 冪等キーを present-key で保存 (soft-200-safe 証跡)。
 */
export async function recordEditMailResult(db: D1Database, input: RecordEditMailResultInput): Promise<void> {
  await db
    .prepare(
      `UPDATE formaloo_edit_mail_sends
         SET status = ?, attempt_count = attempt_count + ?, last_attempt_at = ?,
             provider_message_id = COALESCE(?, provider_message_id),
             provider_idempotency_key = COALESCE(?, provider_idempotency_key),
             error = ?
       WHERE submission_id = ?`,
    )
    .bind(
      input.status,
      input.attemptClaimed ? 0 : 1,
      jstNow(),
      input.providerMessageId ?? null,
      input.providerIdempotencyKey ?? null,
      input.error ?? null,
      input.submissionId,
    )
    .run();
}

export interface ClaimEditMailAttemptInput {
  submissionId: string;
  expectedAttemptCount: number;
  maxAttempts: number;
  providerIdempotencyKey: string;
}

export interface MarkEditMailPreSendSkippedInput {
  submissionId: string;
  expectedAttemptCount: number;
  error: string;
}

/** provider 呼出し前の恒久 skip を、並行送信を上書きしない CAS で terminal 化する。 */
export async function markEditMailPreSendSkipped(
  db: D1Database,
  input: MarkEditMailPreSendSkippedInput,
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE formaloo_edit_mail_sends
         SET status = 'skipped', last_attempt_at = ?, error = ?
       WHERE submission_id = ?
         AND status IN ('pending', 'failed')
         AND attempt_count = ?`,
    )
    .bind(jstNow(), input.error, input.submissionId, input.expectedAttemptCount)
    .run();
  return ((res as { meta?: { changes?: number } }).meta?.changes ?? 0) === 1;
}

/** cron/webhook 共通: provider 呼出し前に 1 attempt を CAS 確保する。 */
export async function claimEditMailAttempt(db: D1Database, input: ClaimEditMailAttemptInput): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE formaloo_edit_mail_sends
         SET attempt_count = attempt_count + 1,
             last_attempt_at = ?,
             status = 'pending',
             provider_idempotency_key = COALESCE(provider_idempotency_key, ?),
             error = NULL
       WHERE submission_id = ?
         AND status IN ('pending', 'failed')
         AND attempt_count = ?
         AND attempt_count < ?`,
    )
    .bind(jstNow(), input.providerIdempotencyKey, input.submissionId, input.expectedAttemptCount, input.maxAttempts)
    .run();
  return ((res as { meta?: { changes?: number } }).meta?.changes ?? 0) === 1;
}

/** bounded sweep 用: retryable outbox を古い順に上限件数だけ返す。 */
export async function listRetryableEditMailSends(
  db: D1Database,
  input: { maxAttempts: number; limit: number },
): Promise<FormalooEditMailSendRow[]> {
  const maxAttempts = Math.max(1, Math.trunc(input.maxAttempts));
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)));
  const res = await db
    .prepare(
      `SELECT * FROM formaloo_edit_mail_sends
       WHERE status IN ('pending', 'failed') AND attempt_count < ?
       ORDER BY requested_at ASC
       LIMIT ?`,
    )
    .bind(maxAttempts, limit)
    .all<FormalooEditMailSendRow>();
  return res.results;
}

/** outbox 1 行を submission_id で引く (冪等確認 / 送達証跡表示)。 */
export async function getEditMailSend(db: D1Database, submissionId: string): Promise<FormalooEditMailSendRow | null> {
  return db.prepare('SELECT * FROM formaloo_edit_mail_sends WHERE submission_id = ?').bind(submissionId).first<FormalooEditMailSendRow>();
}

/**
 * 送付先 email 欄の slug を解決 (S-3 / OD-3)。formaloo_field_map の field_type='email' かつ slug 確定の先頭を返す。
 * email 型が 0 個 or slug 未確定のみ = 宛先解決不能 → null (fire は skip)。複数欄の明示指定 enforce は Phase B fire 側。
 */
export async function resolveFormEmailFieldSlug(db: D1Database, formId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT formaloo_field_slug AS slug FROM formaloo_field_map
       WHERE form_id = ? AND field_type = 'email' AND formaloo_field_slug IS NOT NULL
       ORDER BY position ASC LIMIT 1`,
    )
    .bind(formId)
    .first<{ slug: string }>();
  return row?.slug ?? null;
}

/** 失効世代 bump (Codex G-5): 当該 form の edit_link_epoch を +1 = 既発行の編集 URL を全失効させる。 */
export async function bumpEditLinkEpoch(db: D1Database, formId: string): Promise<void> {
  await db
    .prepare('UPDATE formaloo_forms SET edit_link_epoch = edit_link_epoch + 1, updated_at = ? WHERE id = ?')
    .bind(jstNow(), formId)
    .run();
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

/**
 * form 単位のミラー回答件数 (COUNT のみ・rows 非 fetch / forms-list-count-fix T-A1)。
 * 高機能フォーム一覧の回答数表示源。submit_count は harness-public 投稿の verified+published だけを +1 する
 * harness-only カウンタで、Formaloo ネイティブ投稿/reconcile 取込みでは増えない (0 のまま = 症状)。
 * ミラー formaloo_submissions は全 public 投稿を無条件 upsert する完全上位集合ゆえ、行数採用で回答を失わず正確。
 * Formaloo API 呼出なし・local D1 1 クエリ。単一 form ゆえ IN-list 変数上限の懸念なし。
 */
export async function countFormalooSubmissionsForForm(db: D1Database, formId: string): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM formaloo_submissions WHERE form_id = ?')
    .bind(formId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
