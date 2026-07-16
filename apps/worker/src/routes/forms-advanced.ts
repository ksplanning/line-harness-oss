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
  type FormalooForm,
  type FormalooSubmissionRow,
} from '@line-crm/db';
import {
  validateHarnessField,
  isDecorationType,
  toCsv,
  parseCsv,
  logicFingerprint,
  normalizeFormDesign,
  serializeRawLogicForPush,
  computeRouteTerminalWarnings,
  isExpandableMultiJumpItem,
  isExpandableTerminalItem,
  type HarnessField,
  type HarnessLogicRule,
  type FormDesign,
  type FormDesignImages,
  type FormDisplayType,
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
import { pullDefinitionFromFormaloo } from '../services/formaloo-pull.js';
import { designColorFields, applyDesignImages } from '../services/formaloo-design.js';
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
    };
  } catch {
    return { fields: [], logic: [], formalooAddress: null, rawLogic: null, logicFingerprint: null, design: undefined, formType: undefined };
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
  const publicUrl = buildPublicUrl(status, def.formalooAddress ?? null);
  // formaloo-auto-pull: drift 露出 (badge 用)。driftHasWarnings は drift 未解決時のみ最新 event を引く
  // (drift_status='none' の一般ケースは追加 query なし = N+1 回避)。
  const driftStatus = sync?.drift_status ?? 'none';
  let driftHasWarnings = false;
  if (driftStatus === 'detected' || driftStatus === 'conflict') {
    const events = await listFormalooDriftEvents(db, form.id, 1);
    driftHasWarnings = (events[0]?.has_warnings ?? 0) === 1;
  }
  return {
    id: form.id,
    title: form.title,
    description: form.description,
    formalooSlug: form.formaloo_slug,
    builderStatus: status,
    publishedAt: form.published_at,
    submitCount: form.submit_count,
    onSubmitTagId: form.on_submit_tag_id,
    onSubmitScenarioId: form.on_submit_scenario_id,
    submitMessage: form.submit_message,
    fields: def.fields,
    logic: def.logic,
    // preserve-raw (Batch 1): 未編集判定用の fingerprint のみ露出 (builder が save で carry する)。
    // rawLogic 逐語は server-side に留め PUBLIC/一覧面へ出さない (機密面 raw 非露出 / plan §grep4)。
    logicFingerprint: def.logicFingerprint ?? null,
    // form-design (Batch D): 色/画像テーマ (builder の initialDesign / プレビュー反映用)。未設定は null。
    design: def.design ?? null,
    // form-route-branching (R2): 表示形式 (builder の initialFormType)。未設定は null (builder が simple 既定表示)。
    formType: def.formType ?? null,
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

// PUT /api/forms-advanced/:id — 定義保存 (validate → 永続化 → fail-soft push-sync)
formsAdvanced.put('/api/forms-advanced/:id', async (c) => {
  const id = c.req.param('id')!;
  let syncStarted = false;
  let syncSettled = false;
  try {
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);

    const body = await c.req
      .json<{ fields?: unknown[]; logic?: unknown[]; rawLogic?: unknown; logicFingerprint?: string; title?: unknown; description?: unknown; design?: unknown; designImages?: unknown; formType?: unknown }>()
      .catch(() => ({}) as { fields?: unknown[]; logic?: unknown[]; rawLogic?: unknown; logicFingerprint?: string; title?: unknown; description?: unknown; design?: unknown; designImages?: unknown; formType?: unknown });
    if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim())) {
      return c.json({ success: false, error: 'フォーム名を入力してください' }, 400);
    }
    const newTitle = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : form.title;
    const descProvided = body.description !== undefined;
    const newDescription = descProvided
      ? (typeof body.description === 'string' && body.description.trim() ? body.description : null)
      : form.description;
    const rawFields = Array.isArray(body.fields) ? body.fields : [];
    const rawLogicRules = Array.isArray(body.logic) ? body.logic : [];

    // field を MVP subset で検証 (M-21 明示 reject)。1 つでも不正なら 400。
    const fields: HarnessField[] = [];
    for (let i = 0; i < rawFields.length; i++) {
      const r = validateHarnessField({ ...(rawFields[i] as object), position: (rawFields[i] as { position?: number }).position ?? i });
      if (!r.ok) return c.json({ success: false, error: `フィールド ${i + 1}: ${r.error}` }, 400);
      fields.push(r.field);
    }
    // logic は既存 field id を参照する rule だけ残す (孤立参照防止 / N-11)。
    // compound rule (additive actions[]) は flat target だけでなく **全アクション target** を idSet 照合し、
    // 存在 field を参照する compound は保持・dangling ref を作る rule のみ除去 (R-4/L-9/D-12)。
    const fieldIds = new Set(fields.map((f) => f.id));
    const decorationIds = new Set(fields.filter((f) => isDecorationType(f.type)).map((f) => f.id));
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
    // F-MED-2: Phase1 は submit の success-page target 非対応 → 通常 field/decoration を target 指定されても '' へ正規化
    //   (直接 API 濫用で jump_to_success_page が不正 remote logic として送出されるのを防ぐ)。Phase2 で SP 集合対応。
    .map((r) => (r.action === 'submit' && r.targetFieldId !== '' ? { ...r, targetFieldId: '' } : r));

    const prevDef = parseDefinition(form.definition_json);

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
      });
    const fieldRows = (slugFor: (fid: string) => string | null) =>
      fields.map((f) => ({ id: f.id, formalooFieldSlug: slugFor(f.id), fieldType: f.type, label: f.label, position: f.position, configJson: JSON.stringify(f.config) }));
    await saveFormalooDefinition(c.env.DB, id, {
      definitionJson: buildDefinitionJson(prevDef.formalooAddress ?? null),
      fields: fieldRows((fid) => existingFieldSlugs[fid] ?? null),
      title: newTitle,
      description: newDescription,
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
      });
      if (pushed.ok) {
        // slug + address + (backfill 後の) rawLogic + design(色) を反映
        await saveFormalooDefinition(c.env.DB, id, {
          definitionJson: buildDefinitionJson(pushed.publicAddress ?? prevDef.formalooAddress ?? null),
          fields: fieldRows((fid) => pushed.fieldSlugs?.[fid] ?? null),
          formalooSlug: pushed.formalooSlug ?? null,
          title: newTitle,
          description: newDescription,
        });
        const slug = pushed.formalooSlug ?? form.formaloo_slug;
        // form-design (Batch D): 色は既存 meta PATCH に hex で合流 (update 意味論: design 未提供なら載せない)。
        const metaRes = slug
          ? await client.request('PATCH', `/v3.0/forms/${slug}/`, {
              title: newTitle,
              description: newDescription ?? '',
              ...(designProvided ? designColorFields(incomingDesign) : {}),
            })
          : { ok: false as const, status: 0 };
        // form-design 画像: meta 成功後に replace(multipart)/remove(JSON null) を反映し、確定 S3 URL を再永続。
        // F1: applyDesignImages 失敗 (replace/remove の非 ok・不正 payload) は imageSyncError に集約し、
        //     下の sync 判定で out_of_sync へ合流させる (silent success 禁止)。成功 slot のみ URL を確定。
        let imageSyncError: string | null = null;
        if (metaRes.ok && slug && designImages) {
          const applied = await applyDesignImages(client, slug, designImages);
          if (!applied.ok) imageSyncError = applied.error ?? '画像の同期に失敗しました';
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
        } else {
          await setFormalooSyncState(c.env.DB, id, {
            syncStatus: 'idle', lastError: null, lastPushedAt: new Date().toISOString(),
            remoteDefinitionHash: null, pendingRemoteHash: null, driftStatus: 'none', driftDetectedAt: null,
          });
          syncSettled = true;
        }
      } else {
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
  try {
    const id = c.req.param('id')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
    await softDeleteFormalooForm(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/forms-advanced/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
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

// GET /api/forms-advanced/:id/rows — D1 ミラーの検索/フィルタ/ソート/ページング
formsAdvanced.get('/api/forms-advanced/:id/rows', async (c) => {
  try {
    const id = c.req.param('id')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);

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
    return c.json({ success: true, data: { rows: rows.map(serializeSubmissionRow), total, page, pageSize } });
  } catch (err) {
    console.error('GET /api/forms-advanced/:id/rows error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/forms-advanced/:id/rows/:rowId — Formaloo rows API ドリルスルー (fail-soft = mirror / N-6)
formsAdvanced.get('/api/forms-advanced/:id/rows/:rowId', async (c) => {
  try {
    const id = c.req.param('id')!;
    const rowId = c.req.param('rowId')!;
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
    const mirror = await getFormalooSubmission(c.env.DB, rowId);
    if (!mirror || mirror.form_id !== id) return c.json({ success: false, error: '回答が見つかりません' }, 404);

    // Formaloo 側の最新をドリルスルー。client 未配備 (dev) / 失敗は mirror を返す (fail-soft)。
    // F6-2: form.workspace_id で多鍵解決。NULL(legacy) → env 単一鍵 fallback (byte-equivalent) /
    // 登録 active → 暗号文鍵 / 未登録・無効化・復号失敗 → null (env silent fallback しない = 誤送信防止)。fail-soft 契約不変。
    const client = await resolveFormalooClient(c.env, form.workspace_id);
    if (client && form.formaloo_slug) {
      const r = await client.get<{ data?: unknown }>(`/v3.0/forms/${form.formaloo_slug}/rows/${rowId}/`);
      if (r.ok) {
        return c.json({ success: true, data: { id: rowId, answers: r.data?.data ?? safeParseJson(mirror.answers_json), submittedAt: mirror.submitted_at, source: 'formaloo' } });
      }
    }
    return c.json({ success: true, data: { id: rowId, answers: safeParseJson(mirror.answers_json), submittedAt: mirror.submitted_at, source: 'mirror' } });
  } catch (err) {
    console.error('GET /api/forms-advanced/:id/rows/:rowId error:', err);
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

    const { total } = await queryFormalooSubmissions(c.env.DB, { formId: id, limit: 1, offset: 0 });
    const daily = await formalooSubmissionsDailyCounts(c.env.DB, id);
    const verifiedRow = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM formaloo_submissions WHERE form_id = ? AND verified = 1').bind(id).first<{ n: number }>();

    // Formaloo 側 stats を drill (fail-soft): client 未配備/失敗は null。
    let formaloo: unknown = null;
    // F6-2: form.workspace_id で多鍵解決。NULL(legacy) → env 単一鍵 fallback (byte-equivalent) /
    // 登録 active → 暗号文鍵 / 未登録・無効化・復号失敗 → null (env silent fallback しない = 誤送信防止)。fail-soft 契約不変。
    const client = await resolveFormalooClient(c.env, form.workspace_id);
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

    const deleted = await bulkDeleteFormalooSubmissions(c.env.DB, id, ids);
    // Formaloo 側でも削除 (fail-soft): 失敗してもミラー削除は確定させる。
    // F6-2: form.workspace_id で多鍵解決。NULL(legacy) → env 単一鍵 fallback (byte-equivalent) /
    // 登録 active → 暗号文鍵 / 未登録・無効化・復号失敗 → null (env silent fallback しない = 誤送信防止)。fail-soft 契約不変。
    const client = await resolveFormalooClient(c.env, form.workspace_id);
    if (client && form.formaloo_slug) {
      try {
        await client.post(`/v3.0/forms/${form.formaloo_slug}/rows/bulk-delete/`, { rows: ids });
      } catch (e) {
        console.error('formaloo bulk-delete push failed (fail-soft):', e);
      }
    }
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
