import { Hono, type Context } from 'hono';
import {
  createFormalooForm,
  listFormalooForms,
  getFormalooForm,
  saveFormalooDefinition,
  updateFormalooBuilderStatus,
  softDeleteFormalooForm,
  setFormalooSyncState,
  getFormalooSyncState,
  listFormalooDriftEvents,
  queryFormalooSubmissions,
  countFormalooSubmissionsForForm,
  upsertFormalooSubmission,
  getFormalooSubmission,
  listFormalooSavedFilters,
  createFormalooSavedFilter,
  deleteFormalooSavedFilter,
  formalooSubmissionsDailyCounts,
  bulkDeleteFormalooSubmissions,
  setFormalooGsheetState,
  getFormalooFieldMap,
  isActiveFormalooWorkspace,
  resolveDefaultWorkspace,
  resolveSoleActiveWorkspace,
  setFormalooFormWorkspace,
  setFormalooFormFolder,
  FolderError,
  recordSubmissionEdit,
  getLatestEdit,
  updateSubmissionRowSlug,
  getStaffById,
  jstNow,
  acquireFormalooFormOperationLock,
  releaseFormalooFormOperationLock,
  hasBlockingFormalooRecurringSubmissions,
  type FormalooForm,
  type FormalooSubmissionRow,
} from '@line-crm/db';
import {
  buildFlatRowPatchBody,
  findEmptyRequired,
  resolveRowSlug,
  makeRowsListRowSlugResolver,
  isPostEditEnabled,
  extractRows,
  mapFormalooListRowToUpsert,
  buildFieldLabelList,
  joinDefinitionFieldsWithSlug,
  friendLinkSecret,
} from '../services/formaloo-row-edit.js';
import {
  validateHarnessField,
  isDecorationType,
  toCsv,
  parseCsv,
  logicFingerprint,
  normalizeFormDesign,
  normalizeFormCopy,
  normalizeFormRedirect,
  normalizeSuccessPages,
  normalizeFormOperationsSettings,
  validateFormOperationsSettingsPatch,
  mergeFormOperationsSettings,
  parseFriendMetadataMappingsJson,
  validateFriendMetadataMappings,
  defaultFormDesign,
  serializeRawLogicForPush,
  computeRouteTerminalWarnings,
  isExpandableMultiJumpItem,
  isExpandableTerminalItem,
  type HarnessField,
  type HarnessLogicRule,
  type FormDesign,
  type FormDesignImages,
  type FormDisplayType,
  type FormCopy,
  type FormRedirect,
  type SuccessPageSpec,
  type FriendMetadataMapping,
  type FormOperationsSettings,
  type FormOperationsSettingsPatch,
} from '@line-crm/shared';
import {
  canTransition,
  buildPublicUrl,
  buildEmbedCode,
  buildScriptEmbedCode,
  isBuilderStatus,
  type BuilderStatus,
} from '../services/formaloo-publish-gate.js';
import { resolveFormalooClient } from '../services/formaloo-client.js';
import { pushDefinitionToFormaloo } from '../services/formaloo-sync.js';
import { uploadImageDataUrlToR2, resolveInBodyImageUploads } from '../services/form-image-upload.js';
import { pullDefinitionFromFormaloo } from '../services/formaloo-pull.js';
import { designColorFields, confirmDesignReflected, confirmBackgroundReflected, applyDesignImages, type BackgroundReflectionExpected } from '../services/formaloo-design.js';
import { resolveRatingStarCustomCss } from '../services/formaloo-rating-css.js';
import {
  formCopyFields,
  confirmFormCopyReflected,
  localizedContentFields,
  confirmLocalizedContentReflected,
} from '../services/formaloo-copy.js';
import { redirectFields, confirmRedirectReflected, validateFormRedirectInput } from '../services/formaloo-redirect.js';
import { formOperationsFields, confirmFormOperationsReflected } from '../services/formaloo-form-operations.js';
import { deleteSuccessPages } from '../services/formaloo-success-page.js';
import { reapplyHostedAppearance } from '../services/formaloo-reapply.js';
import { ownerGate } from '../lib/owner-gate.js';
import type { Env } from '../index.js';

// =============================================================================
// /api/forms-advanced — Formaloo-backed 高機能フォーム (F-2 / G19 再定義)
// -----------------------------------------------------------------------------
// permissionMiddleware が forms_advanced feature で全 route を gate (permission-map / landmine#4)。
// native forms (/api/forms) は無改変で併存 (D-1)。SoT: D1=表示キャッシュ+台帳、Formaloo=定義の権威。
// 誤配信防止 (N-7): draft/in_review では公開/埋め込み URL を発行しない (publish gate)。
// =============================================================================

export const formsAdvanced = new Hono<Env>();

interface StoredDefinition {
  fields: HarnessField[];
  logic: HarnessLogicRule[];
  formalooAddress?: string | null;
  // ── formaloo-logic-fidelity Batch 1 (preserve-raw) additive ──
  // rawLogic = 最後に pull した Formaloo `.data.form.logic` bare array の逐語 (未編集 push 時に PATCH で再送)。
  //   表示用キャッシュ (SoT は Formaloo)。migration 不要 (既存 TEXT の additive JSON key)。
  rawLogic?: unknown;
  // logicFingerprint = pull 時の射影 logic の canonical hash。save 時に受領 logic と突合して未編集を判定 (R7)。
  logicFingerprint?: string | null;
  // form-design (Batch D): 色/画像テーマ (additive JSON key / migration 不要)。design 無しフォームは undefined。
  design?: FormDesign;
  // form-route-branching (R2): 表示形式 (additive JSON key)。未設定フォームは undefined = 後方互換 (byte 不変)。
  formType?: FormDisplayType;
  // form-jp-localization: 公開ページ文言 (additive JSON key)。未設定フォームは undefined = 後方互換 (byte 不変)。
  formCopy?: FormCopy;
  // hosted UI chrome の管理 key を日本語化する owner intent。undefined=未管理 / false=管理 key を解除。
  localizationJa?: boolean;
  // route-terminal-phase2 (Track 1): 送信後リダイレクト設定 (additive JSON key)。未設定は undefined = 後方互換 (byte 不変)。
  formRedirect?: FormRedirect;
  // route-terminal-phase2 (Track 2): ルート別完了ページ + 割当 slug (additive JSON key)。未設定は undefined = 後方互換。
  successPages?: SuccessPageSpec[];
  // treasure B2: form 単位の運用制御。非既定値だけを保存し、空なら key 自体を持たない。
  operationsSettings?: FormOperationsSettings;
}

function parseDefinition(json: string): StoredDefinition {
  try {
    const d = JSON.parse(json) as Partial<StoredDefinition> & Record<string, unknown>;
    return {
      fields: Array.isArray(d.fields) ? d.fields : [],
      logic: Array.isArray(d.logic) ? d.logic : [],
      formalooAddress: typeof d.formalooAddress === 'string' ? d.formalooAddress : null,
      rawLogic: 'rawLogic' in d ? d.rawLogic : null,
      logicFingerprint: typeof d.logicFingerprint === 'string' ? d.logicFingerprint : null,
      // whitelist 正規化 (M-21)。design が無ければ undefined = 後方互換。
      design: d.design && typeof d.design === 'object' && !Array.isArray(d.design)
        ? normalizeFormDesign(d.design)
        : undefined,
      // form-route-branching: whitelist 2 値のみ。未設定は undefined = 後方互換。
      formType: d.formType === 'simple' || d.formType === 'multi_step' ? d.formType : undefined,
      // form-jp-localization: 文言 whitelist 正規化 (M-21)。文言が無ければ undefined = 後方互換。
      formCopy: d.formCopy && typeof d.formCopy === 'object' && !Array.isArray(d.formCopy)
        ? normalizeFormCopy(d.formCopy)
        : undefined,
      // boolean だけを受理。false は OFF intent なので undefined へ潰さない。
      localizationJa: typeof d.localizationJa === 'boolean' ? d.localizationJa : undefined,
      // route-terminal-phase2: redirect whitelist 正規化。redirect が無ければ undefined = 後方互換 (byte 不変)。
      formRedirect: d.formRedirect && typeof d.formRedirect === 'object' && !Array.isArray(d.formRedirect)
        ? normalizeFormRedirect(d.formRedirect)
        : undefined,
      // route-terminal-phase2 (Track 2): successPages whitelist 正規化。無ければ undefined = 後方互換 (byte 不変)。
      successPages: Array.isArray(d.successPages) && d.successPages.length
        ? normalizeSuccessPages(d.successPages)
        : undefined,
      operationsSettings: d.operationsSettings && typeof d.operationsSettings === 'object' && !Array.isArray(d.operationsSettings)
        ? (() => {
            const value = normalizeFormOperationsSettings(d.operationsSettings);
            return Object.keys(value).length ? value : undefined;
          })()
        : undefined,
    };
  } catch {
    return { fields: [], logic: [], formalooAddress: null, rawLogic: null, logicFingerprint: null, design: undefined, formType: undefined, formCopy: undefined, localizationJa: undefined, formRedirect: undefined, successPages: undefined, operationsSettings: undefined };
  }
}

/** ctx から owner (built-in owner role) かを判定 (ownerGate と同一基準)。 */
function isOwnerCtx(c: Context<Env>): boolean {
  return c.get('staff')?.role === 'owner';
}

// F6-2 role-aware redaction (Codex B#2): lineAccountId は全 role 露出 (表示スコープ判定に要る・秘密でない)。
// workspaceId は owner 応答のみ露出 (F6-1 で workspace 情報は owner-only / 非 owner の POST body injection の
// 下調べも封じる) → 非 owner 応答には workspaceId プロパティを一切載せない (undefined でなく不在)。
async function serializeForm(db: D1Database, form: FormalooForm, isOwner: boolean) {
  const def = parseDefinition(form.definition_json);
  const status = (isBuilderStatus(form.builder_status) ? form.builder_status : 'draft') as BuilderStatus;
  const sync = await getFormalooSyncState(db, form.id);
  // forms-list-count-fix: 回答数表示源を submit_count(harness-only カウンタ = reconcile/native 投稿を落とす)
  // から D1 ミラー行数へ切替 (formaloo_submissions の form 別 COUNT)。ミラーは全 public 投稿の完全上位集合ゆえ
  // 回答を失わず正確。**local D1 のみ・Formaloo 呼出なし** (一覧描画の暴走設計を作らない = failure_observable)。
  const mirrorCount = await countFormalooSubmissionsForForm(db, form.id);
  const publicUrl = buildPublicUrl(status, def.formalooAddress ?? null);
  // formaloo-auto-pull: drift 露出 (badge 用)。driftHasWarnings は drift 未解決時のみ最新 event を引く
  // (drift_status='none' の一般ケースは追加 query なし = N+1 回避)。
  const driftStatus = sync?.drift_status ?? 'none';
  let driftHasWarnings = false;
  if (driftStatus === 'detected' || driftStatus === 'conflict') {
    const events = await listFormalooDriftEvents(db, form.id, 1);
    driftHasWarnings = (events[0]?.has_warnings ?? 0) === 1;
  }
  // Phase B / G-1: remote slug と email 型が完全一致する map 行だけを builder internal id へ戻す。
  // NULL/不一致/非 email は fail-closed。複数 email の先頭 fallback は行わない。
  let editMailFieldId: string | null = null;
  if (form.edit_mail_field_slug) {
    const fieldMap = await getFormalooFieldMap(db, form.id);
    editMailFieldId = fieldMap.find((row) =>
      row.formaloo_field_slug === form.edit_mail_field_slug && row.field_type === 'email',
    )?.id ?? null;
  }
  return {
    id: form.id,
    title: form.title,
    description: form.description,
    formalooSlug: form.formaloo_slug,
    builderStatus: status,
    publishedAt: form.published_at,
    submitCount: mirrorCount,
    onSubmitTagId: form.on_submit_tag_id,
    onSubmitScenarioId: form.on_submit_scenario_id,
    submitMessage: form.submit_message,
    // form-media-limits ③: 回答者後編集の許可フラグ (0|1)。builder 読込用。弾S では inert (実効化は弾M)。
    allowPostEdit: form.allow_post_edit,
    // form-edit-mail-link (弾L): 編集 URL メール送付の許可フラグ (0|1)。builder 読込用 (allow_post_edit=1 でのみ有効)。
    allowEditMail: form.allow_edit_mail,
    // Phase B: server 権威で remote slug から逆引きした明示宛先。未設定時は null (自動採用なし)。
    editMailFieldId,
    fields: def.fields,
    logic: def.logic,
    // preserve-raw (Batch 1): 未編集判定用の fingerprint のみ露出 (builder が save で carry する)。
    // rawLogic 逐語は server-side に留め PUBLIC/一覧面へ出さない (機密面 raw 非露出 / plan §grep4)。
    logicFingerprint: def.logicFingerprint ?? null,
    // form-design (Batch D): 色/画像テーマ (builder の initialDesign / プレビュー反映用)。未設定は null。
    design: def.design ?? null,
    // form-route-branching (R2): 表示形式 (builder の initialFormType)。未設定は null (builder が simple 既定表示)。
    formType: def.formType ?? null,
    // 未管理フォームは false 表示。保存時は undefined と false を分け、明示 OFF だけ remote 管理 key を解除する。
    localizationJa: def.localizationJa ?? false,
    // route-terminal-phase2 (Track 1 / CX-3): 送信後リダイレクト設定 (builder の initialFormRedirect)。
    //   未設定は null。保存済 redirect を reload で復元し編集/解除できるようにする (design/formType と同型の露出)。
    formRedirect: def.formRedirect ?? null,
    // route-terminal-phase2 (Track 2 / T-E5): ルート別完了ページ (builder の initialSuccessPages)。未設定は null。
    //   保存済 SP (割当 slug 込み) を reload で復元し編集/削除できるようにする。
    successPages: def.successPages ?? null,
    // treasure B2: 未設定は null。builder は現行挙動（全OFF・無制限）として表示する。
    operationsSettings: def.operationsSettings ?? null,
    // row-status-friend-sync: local-only mapping。壊れた JSON は [] に倒し機能 OFF (fail-closed)。
    friendMetadataMappings: parseFriendMetadataMappingsJson(form.friend_metadata_mappings_json),
    // N-7: publish 前は null (公開/埋め込み URL 発行不可)
    publicUrl,
    embedCode: buildEmbedCode(status, def.formalooAddress ?? null, { title: form.title }),
    syncStatus: sync?.sync_status ?? 'idle',
    syncError: sync?.last_error ?? null,
    // formaloo-auto-pull: drift 状態 (pull 軸 / sync_status と直交)。UI badge の入力。
    // none=なし / detected=更新あり(要確認) / conflict=競合(要確認) / applied=自動反映済。
    driftStatus,
    driftDetectedAt: sync?.drift_detected_at ?? null,
    driftHasWarnings,
    // F6-2 表示スコープ: lineAccountId は全 role / workspaceId は owner のみ。
    lineAccountId: form.line_account_id,
    ...(isOwner ? { workspaceId: form.workspace_id } : {}),
    // F6-3 ハーネス側フォルダ分類 (NULL=未分類 / round-trip / M-8)。全 role 露出 (秘密でない・表示に要る)。
    folderId: form.folder_id,
    updatedAt: form.updated_at,
  };
}

// GET /api/forms-advanced — 一覧 (F6-2: ?lineAccountId= 表示スコープ / F6-3: ?folderId= フォルダ絞り込み)
//   folderId は account 絞りに **重ねる** (§3.3b 3 状態: 無指定=全フォルダ+未分類 / 実 id=特定 / none=未分類)。
formsAdvanced.get('/api/forms-advanced', async (c) => {
  try {
    const lineAccountId = c.req.query('lineAccountId') || undefined;
    const folderId = c.req.query('folderId') || undefined;
    const isOwner = isOwnerCtx(c);
    const list = await listFormalooForms(c.env.DB, lineAccountId, folderId);
    const data = await Promise.all(list.map((f) => serializeForm(c.env.DB, f, isOwner)));
    return c.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/forms-advanced error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/forms-advanced — 新規 draft 作成 (F6-2: 表示スコープ + 作成先 workspace の server 権威解決)
formsAdvanced.post('/api/forms-advanced', async (c) => {
  try {
    const body = await c.req
      .json<{ title?: string; description?: string | null; onSubmitTagId?: string | null; onSubmitScenarioId?: string | null; submitMessage?: string | null; lineAccountId?: string | null; workspaceId?: string | null }>()
      .catch(() => ({}) as Record<string, never>);
    if (!body.title || !body.title.trim()) {
      return c.json({ success: false, error: 'フォーム名を入力してください' }, 400);
    }
    const isOwner = isOwnerCtx(c);
    // M-21 whitelist: 空文字は未指定扱い (非 owner の空文字が binding を迂回して env を選ぶのを防ぐ = Codex M#5)。
    const lineAccountId = typeof body.lineAccountId === 'string' && body.lineAccountId.trim() ? body.lineAccountId.trim() : null;
    const explicitWorkspaceId = typeof body.workspaceId === 'string' && body.workspaceId.trim() ? body.workspaceId.trim() : null;

    // §spec 3.4: workspace_id は **server が権威決定** (client body の workspaceId を無条件に信用しない / Codex B#1)。
    let workspaceId: string | null = null;
    if (explicitWorkspaceId) {
      // 明示 workspace 指定。
      if (!isOwner) {
        // 非 owner の非 null 明示は「他社鍵へ push する誤送信」の試み → fail-closed 403 (form を作らない)。
        return c.json({ success: false, error: 'ワークスペースの指定にはオーナー権限が必要です' }, 403);
      }
      // owner でも registry active でなければ 400 (未登録/is_active=0 = 参照整合性 / Codex M#4)。
      if (!(await isActiveFormalooWorkspace(c.env.DB, explicitWorkspaceId))) {
        return c.json({ success: false, error: '指定されたワークスペースは登録されていないか無効です' }, 400);
      }
      workspaceId = explicitWorkspaceId;
    } else if (lineAccountId) {
      // 明示無 + account 有 → account_binding の既定 (active のみ / 無効・未 binding は NULL で孤立させない)。
      workspaceId = await resolveDefaultWorkspace(c.env.DB, lineAccountId);
    }
    // ④ workspace 自動紐付け: 明示選択も binding 解決も無く workspace_id が NULL のまま孤立する UX 穴の恒久修正。
    //   active workspace が正確に 1 件だけなら自動採用 (0 件 / 2 件以上は曖昧 → NULL 維持 = env 単一鍵 fallback)。
    if (workspaceId === null) {
      workspaceId = await resolveSoleActiveWorkspace(c.env.DB);
    }

    const form = await createFormalooForm(c.env.DB, {
      title: body.title.trim(),
      description: body.description ?? null,
      onSubmitTagId: body.onSubmitTagId ?? null,
      onSubmitScenarioId: body.onSubmitScenarioId ?? null,
      submitMessage: body.submitMessage ?? null,
      lineAccountId,
      workspaceId,
      // form-design-presets ② (create-time seed / OD-2): デザイン未設定フォームが Formaloo 暗色
      //   デフォルト (#37352F 同色 = 入力欄不可視) に落ちる罠の根絶。既定パレット (line-green) を
      //   definition_json に seed → builder 初期表示に流れ → 初回 save で色 PATCH が Formaloo hosted に届く。
      //   defaultFormDesign() が単一正本。DAO は shared 非依存ゆえ FormDesign を import できず構造型で受ける
      //   (BLOCKING2)。FormDesign の値は全て string|null|undefined ゆえ構造型への cast は健全 (境界越えの橋渡し)。
      design: defaultFormDesign() as Record<string, string | null | undefined>,
    });
    return c.json({ success: true, data: await serializeForm(c.env.DB, form, isOwner) }, 201);
  } catch (err) {
    console.error('POST /api/forms-advanced error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/forms-advanced/:id — 詳細 (fields + logic + publish 状態)
formsAdvanced.get('/api/forms-advanced/:id', async (c) => {
  try {
    const form = await getFormalooForm(c.env.DB, c.req.param('id')!);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
    return c.json({ success: true, data: await serializeForm(c.env.DB, form, isOwnerCtx(c)) });
  } catch (err) {
    console.error('GET /api/forms-advanced/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/forms-advanced/:id/reapply-hosted — 保存済み見た目を hosted へ一発再反映。
// 境界は現デプロイ固有 D1 の id lookup + DB 保存済み workspace_id。body の slug/workspace は一切読まず、
// 登録済み workspace の鍵解決が失敗した場合も env 単一鍵へ fallback しない (resolveFormalooClient の fail-closed 契約)。
// field/logic/回答は保存も全置換 push もせず、service の管理 meta + video height 部分 PATCH だけを許可する。
formsAdvanced.post('/api/forms-advanced/:id/reapply-hosted', async (c) => {
  // 緊急 rollback: DB lookup / sync state 更新 / credential 解決 / Formaloo 通信より前に完全短絡する。
  if (c.env.FORMALOO_REAPPLY_DISABLE === '1') {
    return c.json({ success: false, error: '公開ページ再反映は一時停止中です' }, 503);
  }

  const id = c.req.param('id')!;
  let syncStarted = false;
  let syncSettled = false;
  try {
    const form = await getFormalooForm(c.env.DB, id);
    // 現 D1 に無い id（別デプロイ/テナントを含む）は存在を漏らさず 404。request body による補完は禁止。
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
    if (!form.formaloo_slug) {
      return c.json({ success: false, error: 'Formaloo への初回同期が完了していません' }, 409);
    }

    const client = await resolveFormalooClient(c.env, form.workspace_id);
    if (!client) {
      await setFormalooSyncState(c.env.DB, id, {
        syncStatus: 'out_of_sync',
        lastError: 'Formaloo credentials を保存済み workspace から解決できません',
      });
      syncSettled = true;
      return c.json({ success: false, error: 'Formaloo 接続情報を解決できません' }, 503);
    }

    const fieldMap = await getFormalooFieldMap(c.env.DB, id);
    const fieldSlugs: Record<string, string> = {};
    for (const row of fieldMap) {
      if (row.formaloo_field_slug) fieldSlugs[row.id] = row.formaloo_field_slug;
    }
    const definition = parseDefinition(form.definition_json);

    await setFormalooSyncState(c.env.DB, id, { syncStatus: 'pushing', lastError: null });
    syncStarted = true;
    const result = await reapplyHostedAppearance(
      client,
      form.formaloo_slug,
      definition,
      fieldSlugs,
      { localizationEnabled: c.env.FORMALOO_LOCALIZATION_DISABLE !== '1' },
    );

    if (result.ok) {
      await setFormalooSyncState(c.env.DB, id, {
        syncStatus: 'idle',
        lastError: null,
        lastPushedAt: new Date().toISOString(),
      });
    } else {
      const failed = Object.entries(result.parts)
        .filter(([, part]) => !part.ok)
        .map(([name, part]) => `${name}: ${part.error ?? 'failed'}`);
      await setFormalooSyncState(c.env.DB, id, {
        syncStatus: 'out_of_sync',
        lastError: `公開ページの再反映に失敗しました — ${failed.join(' / ')}`,
      });
    }
    syncSettled = true;
    return c.json({ success: result.ok, data: result });
  } catch (error) {
    if (syncStarted && !syncSettled) {
      try {
        await setFormalooSyncState(c.env.DB, id, {
          syncStatus: 'out_of_sync',
          lastError: '公開ページの再反映処理に失敗しました',
        });
      } catch {
        // D1 自体が利用不能なら outer 500 に任せる。
      }
    }
    console.error('POST /api/forms-advanced/:id/reapply-hosted error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/forms-advanced/:id — 定義保存 (validate → 永続化 → fail-soft push-sync)
formsAdvanced.put('/api/forms-advanced/:id', async (c) => {
  const id = c.req.param('id')!;
  let syncStarted = false;
  let syncSettled = false;
  try {
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);

    const body = await c.req
      .json<{ fields?: unknown[]; logic?: unknown[]; rawLogic?: unknown; logicFingerprint?: string; title?: unknown; description?: unknown; design?: unknown; designImages?: unknown; formType?: unknown; formCopy?: unknown; localizationJa?: unknown; formRedirect?: unknown; successPages?: unknown; operationsSettings?: unknown; allowPostEdit?: unknown; allowEditMail?: unknown; friendMetadataMappings?: unknown; editMailFieldId?: unknown }>()
      .catch(() => ({}) as { fields?: unknown[]; logic?: unknown[]; rawLogic?: unknown; logicFingerprint?: string; title?: unknown; description?: unknown; design?: unknown; designImages?: unknown; formType?: unknown; formCopy?: unknown; localizationJa?: unknown; formRedirect?: unknown; successPages?: unknown; operationsSettings?: unknown; allowPostEdit?: unknown; allowEditMail?: unknown; friendMetadataMappings?: unknown; editMailFieldId?: unknown });
    if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim())) {
      return c.json({ success: false, error: 'フォーム名を入力してください' }, 400);
    }
    const newTitle = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : form.title;
    const descProvided = body.description !== undefined;
    const newDescription = descProvided
      ? (typeof body.description === 'string' && body.description.trim() ? body.description : null)
      : form.description;
    // form-media-limits ③: allowPostEdit を 0|1 正規化 (present-key: 未指定は undefined = D1 値を変えない)。
    //   Formaloo push には渡さない (soft-200 theater 非送信) = harness 側 D1 保存のみ。実効化は弾M。
    const allowPostEdit = body.allowPostEdit === undefined
      ? undefined
      : (body.allowPostEdit === 1 || body.allowPostEdit === true || body.allowPostEdit === '1' ? 1 : 0);
    // form-edit-mail-link (弾L): allowEditMail を 0|1 正規化 (present-key: 未指定は undefined = D1 値を変えない)。
    //   Formaloo push には渡さない (harness 側 D1 保存のみ)。実効化は公開編集 route + Phase B のメール発火。
    const allowEditMail = body.allowEditMail === undefined
      ? undefined
      : (body.allowEditMail === 1 || body.allowEditMail === true || body.allowEditMail === '1' ? 1 : 0);
    // row-status-friend-sync: present-key の時だけ canonicalize。未指定は独立列を保持、[] は明示解除。
    const friendMetadataMappingsProvided = body.friendMetadataMappings !== undefined;
    let friendMetadataMappings: FriendMetadataMapping[] | undefined;
    if (friendMetadataMappingsProvided) {
      const validation = validateFriendMetadataMappings(body.friendMetadataMappings);
      if (!validation.ok) return c.json({ success: false, error: validation.error }, 400);
      friendMetadataMappings = validation.mappings;
    }
    // route-terminal-phase2 (T-B2 / CI-4/CX-7): redirect URL は Formaloo server が無検証 STORE する (spike M7)
    //   → worker authoritative gate で raw body.formRedirect を厳格検証し、危険 URL/非 string を push 前に 400
    //   で明示 reject する (normalize の silent drop に頼らない = builder バイパスの直 API 濫用も塞ぐ)。
    const redirectInputCheck = validateFormRedirectInput(body.formRedirect);
    if (!redirectInputCheck.ok) return c.json({ success: false, error: redirectInputCheck.error }, 400);
    // treasure B2: present-key の時だけ管理6 camelCase key を厳格検証。未知 key は whitelist drop。
    const operationsSettingsProvided = body.operationsSettings !== undefined;
    let operationsSettingsPatch: FormOperationsSettingsPatch = {};
    if (operationsSettingsProvided) {
      const validation = validateFormOperationsSettingsPatch(body.operationsSettings);
      if (!validation.ok) return c.json({ success: false, error: validation.error }, 400);
      operationsSettingsPatch = validation.patch;
    }
    const rawFields = Array.isArray(body.fields) ? body.fields : [];
    const rawLogicRules = Array.isArray(body.logic) ? body.logic : [];

    // field を MVP subset で検証 (M-21 明示 reject)。1 つでも不正なら 400。
    const fields: HarnessField[] = [];
    for (let i = 0; i < rawFields.length; i++) {
      const r = validateHarnessField({ ...(rawFields[i] as object), position: (rawFields[i] as { position?: number }).position ?? i });
      if (!r.ok) return c.json({ success: false, error: `フィールド ${i + 1}: ${r.error}` }, 400);
      fields.push(r.field);
    }
    // Phase B / G-1: client は internal id を送り、server が save 対象の email 型だけを受理して remote slug へ解決する。
    // key 不在=既存選択を維持 / null=明示解除。unknown・非 email は第三者誤送信防止のため fail-closed 400。
    const editMailFieldIdProvided = Object.prototype.hasOwnProperty.call(body, 'editMailFieldId');
    let editMailFieldId: string | null | undefined;
    if (editMailFieldIdProvided) {
      if (body.editMailFieldId === null) {
        editMailFieldId = null;
      } else if (typeof body.editMailFieldId !== 'string' || !body.editMailFieldId) {
        return c.json({ success: false, error: '編集URLメールの宛先項目が不正です' }, 400);
      } else {
        const selected = fields.find((field) => field.id === body.editMailFieldId);
        if (!selected || selected.type !== 'email') {
          return c.json({ success: false, error: '編集URLメールの宛先にはメール項目を選んでください' }, 400);
        }
        editMailFieldId = selected.id;
      }
    }
    // form-image-decoration: 差し込み画像の upload intent (dataUrl) を R2 host へ解決し imageUrl を確定する
    //   (validateHarnessField 済 = dataUrl は 10MB/MIME 検証済)。imageUpload は D1/push に残さない (巨大 base64 非永続)。
    //   upload 失敗は 400 で止める (owner に「置いたのに出ない」を出さない honest surface)。image 無フォームは no-op。
    const imgOrigin = new URL(c.req.url).origin;
    const imgResolved = await resolveInBodyImageUploads(fields, (dataUrl) => uploadImageDataUrlToR2(c.env, dataUrl, id, imgOrigin));
    if (!imgResolved.ok) return c.json({ success: false, error: `画像のアップロードに失敗しました：${imgResolved.error}` }, 400);
    // logic は既存 field id を参照する rule だけ残す (孤立参照防止 / N-11)。
    // compound rule (additive actions[]) は flat target だけでなく **全アクション target** を idSet 照合し、
    // 存在 field を参照する compound は保持・dangling ref を作る rule のみ除去 (R-4/L-9/D-12)。
    const fieldIds = new Set(fields.map((f) => f.id));
    const decorationIds = new Set(fields.filter((f) => isDecorationType(f.type)).map((f) => f.id));
    const prevDef = parseDefinition(form.definition_json);
    // present-key 部分更新を保存済み canonical へ merge。false/null で全解除された時は空 object = JSON key を載せない。
    const operationsSettingsToPersist = operationsSettingsProvided
      ? mergeFormOperationsSettings(prevDef.operationsSettings, operationsSettingsPatch)
      : prevDef.operationsSettings;
    // Formaloo へは実測済み管理5 snake_case key だけを送る。UTM は Harness 公開導線だけの intent。
    const operationsUpdateFields = operationsSettingsProvided
      ? formOperationsFields(operationsSettingsPatch)
      : {};
    // route-terminal-phase2 (Track 2 / T-D1): 有効な success-page 集合を先に確定する。
    //   successPages 提供時は incoming、未提供は prev を carry (submit rule が既存 SP を参照し続けられる)。
    const successPagesProvided = body.successPages !== undefined;
    const incomingSuccessPages = successPagesProvided ? normalizeSuccessPages(body.successPages) : undefined;
    const successPagesForValidation = incomingSuccessPages ?? prevDef.successPages ?? [];
    const successPageIds = new Set(successPagesForValidation.map((sp) => sp.id));
    const logic: HarnessLogicRule[] = (rawLogicRules as HarnessLogicRule[]).filter((r) => {
      if (!r || !fieldIds.has(r.sourceFieldId)) return false;
      // route-terminal-submit (T-C3/F-MED-2): submit rule は target を idSet 照合しない (下段で Phase1 '' 正規化)。
      //   Phase1 は success-page 未対応ゆえ target は最終的に '' (既定完了ページ) へ正規化する。source のみ検証。
      if (r.action !== 'submit' && !fieldIds.has(r.targetFieldId)) return false;
      // 条件源 (source) は常に実入力 field (decoration を条件源にしない)。
      if (decorationIds.has(r.sourceFieldId)) return false;
      // target: form-route-branching — jump は page_break(改ページ=decoration)へ飛ぶのが正。
      //   show/hide/skip は従来通り非 decoration field のみ。submit は target を正規化するゆえ照合しない。
      if (r.action !== 'jump' && r.action !== 'submit' && decorationIds.has(r.targetFieldId)) return false;
      if (Array.isArray(r.conditions)) {
        for (const condition of r.conditions) {
          if (condition && decorationIds.has(condition.sourceFieldId)) return false;
        }
      }
      if (Array.isArray(r.actions)) {
        for (const a of r.actions) {
          if (!a || !fieldIds.has(a.targetFieldId)) return false;
          if (a.action !== 'jump' && decorationIds.has(a.targetFieldId)) return false;
        }
      }
      return true;
    })
    // route-terminal-phase2 (T-D1 / F-MED-2 解除): submit rule の target が有効 SP (successPageIds) を指すなら
    //   保持する (push で resolve 済 slug が jump_to_success_page.args.identifier に載る)。無効/未選択/通常 field を
    //   指す target は '' へ縮退 (既定完了ページ) — 直接 API 濫用で不正 SP 参照が remote logic に載るのを防ぐ。
    .map((r) => {
      if (r.action !== 'submit') return r;
      if (r.targetFieldId && successPageIds.has(r.targetFieldId)) return r; // 有効 SP を保持
      return r.targetFieldId !== '' ? { ...r, targetFieldId: '' } : r; // 無効は既定完了ページへ縮退
    });

    // ── preserve-raw edit-detection (R7) ──
    // pull 時 fingerprint (body 経由) と save 対象 logic の canonical hash を突合。一致=未編集。
    // fingerprint 不在 (レガシー/非 pull 保存) は fail-safe で「編集扱い」(silent 消失を起こさない)。
    const incomingFingerprint = typeof body.logicFingerprint === 'string' ? body.logicFingerprint : null;
    const currentFingerprint = logicFingerprint(logic);
    const logicUnedited = incomingFingerprint != null && incomingFingerprint === currentFingerprint;
    // preserve 元 raw: fresh pull carry (body.rawLogic) 優先、無ければ D1 の前回 rawLogic (reload carry)。
    const carriedRawLogic = body.rawLogic != null ? body.rawLogic : prevDef.rawLogic;
    const hadRawLogic = body.rawLogic != null || prevDef.rawLogic != null;

    // preserve / 従来 / compound-edit の分岐。
    let logicToPush: HarnessLogicRule[] = logic; // Formaloo へ送る harness logic (compound-edit 時は空)
    let preserveRawLogic: unknown = undefined; // 未編集時に PATCH で verbatim 再送する bare array
    let persistRawLogic: unknown = undefined; // definition_json に保存する rawLogic
    let compoundEditWarning: string | null = null;
    // route-terminal-submit (T-C5): 編集で logic が空になったら remote logic を明示クリア (最後の submit 削除で
    //   Formaloo 側の早期送信が残らないように PATCH {logic:[]} を送る)。preserve / compound-refuse では立てない。
    //   F-HIGH-1: 前回 logic (harness or raw or **carriedRawLogic=fresh pull carry**) が非空だった時のみ = design/metadata
    //   のみ save (元々 logic 無し) では立てない。fresh pull(body.rawLogic)→submit 削除の経路も carriedArray で拾う。
    const prevRawArr = serializeRawLogicForPush(prevDef.rawLogic);
    const carriedArray = serializeRawLogicForPush(carriedRawLogic);
    const prevHadLogic =
      (Array.isArray(prevDef.logic) && prevDef.logic.length > 0) ||
      (prevRawArr != null && prevRawArr.length > 0) ||
      (carriedArray != null && carriedArray.length > 0);
    let clearRemoteLogicIfEmpty = false;
    if (logicUnedited) {
      if (carriedRawLogic != null) {
        preserveRawLogic = carriedRawLogic;
        persistRawLogic = carriedRawLogic;
      }
      // carriedRawLogic 無し (レガシー) は下の client ブロックで re-pull backfill (R6)。
    } else if (hadRawLogic) {
      // route-terminal-submit (T-A8): raw が **display 完全** (全 item が multi-jump / terminal-expandable) なら編集後
      //   logic を安全に再生成 push できる (欠けなく往復・display に映る全 rule から再構成)。
      //   F-CRIT-1: countWeakened===0 判定は誤り — 単一 show/hide/jump は非計上だが display filter で表示から落ちる。
      //   raw=[show, submit] で countWeakened=0 かつ show 非表示 → regenerate で show が silent 消失した。
      //   → 判定を **display 完全性** (全 item が isExpandableMultiJumpItem||isExpandableTerminalItem) へ是正。
      //   1 件でも非 expandable (show/hide/standalone jsp/always submit/AND-OR compound) があれば refuse (remote 保持)。
      const terminalOnly =
        carriedArray != null && carriedArray.every((it) => isExpandableMultiJumpItem(it) || isExpandableTerminalItem(it));
      if (terminalOnly) {
        logicToPush = logic; // 編集後 harness logic を再生成 push
        persistRawLogic = undefined; // raw は再生成 logic に置き換え (次回 reload は re-pull backfill)
        if (logic.length === 0 && prevHadLogic) clearRemoteLogicIfEmpty = true; // 全 submit/jump 削除 → remote 空へ
      } else {
        // 複合ロジック (Formaloo 由来 raw あり) を builder で編集 → Batch 1 は merge 不可 (Batch 2)。
        // 破壊的な logic 全置換 push を **行わず** ローカル保存を維持し、未同期 + 明示警告 (silent 消失回避 /
        // failure_observable「保持はするが push で落とす」を防ぐ)。複合編集は Formaloo 側で行う導線を提示。
        logicToPush = [];
        persistRawLogic = undefined; // stale raw は破棄 (次回 reload は re-pull backfill 経路)
        compoundEditWarning =
          '複合ロジックを編集したため未同期です。複合条件（AND/OR・複数アクション・計算）は Formaloo 側で編集してください（この画面での複合編集は今後対応）。';
      }
    } else if (logic.length === 0 && prevHadLogic) {
      // 純ハーネス logic (raw 無し) を非空→空へ編集 → remote logic を明示クリア (早期送信/分岐が remote に残らない)。
      //   元々 logic 無しの design/metadata のみ save では立てない (byte 不変・回帰)。
      clearRemoteLogicIfEmpty = true;
    }
    // else: 純ハーネス logic の編集 (raw 無し・非空) → 従来通り push。
    // B3: 最初の save (field_map 全置換) より前に既存 field_map の slug を捕捉。
    // これで (a) push へ update-vs-create の追跡キーを渡せ (重複作成を根絶)、(b) 最初の save で slug を
    // carry して push 失敗時も slug を喪失しない (次回保存で PATCH 復帰 = 重複再発防止)。
    const existingMap = await getFormalooFieldMap(c.env.DB, id);
    const existingFieldSlugs: Record<string, string> = {};
    for (const row of existingMap) {
      if (row.formaloo_field_slug) existingFieldSlugs[row.id] = row.formaloo_field_slug;
    }
    // 新規 email field は push 前には slug 未確定なので一旦 null (fail-closed)。push 成功後の save で確定値へ更新する。
    // key 不在は undefined のまま DAO present-key semantics で既存設定を維持する。
    const editMailFieldSlugBeforePush = editMailFieldId === undefined
      ? undefined
      : editMailFieldId === null
        ? null
        : existingFieldSlugs[editMailFieldId] ?? null;
    // F1 TOCTOU 窓閉じ: D1 定義を書き換える前に sync_status='pushing' へ先行遷移する。これで保存中 (D1 定義が
    // 新ローカル内容に置き換わり push 完了まで) の窓に cron drift-check が割り込んでも、非 idle を見て auto-apply
    // せず conflict_held に落ちる (ローカル編集の silent 上書き防止)。窓終了時に下の終端 setSyncState が
    // idle/out_of_sync へ確定させる。baseline/drift 列はここでは触らない (終端の T-C2 無効化に委ねる)。
    await setFormalooSyncState(c.env.DB, id, { syncStatus: 'pushing' });
    syncStarted = true;
    // まず D1 に保存 (SoT キャッシュ / fail-soft の土台)。field_map の slug は既存分を carry する
    // (現状は無 carry = slug wipe の欠陥。push 失敗時に喪失し次回保存で重複 POST になっていた / B3)。
    // ── form-design (Batch D) ──
    // update 意味論: design 未提供 (body に design key 無し) は Formaloo 色 PATCH を送らず prev design を carry。
    // 提供時は normalizeFormDesign (whitelist / 不正色/不正 URL drop) → prev に merge (色は panel の全設定 /
    // 画像 URL は intent 反映後に上書き)。designToPersist は let: 画像 upload 後の S3 URL を反映して再永続する。
    const designProvided = body.design !== undefined;
    const incomingDesign = designProvided ? normalizeFormDesign(body.design) : undefined;
    const designImages = body.designImages && typeof body.designImages === 'object' && !Array.isArray(body.designImages)
      ? (body.designImages as FormDesignImages)
      : undefined;
    let designToPersist: FormDesign | undefined = designProvided
      ? { ...(prevDef.design ?? {}), ...incomingDesign }
      : prevDef.design;

    // ── form-route-branching (R2): form_type ──
    // body.formType が有効値なら採用、無ければ prev を carry (未提供 save で勝手に変えない = byte 不変)。
    const incomingFormType: FormDisplayType | undefined =
      body.formType === 'simple' || body.formType === 'multi_step' ? body.formType : undefined;
    const formTypeToPersist: FormDisplayType | undefined = incomingFormType ?? prevDef.formType;

    // ── form-jp-localization: 公開ページ文言 (button_text/success_message/error_message) ──
    // update 意味論: formCopy 未提供 (body に formCopy key 無し) は Formaloo に文言を送らず prev を carry
    //   (既存フォームの文言を勝手に変えない = failure_observable 直対応)。提供時は normalizeFormCopy
    //   (whitelist / 非空 trim) を prev に merge (set/absent MVP: 空欄=未指定=触らない = 誤消去しない・
    //   clear=既定戻しは backlog / plan §4)。design/formType と同型の additive-optional。
    const formCopyProvided = body.formCopy !== undefined;
    const incomingFormCopy = formCopyProvided ? normalizeFormCopy(body.formCopy) : undefined;
    const formCopyToPersist: FormCopy | undefined = formCopyProvided
      ? { ...(prevDef.formCopy ?? {}), ...incomingFormCopy }
      : prevDef.formCopy;

    // hosted UI chrome 日本語化: boolean present-key のみ更新し、未指定 save は既存 intent を byte 同等 carry。
    // 緊急 rollback は FORMALOO_LOCALIZATION_DISABLE='1'。このとき入力 flag の永続化・GET/PATCH/confirm を
    // すべて短絡し、既存 definition_json と通常保存経路を変えない。OFF(false) は管理 key のみを明示解除する。
    const localizationProvided = c.env.FORMALOO_LOCALIZATION_DISABLE !== '1'
      && typeof body.localizationJa === 'boolean';
    const localizationJaToPersist = localizationProvided
      ? body.localizationJa as boolean
      : prevDef.localizationJa;

    // ── route-terminal-phase2 (Track 1): 送信後リダイレクト設定 ──
    // update 意味論 (**replace**・formCopy の merge とは異なる): formRedirect は url+toggle が 1 論理単位ゆえ
    //   提供時は normalize 済で **全置換** (merge すると url クリア時に prev url が残る CX-4 バグ)。未提供は prev carry
    //   (未提供 save で勝手に消さない = byte 不変)。CX-4 clear: 提供かつ url 空/検証落ち かつ prev に url あり →
    //   form_redirects_after_submit:null を送って remote redirect を解除する (空を silent drop で不能にしない)。
    const formRedirectProvided = body.formRedirect !== undefined;
    const incomingFormRedirect = formRedirectProvided ? normalizeFormRedirect(body.formRedirect) : undefined;
    const formRedirectToPersist: FormRedirect | undefined = formRedirectProvided
      ? incomingFormRedirect
      : prevDef.formRedirect;
    const redirectCleared = formRedirectProvided && !incomingFormRedirect?.url && !!prevDef.formRedirect?.url;

    // ── route-terminal-phase2 (Track 2): ルート別完了ページ (successPages) ──
    // update 意味論: 未提供は prev を carry (SP を触らない = byte 不変)。提供時は incoming を desired として
    //   reconcile (push が create/update + 削除除外分の DELETE を実行)。reconcile 後の割当 slug を push が返し
    //   successPagesToPersist を更新 → definition_json へ slug を永続 (非冪等 POST の重複作成防止 / CI-3)。
    let successPagesToPersist: SuccessPageSpec[] | undefined = successPagesProvided ? incomingSuccessPages : prevDef.successPages;

    // jump+simple backstop (最後の砦): jump rule があるのに表示形式が multi_step でない → 非ブロッキング警告。
    // (builder の自動切替=主機構が働けば発火しない。API 直叩き/手動戻しの取りこぼしを save レスポンスで surface。)
    const hasJumpRule = logic.some((r) => r.action === 'jump');
    const saveWarnings: string[] = [];
    if (hasJumpRule && formTypeToPersist !== 'multi_step') {
      saveWarnings.push(
        '「ページへ飛ぶ」分岐がありますが、表示形式が「1問ずつ表示」ではありません。ページ移動は「1問ずつ表示（multi_step）」でのみ動作します。表示形式を切り替えてください。',
      );
    }
    // route-terminal-submit (T-D1): なだれ込み/送信不能/データ損失 lint を save レスポンス warnings に additive 合流。
    //   純 show/hide フォームは 0 件 (computeRouteTerminalWarnings 保証) = 既存 backstop 文言は byte 不変。
    for (const w of computeRouteTerminalWarnings(fields, logic, formTypeToPersist)) saveWarnings.push(w);

    // preserve-raw: rawLogic (逐語) + logicFingerprint を additive JSON key で同梱 (migration 不要 / L-10)。
    const buildDefinitionJson = (address: string | null): string =>
      JSON.stringify({
        fields,
        logic,
        formalooAddress: address,
        ...(persistRawLogic != null ? { rawLogic: persistRawLogic } : {}),
        logicFingerprint: currentFingerprint,
        // form-design: design が非空のときだけ載せる (未設定フォームは従来と byte 一致 = 後方互換)。
        ...(designToPersist && Object.keys(designToPersist).length ? { design: designToPersist } : {}),
        // form-route-branching: formType が有効なときだけ載せる (未設定フォームは byte 一致 = 後方互換)。
        ...(formTypeToPersist ? { formType: formTypeToPersist } : {}),
        // form-jp-localization: 文言が非空のときだけ載せる (未設定フォームは byte 一致 = 後方互換)。
        ...(formCopyToPersist && Object.keys(formCopyToPersist).length ? { formCopy: formCopyToPersist } : {}),
        // UI chrome intent は false も解除状態として保持。未管理(undefined)だけ key を載せない。
        ...(typeof localizationJaToPersist === 'boolean' ? { localizationJa: localizationJaToPersist } : {}),
        // route-terminal-phase2: redirect が非空のときだけ載せる (未設定/クリア後は byte 一致 = 後方互換)。
        ...(formRedirectToPersist && Object.keys(formRedirectToPersist).length ? { formRedirect: formRedirectToPersist } : {}),
        // route-terminal-phase2 (Track 2): successPages が非空のときだけ載せる (割当 slug 込み・未設定は byte 一致)。
        ...(successPagesToPersist && successPagesToPersist.length ? { successPages: successPagesToPersist } : {}),
        // treasure B2: false/null/未設定は canonical から落とし、既存フォームの definition JSON に key を足さない。
        ...(operationsSettingsToPersist && Object.keys(operationsSettingsToPersist).length
          ? { operationsSettings: operationsSettingsToPersist }
          : {}),
      });
    const fieldRows = (slugFor: (fid: string) => string | null) =>
      fields.map((f) => ({ id: f.id, formalooFieldSlug: slugFor(f.id), fieldType: f.type, label: f.label, position: f.position, configJson: JSON.stringify(f.config) }));
    await saveFormalooDefinition(c.env.DB, id, {
      definitionJson: buildDefinitionJson(prevDef.formalooAddress ?? null),
      fields: fieldRows((fid) => existingFieldSlugs[fid] ?? null),
      title: newTitle,
      description: newDescription,
      // form-media-limits ③: harness 側 D1 保存のみ (push しない)。present-key = 未指定は不変。
      allowPostEdit,
      // form-edit-mail-link (弾L): 同上 harness 側 D1 保存のみ (Formaloo push しない)。present-key = 未指定は不変。
      allowEditMail,
      friendMetadataMappingsJson: friendMetadataMappingsProvided
        ? JSON.stringify(friendMetadataMappings ?? [])
        : undefined,
      // Phase B / G-1: builder 明示 internal id を既知の remote slug に解決。先頭 email fallback は禁止。
      editMailFieldSlug: editMailFieldSlugBeforePush,
    });

    // ④ 保存時 re-bind: key 登録前に作られた孤立 form (workspace_id=NULL) は、保存のたびに active workspace が
    //   1 件だけなら自動採用して恒久修正 (env fallback から登録鍵へ昇格)。曖昧 (0 / 2 件以上) は NULL 維持。
    let effectiveWorkspaceId = form.workspace_id;
    if (effectiveWorkspaceId == null) {
      const sole = await resolveSoleActiveWorkspace(c.env.DB);
      if (sole) {
        await setFormalooFormWorkspace(c.env.DB, id, sole);
        effectiveWorkspaceId = sole;
      }
    }
    // Formaloo へ push (fail-soft): secret 未配備 (dev) や失敗は out_of_sync でローカル保存を維持
    // F6-2: effectiveWorkspaceId で多鍵解決。NULL(legacy) → env 単一鍵 fallback (byte-equivalent) /
    // 登録 active → 暗号文鍵 / 未登録・無効化・復号失敗 → null (env silent fallback しない = 誤送信防止)。fail-soft 契約不変。
    const client = await resolveFormalooClient(c.env, effectiveWorkspaceId);
    if (!client) {
      await setFormalooSyncState(c.env.DB, id, { syncStatus: 'out_of_sync', lastError: 'Formaloo credentials 未設定 (S-1 待ち)' });
      syncSettled = true;
    } else {
      // legacy backfill (R6): 未編集 かつ preserve 元 raw 未取得 かつ formaloo_slug あり → push 前に re-pull で
      // 現行 Formaloo raw を取得し、射影 fingerprint が未編集 logic と一致すれば preserve 経路へ。
      // re-pull 不能 / divergent は preserve せず従来 push (silent 消失なし)。
      if (logicUnedited && preserveRawLogic === undefined && form.formaloo_slug) {
        const bySlug = new Map<string, string>();
        for (const row of existingMap) if (row.formaloo_field_slug) bySlug.set(row.formaloo_field_slug, row.id);
        const repull = await pullDefinitionFromFormaloo(client, {
          formalooSlug: form.formaloo_slug,
          resolveId: (s) => bySlug.get(s) ?? s,
        });
        if (repull.ok && repull.rawLogic != null && repull.logicFingerprint === currentFingerprint) {
          preserveRawLogic = repull.rawLogic;
          persistRawLogic = repull.rawLogic;
        }
      }
      const pushed = await pushDefinitionToFormaloo(client, {
        formalooSlug: form.formaloo_slug,
        title: newTitle,
        description: newDescription,
        fields,
        logic: logicToPush,
        existingFieldSlugs,
        preserveRawLogic,
        // route-terminal-submit (T-C5): 編集で logic 空になった時 remote logic を明示クリア (PATCH {logic:[]})。
        clearLogicIfEmpty: clearRemoteLogicIfEmpty,
        // form-route-branching R2: baseline 差分時のみ form_type PATCH (勝手に変えない)。
        formType: formTypeToPersist,
        prevFormType: prevDef.formType,
        // route-terminal-phase2 (Track 2): successPages を reconcile (提供時のみ)。prev で slug carry + 削除検出。
        successPages: successPagesProvided ? incomingSuccessPages : undefined,
        prevSuccessPages: prevDef.successPages,
        // fr-id-capture-fix (T-C3): friend system hidden field (fr_id/fr_name) を publish 経路で冪等 auto-push
        //   (両テナント共通 = ks/piecemaker とも同 route)。既定有効・env で無効化 = rollback (D-4)。
        //   fr_name(PII) は別 gate (FORMALOO_FR_NAME_AUTOPUSH_DISABLE) で切れる (owner-gate / codex#8)。
        ensureSystemFields: c.env.FORMALOO_SYSTEM_FIELDS_AUTOPUSH_DISABLE !== '1',
        includeOwnerGatedSystemFields: c.env.FORMALOO_FR_NAME_AUTOPUSH_DISABLE !== '1',
        // treasure B2: form 単位 UTM intent ON の時だけ exact 3 hidden aliases を friend prefix 後へ冪等 ensure。
        includeUtmSystemFields: operationsSettingsToPersist?.utmTracking === true,
        // fr-id-hardening-round2 (③): 新規 field に alias=slug を標準付与 (Formaloo hosted prefill は alias 一致でのみ発火し
        //   /fo は回答 prefill を slug-keyed で組む)。既定有効・env で無効化 = rollback。両テナント共通 route。
        setFieldAlias: c.env.FORMALOO_FIELD_ALIAS_AUTOSET_DISABLE !== '1',
      });
      // route-terminal-phase2 (Track 2): reconcile 後の割当 slug 付き successPages を永続対象へ反映
      //   (POST 成功後の slug を definition_json に残し次回保存で再 POST しない = 非冪等重複作成の根絶)。
      if (pushed.successPages) successPagesToPersist = pushed.successPages;
      const editMailFieldSlugAfterPush = editMailFieldId === undefined
        ? form.edit_mail_field_slug
        : editMailFieldId === null
          ? null
          : pushed.fieldSlugs?.[editMailFieldId] ?? existingFieldSlugs[editMailFieldId] ?? null;
      if (pushed.ok) {
        // slug + address + (backfill 後の) rawLogic + design(色) を反映
        await saveFormalooDefinition(c.env.DB, id, {
          definitionJson: buildDefinitionJson(pushed.publicAddress ?? prevDef.formalooAddress ?? null),
          fields: fieldRows((fid) => pushed.fieldSlugs?.[fid] ?? null),
          formalooSlug: pushed.formalooSlug ?? null,
          title: newTitle,
          description: newDescription,
          // 新規 field を含め、push が確定した remote slug だけを明示宛先として保存する。
          editMailFieldSlug: editMailFieldId === undefined ? undefined : editMailFieldSlugAfterPush,
        });
        const slug = pushed.formalooSlug ?? form.formaloo_slug;
        // b1-field-polish: 星色 custom_css を rating-gated で meta PATCH body に合流 (別キー disjoint・designColorFields 不改変)。
        //   rating field ≥1 → 現行 custom_css を GET し managed block を非破壊 merge。rating 無/明示クリア/GET 失敗は {} (byte 不変)。
        const ratingStarCssFields = slug
          ? await resolveRatingStarCustomCss(client, slug, fields, designToPersist)
          : {};
        // `combined_localized_content` ではなく現行 `localized_content` を GET し、管理 key だけを非破壊 merge。
        // flag 未指定または kill-switch 中は GET 自体を行わない。
        const localizedFields = slug && localizationProvided
          ? await localizedContentFields(client, slug, localizationJaToPersist as boolean)
          : {};
        // D-7: edit-mail 対象フォームだけ submit-time の受付番号/PDF生成を additive 有効化する。
        // kill-switch OFF・両 form flag・明示宛先 slug の AND gate。OFF 時は false を送らず既存 remote 設定を不可触にする。
        const receiptSettingsEnabled = c.env.FORM_EDIT_MAIL_ENABLED === 'true'
          && (allowPostEdit ?? form.allow_post_edit) === 1
          && (allowEditMail ?? form.allow_edit_mail) === 1
          && editMailFieldSlugAfterPush != null;
        const receiptSettingsFields = receiptSettingsEnabled
          ? {
              show_submit_tracking_code: true,
              assign_submit_number: true,
              generate_pdf_for_user: true,
            }
          : {};
        // form-design: 色は既存 meta PATCH に **JSON-string RGBA** で合流 (update 意味論: design 未提供なら載せない)。
        //   partial update 破壊防止 (#9): incomingDesign でなく **merged designToPersist** を送り、単色変更でも
        //   remote に残る 6 色が古い形式/欠落で残らないよう 7 色を原子送する。design 未提供は空 {} (design=null 不可触)。
        const metaRes = slug
          ? await client.request('PATCH', `/v3.0/forms/${slug}/`, {
              title: newTitle,
              description: newDescription ?? '',
              ...(designProvided ? designColorFields(designToPersist) : {}),
              ...ratingStarCssFields,
              // form-jp-localization: 文言も同一 meta PATCH に additive 合流 (present-key only)。
              //   未提供は載せない (prev 文言を Formaloo 側で誤って潰さない = update 意味論)。
              ...(formCopyProvided ? formCopyFields(formCopyToPersist) : {}),
              ...localizedFields,
              ...receiptSettingsFields,
              // treasure B2: FormUpdateRequest 実測済み管理5 keyだけを present-key で合流。
              ...operationsUpdateFields,
              // route-terminal-phase2: redirect も同一 meta PATCH に additive 合流。CX-4 clear は明示 null で解除。
              //   未提供は載せない (prev redirect を誤って潰さない)。design/formCopy と別 key で byte disjoint。
              ...(formRedirectProvided
                ? (redirectCleared ? { form_redirects_after_submit: null } : redirectFields(formRedirectToPersist))
                : {}),
            })
          : { ok: false as const, status: 0 };
        // form-design 画像: meta 成功後に replace(multipart)/remove(JSON null) を反映し、確定 S3 URL を再永続。
        // F1: applyDesignImages 失敗 (replace/remove の非 ok・不正 payload) は imageSyncError に集約し、
        //     下の sync 判定で out_of_sync へ合流させる (silent success 禁止)。成功 slot のみ URL を確定。
        let imageSyncError: string | null = null;
        // bg-fullpage-render-fix (FAIL-1): applyDesignImages が確定した URL を confirm の期待値に thread する
        //   (差し替えで旧 URL が残る soft-200 を「非空」だけでは検知できないため applied URL と一致照合する)。
        let appliedBgUrl: string | null | undefined;
        let appliedLogoUrl: string | null | undefined;
        if (metaRes.ok && slug && designImages) {
          const applied = await applyDesignImages(client, slug, designImages);
          if (!applied.ok) imageSyncError = applied.error ?? '画像の同期に失敗しました';
          if ('backgroundImageUrl' in applied) appliedBgUrl = applied.backgroundImageUrl;
          if ('logoUrl' in applied) appliedLogoUrl = applied.logoUrl;
          designToPersist = { ...(designToPersist ?? {}) };
          if ('logoUrl' in applied) {
            if (applied.logoUrl == null) delete designToPersist.logoUrl;
            else designToPersist.logoUrl = applied.logoUrl;
          }
          if ('backgroundImageUrl' in applied) {
            if (applied.backgroundImageUrl == null) delete designToPersist.backgroundImageUrl;
            else designToPersist.backgroundImageUrl = applied.backgroundImageUrl;
          }
          await saveFormalooDefinition(c.env.DB, id, {
            definitionJson: buildDefinitionJson(pushed.publicAddress ?? prevDef.formalooAddress ?? null),
            fields: fieldRows((fid) => pushed.fieldSlugs?.[fid] ?? null),
            formalooSlug: pushed.formalooSlug ?? null,
            title: newTitle,
            description: newDescription,
          });
        }
        // T-B2 soft-200 対策: meta PATCH は受理不能な色形式/存在しないキーを soft-200 で無言無視するため、
        //   metaRes.ok だけを idle 根拠にすると「保存済に見えて hosted に出ない」殻完了を再発させる。
        //   confirmed key の独立 GET-after-PATCH (bounded retry) で反映を確認し、不一致は out_of_sync に落とす
        //   (applyDesignImages と同型の honest surface)。色を送らない経路 (design 未提供/色なし) は GET せず素通り。
        let designReflectError: string | null = null;
        if (metaRes.ok && slug && designProvided && designToPersist) {
          const reflected = await confirmDesignReflected(client, slug, designToPersist);
          if (!reflected.ok) designReflectError = reflected.error ?? '配色が公開ページに反映されませんでした';
        }
        // form-jp-localization: 文言も soft-200 対策の GET-after-PATCH 確認 (design と同型・別 helper で file-disjoint)。
        //   送った文言が hosted に反映されない (soft-200 無言無視) を honest surface する。文言を送らない経路は GET せず素通り。
        let formCopyReflectError: string | null = null;
        if (metaRes.ok && slug && formCopyProvided && formCopyToPersist) {
          const reflected = await confirmFormCopyReflected(client, slug, formCopyToPersist);
          if (!reflected.ok) formCopyReflectError = reflected.error ?? '文言が公開ページに反映されませんでした';
        }
        // localized_content も soft-200 を必ず GET-after-PATCH 確認。既に目的状態で PATCH が不要だった場合も、
        // GET 失敗を成功扱いしないため明示 intent がある限り確認する。OFF は管理 key 全件不在を確認する。
        let localizedContentReflectError: string | null = null;
        if (metaRes.ok && slug && localizationProvided) {
          const reflected = await confirmLocalizedContentReflected(client, slug, localizationJaToPersist as boolean);
          if (!reflected.ok) localizedContentReflectError = reflected.error ?? '日本語 UI が公開ページに反映されませんでした';
        }
        // route-terminal-phase2: redirect も soft-200 対策の GET-after-PATCH 確認 (design/formCopy と同型・別 helper)。
        //   送った URL が hosted に反映されない (soft-200 無言無視) を honest surface。clear(null)/未提供は GET せず素通り。
        let redirectReflectError: string | null = null;
        if (metaRes.ok && slug && formRedirectProvided && !redirectCleared && formRedirectToPersist) {
          const reflected = await confirmRedirectReflected(client, slug, formRedirectToPersist);
          if (!reflected.ok) redirectReflectError = reflected.error ?? '飛び先 URL が公開ページに反映されませんでした';
        }
        // treasure B2: PATCH 200 は soft-ignore され得るため、管理5 key を独立 GET data.form.* で確認する。
        let operationsReflectError: string | null = null;
        if (metaRes.ok && slug && Object.keys(operationsUpdateFields).length > 0) {
          const reflected = await confirmFormOperationsReflected(client, slug, operationsSettingsPatch);
          if (!reflected.ok) operationsReflectError = reflected.error ?? '運用制御が Formaloo に反映されませんでした';
        }
        // bg-fullpage-render-fix (R4/T-A1): 画像 replace/remove の反映も soft-200 対策で GET-after-PATCH 確認
        //   (色/文言/redirect と同型・別 helper で file-disjoint)。期待は **intent ベース**で組む: replace=set /
        //   remove=cleared。applyDesignImages が ok を返しても multipart PATCH 200+URL 未永続の soft-200 があり得るため
        //   独立 GET で描画 location (top-level background_image/logo) の反映を確認する。apply 自体が失敗した経路
        //   (imageSyncError) は二重報告しないよう素通り。keep/未指定は期待ゼロで GET せず素通り (既存挙動 byte 不変)。
        let backgroundReflectError: string | null = null;
        if (metaRes.ok && slug && designImages && !imageSyncError) {
          const bgExpected: BackgroundReflectionExpected = {};
          const coverIntent = designImages.cover?.intent;
          const logoIntent = designImages.logo?.intent;
          // replace=applied URL 一致を要求 (旧 URL 残存 soft-200 を検知) / remove=cleared。
          if (coverIntent === 'replace') bgExpected.backgroundImage = { state: 'set', url: appliedBgUrl ?? '' };
          else if (coverIntent === 'remove') bgExpected.backgroundImage = { state: 'cleared' };
          if (logoIntent === 'replace') bgExpected.logo = { state: 'set', url: appliedLogoUrl ?? '' };
          else if (logoIntent === 'remove') bgExpected.logo = { state: 'cleared' };
          if (bgExpected.backgroundImage || bgExpected.logo) {
            const reflected = await confirmBackgroundReflected(client, slug, bgExpected);
            if (!reflected.ok) backgroundReflectError = reflected.error ?? '画像が公開ページに反映されませんでした';
          }
        }
        if (!metaRes.ok) {
          await setFormalooSyncState(c.env.DB, id, {
            syncStatus: 'out_of_sync', lastError: 'フォーム情報の同期に失敗しました',
          });
          syncSettled = true;
        // push 成功で Formaloo 側 = harness が今送った内容 → 旧 baseline は stale。
        // remote_definition_hash=NULL で無効化し次 tick で silent re-bootstrap (自分の push を drift 誤検知しない
        // / formaloo-auto-pull R6)。drift 状態 (badge/pending) も掃除 (remote drift は解消 = harness と一致)。
        // compound を builder 編集した場合は push 成功でも未同期 + 明示警告 (複合は簡略化せず Formaloo に残す)。
        } else if (compoundEditWarning) {
          await setFormalooSyncState(c.env.DB, id, {
            syncStatus: 'out_of_sync', lastError: compoundEditWarning,
            remoteDefinitionHash: null, pendingRemoteHash: null, driftStatus: 'none', driftDetectedAt: null,
          });
          syncSettled = true;
        } else if (imageSyncError) {
          // F1: 色/フィールドは同期したが画像 upload/削除が失敗 → out_of_sync で owner に surface
          //     (meta PATCH 失敗と同じ経路)。owner が「ロゴ設定済」と誤認しないための honest state。
          await setFormalooSyncState(c.env.DB, id, {
            syncStatus: 'out_of_sync', lastError: imageSyncError,
          });
          syncSettled = true;
        } else if (backgroundReflectError) {
          // bg-fullpage-render-fix (R4): 画像 upload は 200 だが背景/ロゴが hosted に永続していない (soft-200)
          //   → out_of_sync。「保存済に見えて背景が出ない」failure_observable を honest surface する。
          await setFormalooSyncState(c.env.DB, id, {
            syncStatus: 'out_of_sync', lastError: backgroundReflectError,
          });
          syncSettled = true;
        } else if (designReflectError) {
          // T-B2: meta PATCH は 200 だが送った色が hosted に反映されなかった (soft-200 無言無視) → out_of_sync。
          //   「保存されるが公開ページに配色が出ない」failure_observable を honest に surface する。
          await setFormalooSyncState(c.env.DB, id, {
            syncStatus: 'out_of_sync', lastError: designReflectError,
          });
          syncSettled = true;
        } else if (formCopyReflectError) {
          // form-jp-localization: meta PATCH は 200 だが送った文言が hosted に反映されなかった (soft-200) → out_of_sync。
          //   「設定は保存されるが hosted に反映されない」failure_observable を honest に surface する。
          await setFormalooSyncState(c.env.DB, id, {
            syncStatus: 'out_of_sync', lastError: formCopyReflectError,
          });
          syncSettled = true;
        } else if (localizedContentReflectError) {
          // localized_content の soft-200 / GET 失敗を idle にしない。foreign key は helper の比較対象外。
          await setFormalooSyncState(c.env.DB, id, {
            syncStatus: 'out_of_sync', lastError: localizedContentReflectError,
          });
          syncSettled = true;
        } else if (redirectReflectError) {
          // route-terminal-phase2: meta PATCH は 200 だが送った redirect URL が hosted に反映されなかった (soft-200)
          //   → out_of_sync。「保存されるが送信後に飛ばない」failure_observable を honest に surface する。
          await setFormalooSyncState(c.env.DB, id, {
            syncStatus: 'out_of_sync', lastError: redirectReflectError,
          });
          syncSettled = true;
        } else if (operationsReflectError) {
          // treasure B2: API 200 だけでは完了扱いにせず、GET read-back 不一致を honest に surface する。
          await setFormalooSyncState(c.env.DB, id, {
            syncStatus: 'out_of_sync', lastError: operationsReflectError,
          });
          syncSettled = true;
        } else if (pushed.systemFieldsOutOfSync) {
          // fr-id-capture-fix (T-C3/T-C7): 定義本体は同期したが friend system field (fr_id/fr_name) が正しく機能しない。
          //   回答導線は守る (publish 自体は成功) が、system field は out_of_sync で honest surface する (silent success 禁止 / codex#3)。
          //   定義本体は push 済ゆえ baseline は clear (idle 分岐と同じく自分の push を drift 誤検知させない)。
          //   T-C7: logicConflict = fr_id が is_answered→submit のトリガーより後ろにあり、送信時の保存対象外になる。
          const logicConflict = pushed.systemFields?.logicConflict === true;
          const failedSystemAliases = pushed.systemFields?.outcomes
            .filter((outcome) => outcome.status === 'conflict' || outcome.status === 'error')
            .map((outcome) => outcome.alias) ?? [];
          const utmRequested = operationsSettingsToPersist?.utmTracking === true;
          const utmFailed = failedSystemAliases.some((alias) => alias.startsWith('utm_'));
          const friendFailed = failedSystemAliases.some((alias) => alias === 'fr_id' || alias === 'fr_name');
          const systemFieldError = utmRequested
            ? utmFailed && !friendFailed
              ? 'UTM 流入元記録用フィールド (utm_source/utm_medium/utm_campaign) の同期に失敗しました。再保存で自動復旧します。'
              : friendFailed && !utmFailed
                ? 'friend 識別用フィールド (fr_id/fr_name) の同期に失敗しました。再保存で自動復旧します。'
                : 'friend 識別用および UTM 流入元記録用フィールドの同期を確認できませんでした。再保存で自動復旧します。'
            : 'friend 識別用フィールド (fr_id/fr_name) の同期に失敗しました。再保存で自動復旧します。';
          await setFormalooSyncState(c.env.DB, id, {
            syncStatus: 'out_of_sync',
            lastError: logicConflict
              ? 'Formaloo の「回答されたら送信」は、トリガー位置以降の回答を保存しません。friend 識別フィールド (fr_id) がトリガーより後ろにある場合だけ再入場 prefill に影響します。fr_id を先頭 (position 0) に固定すれば logic と共存できます。'
              : systemFieldError,
            remoteDefinitionHash: null, pendingRemoteHash: null, driftStatus: 'none', driftDetectedAt: null,
          });
          syncSettled = true;
        } else {
          await setFormalooSyncState(c.env.DB, id, {
            syncStatus: 'idle', lastError: null, lastPushedAt: new Date().toISOString(),
            remoteDefinitionHash: null, pendingRemoteHash: null, driftStatus: 'none', driftDetectedAt: null,
          });
          syncSettled = true;
        }
      } else {
        // route-terminal-phase2 (Track 2): push 失敗でも POST 成功済 SP の割当 slug は definition_json に永続する
        //   (successPagesToPersist は pushed.successPages で partial slug を carry 済) → 次回リトライで再 POST しない
        //   = 非冪等重複作成の根絶 (失敗注入耐性)。formalooSlug/field slug は変えない (既存挙動維持)。
        if (successPagesProvided && pushed.successPages) {
          await saveFormalooDefinition(c.env.DB, id, {
            definitionJson: buildDefinitionJson(pushed.publicAddress ?? prevDef.formalooAddress ?? null),
            fields: fieldRows((fid) => pushed.fieldSlugs?.[fid] ?? existingFieldSlugs[fid] ?? null),
          });
        }
        await setFormalooSyncState(c.env.DB, id, { syncStatus: 'out_of_sync', lastError: pushed.error ?? 'push failed' });
        syncSettled = true;
      }
    }

    const updated = await getFormalooForm(c.env.DB, id);
    // form-route-branching: jump+simple backstop 等の非ブロッキング警告を builder へ surface (success は維持)。
    return c.json({ success: true, data: await serializeForm(c.env.DB, updated!, isOwnerCtx(c)), ...(saveWarnings.length ? { warnings: saveWarnings } : {}) });
  } catch (err) {
    if (syncStarted && !syncSettled) {
      try {
        await setFormalooSyncState(c.env.DB, id, {
          syncStatus: 'out_of_sync', lastError: 'フォームの保存処理に失敗しました',
        });
      } catch {
        // D1 自体が利用不能な場合は outer 500 に任せる。
      }
    }
    console.error('PUT /api/forms-advanced/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/forms-advanced/:id/folder — フォーム→フォルダ割当/解除 (F6-3 / ローカル分類 = Formaloo push なし)
//   body {folderId: string|null}。同一 account 検証 (folder.line_account_id === form.line_account_id) は
//   db 層 (setFormalooFormFolder) が実施し cross-account 混入を 400 で弾く (§3.3)。PUT /:id (定義保存 push) とは別 route。
formsAdvanced.put('/api/forms-advanced/:id/folder', async (c) => {
  const id = c.req.param('id')!;
  const body = await c.req.json<{ folderId?: unknown }>().catch(() => ({}) as { folderId?: unknown });
  const folderId = typeof body.folderId === 'string' && body.folderId.trim() ? body.folderId.trim() : null;
  try {
    await setFormalooFormFolder(c.env.DB, id, folderId);
    const updated = await getFormalooForm(c.env.DB, id);
    return c.json({ success: true, data: await serializeForm(c.env.DB, updated!, isOwnerCtx(c)) });
  } catch (err) {
    if (err instanceof FolderError) {
      return c.json({ success: false, error: err.message }, err.status as 400 | 404);
    }
    console.error('PUT /api/forms-advanced/:id/folder error');
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/forms-advanced/:id/pull — Formaloo から定義を再取り込み (N-8 / 非破壊プレビュー)
//   Formaloo = 定義の権威 (§4)。運用者が Formaloo 管理画面で直接編集したフォームを builder に読み戻す。
//   D1 は書き換えない (setFormalooSyncState/saveFormalooDefinition は呼ばない) = builder state 反映のみ。
//   永続化は運用者が既存 PUT で「保存」。response.data.ok は「editor に適用してよいか」の判別子:
//   frontend は ok===true の時だけ state を置換し、ok:false は note のみ表示する (B2 = editor を潰さない)。
//   client 未配備 (dev) / formaloo_slug 無 / pull 失敗は fail-soft (ok:false + note + 200 / 500 にしない)。
formsAdvanced.get('/api/forms-advanced/:id/pull', async (c) => {
  try {
    const id = c.req.param('id')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);

    // F6-2: form.workspace_id で多鍵解決。NULL(legacy) → env 単一鍵 fallback (byte-equivalent) /
    // 登録 active → 暗号文鍵 / 未登録・無効化・復号失敗 → null (env silent fallback しない = 誤送信防止)。fail-soft 契約不変。
    const client = await resolveFormalooClient(c.env, form.workspace_id);
    if (!client) {
      return c.json({ success: true, data: { ok: false, fields: [], logic: [], note: 'Formaloo 未接続のため再取り込みできません（S-1 待ち）' } });
    }
    if (!form.formaloo_slug) {
      return c.json({ success: true, data: { ok: false, fields: [], logic: [], note: 'このフォームはまだ Formaloo に未同期です（先に保存してください）' } });
    }

    // slug → harness id の resolver を D1 field_map から組む (書込みなし = read のみ)。
    const map = await getFormalooFieldMap(c.env.DB, id);
    const bySlug = new Map<string, string>();
    for (const row of map) {
      if (row.formaloo_field_slug) bySlug.set(row.formaloo_field_slug, row.id);
    }
    const r = await pullDefinitionFromFormaloo(client, {
      formalooSlug: form.formaloo_slug,
      resolveId: (s) => bySlug.get(s) ?? s, // 既知 slug → 既存 id / 未知 → slug 自身 (fromFormalooField の fallback と整合)
    });
    if (!r.ok) {
      return c.json({ success: true, data: { ok: false, fields: [], logic: [], note: `再取り込みに失敗しました（${r.error}）` } });
    }
    // B7: pull-fidelity 弱化 warnings を既存 note にマージ (additive・既存文言は不変)。
    const baseNote =
      'Formaloo から再取り込みしました。内容を確認して「保存」してください（⚠️保存すると Formaloo に項目が重複作成される場合があります）';
    const note = r.warnings && r.warnings.length ? `${baseNote} ⚠️${r.warnings.join(' / ')}` : baseNote;
    return c.json({
      success: true,
      data: {
        ok: true,
        fields: r.fields,
        logic: r.logic,
        note,
        // preserve-raw: builder が opaque 保持し save body で carry する (未編集 push で欠けなく再送 / D-7)。
        ...(r.rawLogic != null ? { rawLogic: r.rawLogic } : {}),
        logicFingerprint: r.logicFingerprint,
        // form-design (Batch D): Formaloo 側の色/画像テーマを builder に復元させる (非空のときのみ)。
        ...(r.design && Object.keys(r.design).length ? { design: r.design } : {}),
        // form-route-branching (R2): Formaloo の表示形式を builder に復元させる (未設定は載せない)。
        ...(r.formType ? { formType: r.formType } : {}),
        // treasure B2: 実測5 key の canonical。空 object は remote の false/null 全解除を表す。
        ...(r.operationsSettings !== undefined ? { operationsSettings: r.operationsSettings } : {}),
      },
    });
  } catch (err) {
    console.error('GET /api/forms-advanced/:id/pull error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/forms-advanced/:id/drift-events — 定義 drift の監査履歴 (formaloo-auto-pull R5 / 新しい順)。
//   forms_advanced 権限で gate 済 (permissionMiddleware)。自動反映/通知/競合/bootstrap を後から追える。
formsAdvanced.get('/api/forms-advanced/:id/drift-events', async (c) => {
  try {
    const id = c.req.param('id')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
    const events = await listFormalooDriftEvents(c.env.DB, id, 50);
    return c.json({
      success: true,
      data: events.map((e) => ({
        id: e.id,
        detectedAt: e.detected_at,
        action: e.action,
        remoteHash: e.remote_hash,
        prevHash: e.prev_hash,
        hasWarnings: e.has_warnings === 1,
        syncStatusAt: e.sync_status_at,
        detail: e.detail,
      })),
    });
  } catch (err) {
    console.error('GET /api/forms-advanced/:id/drift-events error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** 状態遷移の共通ハンドラ (publish gate)。 */
async function transition(c: Context<Env>, to: BuilderStatus, notAllowedMsg: string) {
  const id = c.req.param('id')!;
  const form = await getFormalooForm(c.env.DB, id);
  if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
  const from = (isBuilderStatus(form.builder_status) ? form.builder_status : 'draft') as BuilderStatus;
  if (!canTransition(from, to)) {
    return c.json({ success: false, error: notAllowedMsg }, 409);
  }
  await updateFormalooBuilderStatus(c.env.DB, id, to);
  const updated = await getFormalooForm(c.env.DB, id);
  return c.json({ success: true, data: await serializeForm(c.env.DB, updated!, isOwnerCtx(c)) });
}

// POST /api/forms-advanced/:id/submit-for-review — draft → in_review
formsAdvanced.post('/api/forms-advanced/:id/submit-for-review', async (c) =>
  transition(c, 'in_review', 'この状態からレビュー依頼はできません'),
);

// POST /api/forms-advanced/:id/publish — in_review → published (N-7 gate: draft から直行不可)
formsAdvanced.post('/api/forms-advanced/:id/publish', async (c) =>
  transition(c, 'published', '公開の前に「レビュー依頼」で下書きを確認してください（誤配信防止）'),
);

// POST /api/forms-advanced/:id/unpublish — published → draft (URL 即無効化)
formsAdvanced.post('/api/forms-advanced/:id/unpublish', async (c) =>
  transition(c, 'draft', 'この状態から下書きに戻せません'),
);

// GET /api/forms-advanced/:id/embed — 埋め込みコード (N-7: published のみ)
formsAdvanced.get('/api/forms-advanced/:id/embed', async (c) => {
  try {
    const form = await getFormalooForm(c.env.DB, c.req.param('id')!);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
    const def = parseDefinition(form.definition_json);
    const status = (isBuilderStatus(form.builder_status) ? form.builder_status : 'draft') as BuilderStatus;
    const embedCode = buildEmbedCode(status, def.formalooAddress ?? null, { title: form.title });
    if (!embedCode) {
      return c.json({ success: false, error: 'フォームを公開すると埋め込みコードが発行されます' }, 409);
    }
    return c.json({ success: true, data: { embedCode, publicUrl: buildPublicUrl(status, def.formalooAddress ?? null) } });
  } catch (err) {
    console.error('GET /api/forms-advanced/:id/embed error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/forms-advanced/:id — 論理削除 (N-11 tombstone)
formsAdvanced.delete('/api/forms-advanced/:id', async (c) => {
  const id = c.req.param('id')!;
  const lockToken = crypto.randomUUID();
  let lockAcquired = false;
  try {
    lockAcquired = await acquireFormalooFormOperationLock(c.env.DB, id, {
      token: lockToken,
      nowMs: Date.now(),
      leaseMs: 120_000,
    });
    if (!lockAcquired) {
      const current = await getFormalooForm(c.env.DB, id);
      if (!current || current.deleted) {
        return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
      }
      return c.json({ success: false, error: 'このフォームの Formaloo 操作を処理中です。完了後にもう一度お試しください' }, 409);
    }

    // Lock 後に読み直す。登録側も同じ form-scoped lock を使い、deleted=1 の form では lock を取れないため、
    // 「登録を確認してから削除」までをひとつの直列化された操作にする。
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
    if (await hasBlockingFormalooRecurringSubmissions(c.env.DB, id)) {
      return c.json({
        success: false,
        error: '定期自動回答をすべて取消し、Formaloo への反映確認後にフォームを削除してください',
      }, 409);
    }

    const spSlugs = (parseDefinition(form.definition_json).successPages ?? [])
      .map((sp) => sp.slug)
      .filter((s): s is string => typeof s === 'string' && s.length > 0);

    // D1 tombstone を remote cleanup より先に確定し、cleanup 中に lease が切れても新しい登録が始まらないようにする。
    await softDeleteFormalooForm(c.env.DB, id);

    // route-terminal-phase2 (T-E4 / CX-2): form 削除で紐づく success-page (完了ページ) を明示 DELETE で回収する。
    //   Formaloo は form DELETE で SP を cascade しない (S-1 §5c) ゆえ、harness が abandon する form の SP resource
    //   が孤児として残る。remote form の削除有無と独立に SP slug を明示 DELETE (404 は成功扱い・fail-soft で
    //   本削除をブロックしない = 部分失敗は log で残余記録)。
    if (spSlugs.length) {
      try {
        const spClient = await resolveFormalooClient(c.env, form.workspace_id);
        if (spClient) {
          const del = await deleteSuccessPages(spClient, spSlugs);
          if (!del.ok) console.error('DELETE /api/forms-advanced/:id — SP 孤児回収の一部失敗:', id, del.failed);
        }
      } catch (cleanupErr) {
        console.error('DELETE /api/forms-advanced/:id — SP 孤児回収に失敗 (form は削除済み):', id, cleanupErr);
      }
    }
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/forms-advanced/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  } finally {
    if (lockAcquired) {
      await releaseFormalooFormOperationLock(c.env.DB, id, lockToken).catch((releaseErr) => {
        console.error('DELETE /api/forms-advanced/:id — form operation lock release failed:', id, releaseErr);
      });
    }
  }
});

// =============================================================================
// F-4 データコックピット (T-D1) — 回答ミラー検索 + ドリルスルー + 保存フィルタ
//   /api/forms-advanced 配下 = permission-map で forms_advanced feature に自動 gate (landmine#4)。
//   回答は TRINA 顧客 PII を含み得る (N-9) — 外部送信しない。CSV export / 一括削除は commit 6 (owner gated)。
// =============================================================================

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

function safeParseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function serializeSubmissionRow(row: FormalooSubmissionRow) {
  return {
    id: row.id,
    friendId: row.friend_id,
    answers: safeParseJson(row.answers_json),
    submittedAt: row.submitted_at,
    verified: row.verified === 1,
  };
}

function parseIntSafe(v: string | undefined, fallback: number): number {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
}

// submissions-visibility-fix (T-A4): read-path reconcile の bounded 上限。
//   MAX_RECONCILE_PAGES × RECONCILE_PAGE_SIZE = 直近 ~400 行を上限 reconcile (Workers subrequest 上限保護)。
//   超過フォームの古い行は lag (許容)。対象 piecemaker フォームは 4 行 = 完全被覆。
const MAX_RECONCILE_PAGES = 8;
const RECONCILE_PAGE_SIZE = 50;

/**
 * 回答一覧 read-path reconcile (submissions-visibility-fix / T-A1)。
 * 兄弟 /stats・/rows/:rowId と同じ「Formaloo=SoT / ミラー=cache」モデルへ揃える:
 *   Formaloo rows を bounded page で pull → extractRows で配列化 → mapFormalooListRowToUpsert で写像 →
 *   既存 upsertFormalooSubmission でミラーへ idempotent 充填。呼び出し側が直後に queryFormalooSubmissions で返す。
 * ミラー充填により詳細ドロワー・弾M 編集 (mirror 行前提・/rows/:rowId L899 の 404) も通る。
 * !r.ok / rows 空でループ終了 (makeRowsListRowSlugResolver と同じ bounded 走査作法)。例外は上位 try/catch が拾う。
 * line-reentry-prefill-fix (Layer A): friendTokenSecret 供給時は各行の署名 fr_id を verify して friend_id を
 *   fail-closed 復元 (mapFormalooListRowToUpsert 内)。null は復元せず friend_id を触らない (COALESCE で既存保持)。
 */
async function reconcileFormalooRows(
  db: D1Database,
  form: FormalooForm,
  client: { get<T = unknown>(path: string): Promise<{ ok: true; status: number; data: T } | { ok: false; status: number; error: string }> },
  opts: { friendTokenSecret?: string | null } = {},
): Promise<void> {
  for (let page = 1; page <= MAX_RECONCILE_PAGES; page++) {
    const r = await client.get(`/v3.0/forms/${form.formaloo_slug}/rows/?page=${page}&page_size=${RECONCILE_PAGE_SIZE}`);
    if (!r.ok) break;
    const rows = extractRows(r.data);
    if (rows.length === 0) break;
    for (const row of rows) {
      const input = await mapFormalooListRowToUpsert(row, form, { friendTokenSecret: opts.friendTokenSecret });
      if (input) await upsertFormalooSubmission(db, input);
    }
  }
}

// GET /api/forms-advanced/:id/rows — Formaloo reconcile (bounded pull → ミラー充填) → D1 ミラーの検索/フィルタ/ソート/ページング
//   兄弟 /stats・/rows/:rowId と同じ SoT=Formaloo モデル。webhook 未配線でも可視化と弾M 検証を成立させる。
//   fail-soft: client null / 非2xx / 空 / 例外は reconcile を skip しミラーをそのまま返す (dev/鍵無し無影響)。
//   env FORMS_ADVANCED_ROWS_LIVE_RECONCILE_DISABLE='true' で mirror-only の旧挙動へ即 rollback。
formsAdvanced.get('/api/forms-advanced/:id/rows', async (c) => {
  try {
    const id = c.req.param('id')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);

    // read-path reconcile (既定 ON)。Formaloo 由来の失敗で一覧自体を落とさないよう全体を try/catch で包む。
    if (c.env.FORMS_ADVANCED_ROWS_LIVE_RECONCILE_DISABLE !== 'true') {
      try {
        const client = await resolveFormalooClient(c.env, form.workspace_id);
        if (client && form.formaloo_slug) {
          // line-reentry-prefill-fix (Layer A): 署名 fr_id → friend_id 復元用の実効 secret を渡す
          //   (FORMALOO_RECONCILE_FRIEND_LINK_DISABLE='true' で null = 復元停止・ミラー充填は継続)。
          await reconcileFormalooRows(c.env.DB, form, client, { friendTokenSecret: friendLinkSecret(c.env) });
        }
      } catch (reconcileErr) {
        console.error('GET /api/forms-advanced/:id/rows reconcile failed (fail-soft, mirror を返す):', reconcileErr);
      }
    }

    const page = Math.max(1, parseIntSafe(c.req.query('page'), 1));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseIntSafe(c.req.query('pageSize'), DEFAULT_PAGE_SIZE)));
    const { rows, total } = await queryFormalooSubmissions(c.env.DB, {
      formId: id,
      q: c.req.query('q') ?? null,
      from: c.req.query('from') ?? null,
      to: c.req.query('to') ?? null,
      sortDir: c.req.query('sort') === 'asc' ? 'asc' : 'desc',
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });

    // form-response-display-fix (T-A1): 列ヘッダー label 化用に fields:[{slug,label}] を additive 付与。
    //   field_map(formaloo_field_slug) × 定義(label) の join (装飾/slug 無し除外・定義順)。
    //   fail-soft: label 解決に失敗しても一覧本体は返す (web はヘッダーを slug へ fallback する)。
    let fields: Array<{ slug: string; label: string }> = [];
    try {
      const fieldMap = await getFormalooFieldMap(c.env.DB, id);
      fields = buildFieldLabelList(fieldMap, parseDefinition(form.definition_json).fields);
    } catch (labelErr) {
      console.error('GET /api/forms-advanced/:id/rows field label build failed (fail-soft):', labelErr);
    }

    return c.json({ success: true, data: { rows: rows.map(serializeSubmissionRow), total, page, pageSize, fields } });
  } catch (err) {
    console.error('GET /api/forms-advanced/:id/rows error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** 編集者 staff の表示名を解決 (env-owner は 'Owner' / 不明は null)。 */
async function resolveEditorName(db: D1Database, editorStaffId: string | null | undefined): Promise<string | null> {
  if (!editorStaffId) return null;
  if (editorStaffId === 'env-owner') return 'Owner';
  const st = await getStaffById(db, editorStaffId);
  return st?.name ?? null;
}

/**
 * 弾M (form-post-edit / T-D2): 回答詳細の編集コンテキスト (additive・回答詳細画面の編集モード用)。
 *   allowPostEdit (編集ボタン gate) + 編集対象 field メタ (slug/label/type/required/editable) + ④最終編集。
 *   field メタは definition の required/type + field_map の slug を harness id で join (装飾/未 push slug は除外)。
 *   F-I3: allowPostEdit は **実効 gate** (form.allow_post_edit===1 かつ env kill-switch 有効) を返す。
 *   env-OFF (rollback) では 0 = web が編集ボタンを出さない (spec R3『OFF=編集ボタン非表示』・endpoint 403 と整合)。
 */
async function buildRowEditContext(db: D1Database, form: FormalooForm, rowId: string, featureEnabled: boolean) {
  const def = parseDefinition(form.definition_json);
  const fieldMap = await getFormalooFieldMap(db, form.id);
  // form-response-display-fix (T-A1): /rows の列ヘッダー label 化と同じ join を共有 (DRY・二重管理回避)。
  const fields = joinDefinitionFieldsWithSlug(fieldMap, def.fields);
  const latest = await getLatestEdit(db, rowId);
  return {
    // 実効 gate (form.allow_post_edit===1 AND env 有効)。env-OFF は 0 = 編集ボタン非表示 (spec R3)。
    allowPostEdit: form.allow_post_edit === 1 && featureEnabled ? 1 : 0,
    fields,
    lastEdit: latest
      ? { editorStaffId: latest.editor_staff_id, editorName: await resolveEditorName(db, latest.editor_staff_id), editedAt: latest.edited_at }
      : null,
  };
}

// GET /api/forms-advanced/:id/rows/:rowId — Formaloo rows API ドリルスルー (fail-soft = mirror / N-6)
//   弾M (T-D2): 編集モード用に editContext (allowPostEdit / editable fields / lastEdit) を additive 付与。
formsAdvanced.get('/api/forms-advanced/:id/rows/:rowId', async (c) => {
  try {
    const id = c.req.param('id')!;
    const rowId = c.req.param('rowId')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
    const mirror = await getFormalooSubmission(c.env.DB, rowId);
    if (!mirror || mirror.form_id !== id) return c.json({ success: false, error: '回答が見つかりません' }, 404);

    const editContext = await buildRowEditContext(c.env.DB, form, rowId, isPostEditEnabled(c.env.FORM_POST_EDIT_ENABLED));

    // Formaloo 側の最新をドリルスルー。client 未配備 (dev) / 失敗は mirror を返す (fail-soft)。
    // F6-2: form.workspace_id で多鍵解決。NULL(legacy) → env 単一鍵 fallback (byte-equivalent) /
    // 登録 active → 暗号文鍵 / 未登録・無効化・復号失敗 → null (env silent fallback しない = 誤送信防止)。fail-soft 契約不変。
    const client = await resolveFormalooClient(c.env, form.workspace_id);
    if (client && form.formaloo_slug) {
      const r = await client.get<{ data?: unknown }>(`/v3.0/forms/${form.formaloo_slug}/rows/${rowId}/`);
      if (r.ok) {
        return c.json({ success: true, data: { id: rowId, answers: r.data?.data ?? safeParseJson(mirror.answers_json), submittedAt: mirror.submitted_at, source: 'formaloo', ...editContext } });
      }
    }
    return c.json({ success: true, data: { id: rowId, answers: safeParseJson(mirror.answers_json), submittedAt: mirror.submitted_at, source: 'mirror', ...editContext } });
  } catch (err) {
    console.error('GET /api/forms-advanced/:id/rows/:rowId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PATCH /api/forms-advanced/:id/rows/:rowId — ①管理者編集 (弾M form-post-edit / T-B2)。
//   gate(allow_post_edit AND FORM_POST_EDIT_ENABLED) 403 → mirror → row_slug 解決 → Formaloo flat PATCH →
//   **persist 確認 (FRESH GET で編集後値照合)** 成功のみ D1 mirror 更新 + edit 記録。反映されない編集を
//   成功と見せない (soft-200 教訓)。client null / row_slug 不能 / 非2xx / persist 未確認 は D1 を書かず正直エラー。
formsAdvanced.patch('/api/forms-advanced/:id/rows/:rowId', async (c) => {
  try {
    const id = c.req.param('id')!;
    const rowId = c.req.param('rowId')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);

    // gate: allow_post_edit=1 かつ env 有効。OFF/未設定は 403 (現状挙動 byte 同等・編集経路を残さない)。
    if (form.allow_post_edit !== 1 || !isPostEditEnabled(c.env.FORM_POST_EDIT_ENABLED)) {
      return c.json({ success: false, error: 'このフォームは回答の後編集が許可されていません' }, 403);
    }

    const mirror = await getFormalooSubmission(c.env.DB, rowId);
    if (!mirror || mirror.form_id !== id) return c.json({ success: false, error: '回答が見つかりません' }, 404);

    const body = await c.req
      .json<{ answers?: unknown }>()
      .catch(() => ({} as { answers?: unknown }));
    const answers =
      body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers)
        ? (body.answers as Record<string, unknown>)
        : null;
    if (!answers || Object.keys(answers).length === 0) {
      return c.json({ success: false, error: '編集内容がありません' }, 400);
    }

    // field メタ: definition の required/type + field_map の slug (harness id で join)。
    const def = parseDefinition(form.definition_json);
    const fieldMap = await getFormalooFieldMap(c.env.DB, id);
    const slugById = new Map<string, string | null>();
    for (const r of fieldMap) slugById.set(r.id, r.formaloo_field_slug);
    const editFields = def.fields.map((f) => ({
      id: f.id,
      slug: slugById.get(f.id) ?? null,
      fieldType: f.type,
      required: f.required === true,
    }));

    // flat top-level slug body (free-value 限定・data ラッパ無し = soft-200 回避)。
    const patchBody = buildFlatRowPatchBody(answers, editFields);
    if (Object.keys(patchBody).length === 0) {
      return c.json({ success: false, error: '編集できる項目がありません（選択式・ファイルは対象外です）' }, 400);
    }
    const requiredSlugs = new Set(editFields.filter((f) => f.required && f.slug).map((f) => f.slug as string));
    const missing = findEmptyRequired(patchBody, requiredSlugs);
    if (missing.length > 0) {
      return c.json({ success: false, error: '必須項目を空にできません' }, 400);
    }

    // Formaloo client (多鍵)。null (未登録/復号失敗/未接続) は誤送信防止契約継承 → D1 を書かず正直エラー。
    const client = await resolveFormalooClient(c.env, form.workspace_id);
    if (!client || !form.formaloo_slug) {
      return c.json({ success: false, error: 'Formaloo 未接続のため編集を保存できません' }, 502);
    }

    // row_slug 解決 (stored → rows-list submit_code 照合)。不能は正直エラー (殻完了禁止)。
    const rowSlug = await resolveRowSlug(mirror, makeRowsListRowSlugResolver(client, form.formaloo_slug));
    if (!rowSlug) {
      return c.json({ success: false, error: 'この回答は Formaloo 側の識別子が取得できず編集できません' }, 422);
    }

    // flat PATCH → **persist 確認** (FRESH GET で編集後値照合)。反映されない編集を成功と見せない。
    const patchRes = await client.patch(`/v3.0/rows/${rowSlug}/`, patchBody);
    if (!patchRes.ok) {
      return c.json({ success: false, error: 'Formaloo への反映に失敗しました（保存していません）' }, 502);
    }
    // 実 Formaloo GET /v3.0/rows/{slug}/ の flat slug map は data.row.data に在る (client が HTTP body を .data に
    // 包むため route からは verifyRes.data.data.row.data)。1 階層浅い data.data を読むと常に undefined → 誤 502。
    const verifyRes = await client.get<{ data?: { row?: { data?: Record<string, unknown> } } }>(`/v3.0/rows/${rowSlug}/`);
    const persisted = (verifyRes.ok ? verifyRes.data?.data?.row?.data : undefined) as Record<string, unknown> | undefined;
    const confirmed =
      persisted != null &&
      Object.entries(patchBody).every(([slug, val]) => String(persisted[slug] ?? '') === String(val ?? ''));
    if (!confirmed) {
      return c.json({ success: false, error: 'Formaloo への反映が確認できませんでした（保存していません）' }, 502);
    }

    // 成功: D1 mirror 更新 + row_slug backfill (legacy のみ) + edit 記録 (変更フィールドのみ)。
    const prevRaw = safeParseJson(mirror.answers_json);
    const prevAnswers = prevRaw && typeof prevRaw === 'object' && !Array.isArray(prevRaw) ? (prevRaw as Record<string, unknown>) : {};
    // F-M6: mirror は persist 確認で取得済の **FRESH remote (persisted)** を正とし、そこに patchBody を上書き
    //   (persisted は既に patchBody を含むが、Formaloo 側の他フィールド最新変更も反映して D1 drift を防ぐ)。
    //   remote に無い harness 既知フィールドは prevAnswers で補完 (欠落防止)。stale prevAnswers 単独再構築を避ける。
    const mergedAnswers = { ...prevAnswers, ...persisted, ...patchBody };
    await c.env.DB
      .prepare('UPDATE formaloo_submissions SET answers_json = ?, synced_at = ? WHERE id = ?')
      .bind(JSON.stringify(mergedAnswers), jstNow(), rowId)
      .run();
    if (!mirror.formaloo_row_slug) await updateSubmissionRowSlug(c.env.DB, rowId, rowSlug);

    const editorStaffId = c.get('staff')?.id ?? null;
    for (const [slug, val] of Object.entries(patchBody)) {
      const oldVal = prevAnswers[slug];
      if (String(oldVal ?? '') === String(val ?? '')) continue; // 変化なしは記録しない
      await recordSubmissionEdit(c.env.DB, {
        submissionId: rowId,
        formId: id,
        editorStaffId,
        fieldSlug: slug,
        oldValue: oldVal == null ? null : String(oldVal),
        newValue: val == null ? null : String(val),
      });
    }

    const latest = await getLatestEdit(c.env.DB, rowId);
    return c.json({
      success: true,
      data: {
        id: rowId,
        answers: mergedAnswers,
        submittedAt: mirror.submitted_at,
        source: 'formaloo',
        lastEdit: latest
          ? { editorStaffId: latest.editor_staff_id, editorName: await resolveEditorName(c.env.DB, latest.editor_staff_id), editedAt: latest.edited_at }
          : null,
      },
    });
  } catch (err) {
    console.error('PATCH /api/forms-advanced/:id/rows/:rowId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/forms-advanced/:id/filters — 保存フィルタ一覧
formsAdvanced.get('/api/forms-advanced/:id/filters', async (c) => {
  try {
    const id = c.req.param('id')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
    const list = await listFormalooSavedFilters(c.env.DB, id);
    return c.json({ success: true, data: list.map((f) => ({ id: f.id, name: f.name, filter: safeParseJson(f.filter_json) })) });
  } catch (err) {
    console.error('GET /api/forms-advanced/:id/filters error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/forms-advanced/:id/filters — 保存フィルタ作成
formsAdvanced.post('/api/forms-advanced/:id/filters', async (c) => {
  try {
    const id = c.req.param('id')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
    const body = await c.req.json<{ name?: string; filter?: unknown }>().catch(() => ({}) as { name?: string; filter?: unknown });
    const name = (body.name ?? '').trim();
    if (!name) return c.json({ success: false, error: '名前を入力してください' }, 400);
    const created = await createFormalooSavedFilter(c.env.DB, { formId: id, name, filterJson: JSON.stringify(body.filter ?? {}) });
    return c.json({ success: true, data: { id: created.id, name: created.name, filter: safeParseJson(created.filter_json) } }, 201);
  } catch (err) {
    console.error('POST /api/forms-advanced/:id/filters error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/forms-advanced/:id/filters/:filterId — 保存フィルタ削除 (form scope に閉じる)
formsAdvanced.delete('/api/forms-advanced/:id/filters/:filterId', async (c) => {
  try {
    const id = c.req.param('id')!;
    await deleteFormalooSavedFilter(c.env.DB, id, c.req.param('filterId')!);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/forms-advanced/:id/filters/:filterId error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// =============================================================================
// F-4 データコックピット (T-D2) — 統計 + CSV 出し入れ + 一括削除
//   統計/検索は forms_advanced 権限で足りる。CSV export / import / 一括削除は PII 露出/破壊操作のため
//   owner gated (N-9 / 権限なし staff→middleware 403・非 owner staff→ownerGate 403)。
//   本番ランタイム上限を静的 cap で符号化 (Workers CPU/subrequest 保護 / 地雷#2)。
// =============================================================================

const MAX_EXPORT_ROWS = 50_000;
const MAX_EXPORT_BYTES = 20 * 1024 * 1024;
const MAX_IMPORT_ROWS = 5_000;
const MAX_BULK_DELETE = 1_000;

// N-9: 個人情報の書き出し/破壊操作は owner のみ。ownerGate は共有 helper (lib/owner-gate.js) を流用。

// GET /api/forms-advanced/:id/stats — 統計 (ローカル集計 + Formaloo stats drill fail-soft)
formsAdvanced.get('/api/forms-advanced/:id/stats', async (c) => {
  try {
    const id = c.req.param('id')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);

    // F6-2: form.workspace_id で多鍵解決。NULL(legacy) → env 単一鍵 fallback (byte-equivalent) /
    // 登録 active → 暗号文鍵 / 未登録・無効化・復号失敗 → null (env silent fallback しない = 誤送信防止)。fail-soft 契約不変。
    const client = await resolveFormalooClient(c.env, form.workspace_id);

    // form-response-display-fix (T-B1): 総回答数 off-by-1 の対称化。
    //   /rows は COUNT 前に reconcile するが /stats は未 reconcile でミラー直 COUNT していたため、
    //   webhook 未配線 (piecemaker) では並列ロード時に /stats が未充填ミラーを数え「総回答数 < 実表示件数」に。
    //   /rows と同じ bounded reconcile を COUNT の前に実行 (同一 env flag で skip 可・try/catch fail-soft・
    //   upsert は ON CONFLICT(id) 冪等ゆえ /rows と並列 reconcile しても安全)。
    if (c.env.FORMS_ADVANCED_ROWS_LIVE_RECONCILE_DISABLE !== 'true') {
      try {
        if (client && form.formaloo_slug) {
          await reconcileFormalooRows(c.env.DB, form, client, { friendTokenSecret: friendLinkSecret(c.env) });
        }
      } catch (reconcileErr) {
        console.error('GET /api/forms-advanced/:id/stats reconcile failed (fail-soft, mirror を数える):', reconcileErr);
      }
    }

    const { total } = await queryFormalooSubmissions(c.env.DB, { formId: id, limit: 1, offset: 0 });
    const daily = await formalooSubmissionsDailyCounts(c.env.DB, id);
    const verifiedRow = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM formaloo_submissions WHERE form_id = ? AND verified = 1').bind(id).first<{ n: number }>();

    // Formaloo 側 stats を drill (fail-soft): client 未配備/失敗は null。上で解決済 client を再利用。
    let formaloo: unknown = null;
    if (client && form.formaloo_slug) {
      const r = await client.get<{ data?: unknown }>(`/v3.0/forms/${form.formaloo_slug}/stats/`);
      if (r.ok) formaloo = r.data?.data ?? null;
    }
    return c.json({ success: true, data: { total, verified: verifiedRow?.n ?? 0, daily, formaloo } });
  } catch (err) {
    console.error('GET /api/forms-advanced/:id/stats error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/forms-advanced/:id/export.csv — 回答 CSV 書き出し (owner gated / N-9)
formsAdvanced.get('/api/forms-advanced/:id/export.csv', async (c) => {
  try {
    const denied = ownerGate(c);
    if (denied) return denied;
    const id = c.req.param('id')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);

    const { rows, total } = await queryFormalooSubmissions(c.env.DB, { formId: id, sortDir: 'asc', limit: MAX_EXPORT_ROWS, offset: 0 });
    if (total > MAX_EXPORT_ROWS) {
      return c.json({ success: false, error: `件数が多すぎます（上限 ${MAX_EXPORT_ROWS} 件）。期間で絞ってからお試しください。` }, 400);
    }
    // answer key の union を列にする (フォームごとに回答項目が異なるため)。
    const parsed = rows.map((r) => (safeParseJson(r.answers_json) as Record<string, unknown>) ?? {});
    const keys = [...new Set(parsed.flatMap((a) => Object.keys(a)))].sort();
    const header = ['回答ID', 'friend_id', '送信日時', ...keys];
    const csvRows = rows.map((r, i) => [
      r.id,
      r.friend_id ?? '',
      r.submitted_at,
      ...keys.map((k) => {
        const v = parsed[i][k];
        return Array.isArray(v) ? v.join(', ') : v ?? '';
      }),
    ]);
    const csv = toCsv(header, csvRows);
    if (new TextEncoder().encode(csv).length > MAX_EXPORT_BYTES) {
      return c.json({ success: false, error: 'データ量が大きすぎて一度に出力できません。期間で絞ってお試しください。' }, 413);
    }
    return c.body(csv, 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`formaloo_${id}.csv`)}`,
    });
  } catch (err) {
    console.error('GET /api/forms-advanced/:id/export.csv error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/forms-advanced/:id/import — CSV 取り込み (owner gated)。SoT: Formaloo import-rows へ push し、
//   webhook 経由でミラーに反映 (ミラーへ直接書き込まない)。dev/未配備は pushed=false で fail-soft。
formsAdvanced.post('/api/forms-advanced/:id/import', async (c) => {
  try {
    const denied = ownerGate(c);
    if (denied) return denied;
    const id = c.req.param('id')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);

    const body = await c.req.json<{ csv?: string }>().catch(() => ({}) as { csv?: string });
    const csv = typeof body.csv === 'string' ? body.csv : '';
    const parsedRows = parseCsv(csv);
    if (parsedRows.length === 0) return c.json({ success: false, error: 'CSV が空です' }, 400);
    const dataRows = parsedRows.slice(1); // 先頭 header を除く
    if (dataRows.length > MAX_IMPORT_ROWS) {
      return c.json({ success: false, error: `一度に取り込めるのは ${MAX_IMPORT_ROWS} 行までです。分割してお試しください。` }, 400);
    }

    let pushed = false;
    let note = 'Formaloo 認証情報が未設定のため取り込みは保留しました（CSV は検証済み・S-1 で本番反映）';
    // F6-2: form.workspace_id で多鍵解決。NULL(legacy) → env 単一鍵 fallback (byte-equivalent) /
    // 登録 active → 暗号文鍵 / 未登録・無効化・復号失敗 → null (env silent fallback しない = 誤送信防止)。fail-soft 契約不変。
    const client = await resolveFormalooClient(c.env, form.workspace_id);
    if (client && form.formaloo_slug) {
      const r = await client.post(`/v3.0/forms/${form.formaloo_slug}/import-rows/`, { header: parsedRows[0], rows: dataRows });
      pushed = r.ok;
      note = r.ok ? '取り込みました（Formaloo 反映後、回答一覧に順次表示されます）' : `取り込みに失敗しました（HTTP ${r.status}）`;
    }
    return c.json({ success: true, data: { parsed: dataRows.length, pushed, note } });
  } catch (err) {
    console.error('POST /api/forms-advanced/:id/import error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/forms-advanced/:id/rows/bulk-delete — 回答一括削除 (owner gated / N-9)
formsAdvanced.post('/api/forms-advanced/:id/rows/bulk-delete', async (c) => {
  try {
    const denied = ownerGate(c);
    if (denied) return denied;
    const id = c.req.param('id')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);

    const body = await c.req.json<{ ids?: unknown }>().catch(() => ({}) as { ids?: unknown });
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string') : [];
    if (ids.length === 0) return c.json({ success: false, error: '削除する回答を選択してください' }, 400);
    if (ids.length > MAX_BULK_DELETE) return c.json({ success: false, error: `一度に削除できるのは ${MAX_BULK_DELETE} 件までです` }, 400);

    // Formaloo 側の row slug 解決には削除前の mirror が必要。先に消すと legacy submit_code から
    // addressable slug を引けず、remote 失敗時にも復旧材料を失うため、persist 確認後まで保持する。
    const mirrors = await Promise.all(ids.map((submissionId) => getFormalooSubmission(c.env.DB, submissionId)));
    // F6-2: form.workspace_id で多鍵解決。NULL(legacy) → env 単一鍵 fallback (byte-equivalent) /
    // 登録 active → 暗号文鍵 / 未登録・無効化・復号失敗 → null (env silent fallback しない = 誤送信防止)。
    const client = await resolveFormalooClient(c.env, form.workspace_id);
    if (client && form.formaloo_slug) {
      const resolver = makeRowsListRowSlugResolver(client, form.formaloo_slug);
      const rowSlugs: string[] = [];
      for (let i = 0; i < ids.length; i += 1) {
        const mirror = mirrors[i];
        if (!mirror || mirror.form_id !== id) {
          return c.json({ success: false, error: '削除対象の回答が見つかりません（削除していません）' }, 422);
        }
        const rowSlug = await resolveRowSlug(mirror, resolver);
        if (!rowSlug) {
          return c.json({ success: false, error: 'Formaloo 側の回答識別子を取得できません（削除していません）' }, 422);
        }
        rowSlugs.push(rowSlug);
      }

      const pushed = await client.post(`/v3.0/forms/${form.formaloo_slug}/rows/bulk-delete/`, { slugs_list: rowSlugs });
      if (!pushed.ok) {
        return c.json({ success: false, error: 'Formaloo から回答を削除できませんでした（ミラーは保持しました）' }, 502);
      }
      const confirmations = await Promise.all(rowSlugs.map((rowSlug) => client.get(`/v3.0/rows/${rowSlug}/`)));
      if (confirmations.some((result) => result.status !== 404)) {
        return c.json({ success: false, error: 'Formaloo で削除結果を確認できませんでした（ミラーは保持しました）' }, 502);
      }
    }
    const deleted = await bulkDeleteFormalooSubmissions(c.env.DB, id, ids);
    return c.json({ success: true, data: { deleted } });
  } catch (err) {
    console.error('POST /api/forms-advanced/:id/rows/bulk-delete error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// =============================================================================
// F-5 T-E1 — HP 埋め込みコード提示 + Google Sheets 連携 UI トリガ
//   埋め込みコード (iframe/script) は published のみ発行 (T-B3 publish gate に接続 / N-7)。
//   Sheets 連携は PII を外部 Sheet へ出すため owner gated (N-9)。tier 制約は live 未確定 → fail-soft (G-7)。
// =============================================================================

// GET /api/forms-advanced/:id/share — 公開 URL + 埋め込みコード (iframe/script) + Sheets 状態
formsAdvanced.get('/api/forms-advanced/:id/share', async (c) => {
  try {
    const id = c.req.param('id')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
    const def = parseDefinition(form.definition_json);
    const status = (isBuilderStatus(form.builder_status) ? form.builder_status : 'draft') as BuilderStatus;
    const addr = def.formalooAddress ?? null;
    const publicUrl = buildPublicUrl(status, addr);
    // T-A5 順方向: LINE 配信用 URL = worker の /fo/:id (追跡 + fr_id/fr_name prefill 経路)。
    //   HP 公開用 (publicUrl = 生 Formaloo URL / prefill 無し) と別キーで返す。published 時のみ
    //   (未公開は /fo/:id が 404 = 配布不可 → publicUrl と同挙動で null)。
    const base = c.env.WORKER_URL || new URL(c.req.url).origin;
    const lineDistUrl = publicUrl ? `${base}/fo/${id}` : null;
    return c.json({
      success: true,
      data: {
        published: status === 'published',
        publicUrl,
        lineDistUrl,
        // N-7: draft/in_review は埋め込みコードを発行しない (null)
        iframeCode: buildEmbedCode(status, addr, { title: form.title }),
        scriptCode: buildScriptEmbedCode(status, addr),
        gsheetConnected: form.gsheet_connected === 1,
        gsheetUrl: form.gsheet_url,
      },
    });
  } catch (err) {
    console.error('GET /api/forms-advanced/:id/share error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/forms-advanced/:id/gsheet/connect — Google Sheets 連携トリガ (owner gated / fail-soft)
formsAdvanced.post('/api/forms-advanced/:id/gsheet/connect', async (c) => {
  try {
    const denied = ownerGate(c);
    if (denied) return denied;
    const id = c.req.param('id')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);

    let connected = false;
    let gsheetUrl: string | null = null;
    let note = 'Formaloo 認証情報が未設定のため連携できませんでした（S-1 で本番連携）';
    // F6-2: form.workspace_id で多鍵解決。NULL(legacy) → env 単一鍵 fallback (byte-equivalent) /
    // 登録 active → 暗号文鍵 / 未登録・無効化・復号失敗 → null (env silent fallback しない = 誤送信防止)。fail-soft 契約不変。
    const client = await resolveFormalooClient(c.env, form.workspace_id);
    if (client && form.formaloo_slug) {
      const r = await client.post<{ data?: { gsheet_url?: string; url?: string } }>(`/v3.0/forms/${form.formaloo_slug}/regenerate-gsheet-data/`, {});
      if (r.ok) {
        connected = true;
        gsheetUrl = r.data?.data?.gsheet_url ?? r.data?.data?.url ?? null;
        note = 'Google スプレッドシートと連携しました（回答が同期されます）';
      } else {
        // tier 制約等の失敗は owner に案内 (G-7 / fail-soft)
        note = `連携に失敗しました（HTTP ${r.status}）。プランのシート連携可否・接続設定をご確認ください。`;
      }
    }
    await setFormalooGsheetState(c.env.DB, id, { connected, url: gsheetUrl });
    return c.json({ success: true, data: { connected, gsheetUrl, note } });
  } catch (err) {
    console.error('POST /api/forms-advanced/:id/gsheet/connect error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});
