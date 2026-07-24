import {
  toFormalooFieldPayload,
  toFormalooRawLogic,
  serializeRawLogicForPush,
  formulaReferenceIds,
  type HarnessField,
  type HarnessLogicRule,
  type FormDisplayType,
  type SuccessPageSpec,
} from '@line-crm/shared';
import type { FormalooClient } from './formaloo-client';
import { pushSuccessPages, deleteSuccessPages } from './formaloo-success-page.js';
import { ensureSystemHiddenFields, type SystemFieldEnsureResult } from './formaloo-system-fields.js';

// =============================================================================
// Formaloo push-sync (F-2 / T-B2) — harness 定義を Formaloo へ push。
// -----------------------------------------------------------------------------
// SoT (§4): push 後は Formaloo が権威。本サービスは D1 の harness 定義 → Formaloo API 形式へ
//   マッピング (shared formaloo-forms) して client 経由で送る。
// fail-soft (N-6): どの段でも失敗したら { ok:false } を返す (throw しない)。呼び出し側 (route) は
//   sync_status='out_of_sync' で D1 保存を維持し、UI に「未同期」バッジ + 再試行を出す (N-13)。
// ✅ field push endpoint は live 実測で確定 (2026-07-10): POST /v3.0/fields/ に body.form=slug で
//   201・応答 data.field.slug。form 作成 (POST /v3.0/forms/) / logic 反映 (PUT /v3.0/forms/{slug}/ の
//   logic key) も documented API 準拠。どの段の失敗も {ok:false} で fail-soft (N-6) を維持。
// =============================================================================

export interface PushResult {
  ok: boolean;
  formalooSlug?: string | null;
  /** harness field id → Formaloo field slug。 */
  fieldSlugs?: Record<string, string>;
  /** 公開フォーム address (published 時の URL 素材)。 */
  publicAddress?: string | null;
  /** route-terminal-phase2 (Track 2): reconcile 後の successPages (割当 slug 付き・definition_json へ永続)。 */
  successPages?: SuccessPageSpec[];
  /** route-terminal-phase2 (Track 2): harness SP id → Formaloo slug (logic resolver で使った写像)。 */
  successPageSlugs?: Record<string, string>;
  /** 複製 template を新 provider identity へ解決して実際に送った raw logic。 */
  resolvedRawLogic?: unknown[];
  /**
   * fr-id-capture-fix (T-C3): friend system hidden field (fr_id/fr_name) の冪等 ensure 結果。
   *   ensureSystemFields=true を渡した時のみ載る。回答導線 (publish 本体) は落とさず、system field の
   *   conflict/失敗は systemFieldsOutOfSync=true で surface して呼び出し側が再試行対象化する (silent success 禁止)。
   */
  systemFields?: SystemFieldEnsureResult;
  /** system field が全て exactly-one hidden で確定したか (created|present)。 */
  systemFieldsOk?: boolean;
  /** system field に conflict/失敗があり再試行が要るか (skipped は false)。 */
  systemFieldsOutOfSync?: boolean;
  error?: string;
}

interface FormCreateResp {
  data?: { form?: { slug?: string; address?: string; full_form_address?: string } };
}
interface FieldCreateResp {
  data?: { field?: { slug?: string }; slug?: string };
  /** type-specific OpenAPI create endpoints return the field schema directly. */
  slug?: string;
}

type JsonObject = Record<string, unknown>;

function collectChoiceTemplateFieldIds(value: unknown, ids: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectChoiceTemplateFieldIds(item, ids);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as JsonObject;
  if (typeof record.__harnessChoiceFieldId === 'string') {
    ids.add(record.__harnessChoiceFieldId);
  }
  for (const child of Object.values(record)) collectChoiceTemplateFieldIds(child, ids);
}

function extractChoiceItems(value: unknown): Array<{ title: string; slug: string }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const root = value as JsonObject;
  const nestedData = root.data && typeof root.data === 'object' && !Array.isArray(root.data)
    ? root.data as JsonObject
    : undefined;
  const field = (
    nestedData?.field && typeof nestedData.field === 'object' && !Array.isArray(nestedData.field)
      ? nestedData.field
      : root.field && typeof root.field === 'object' && !Array.isArray(root.field)
        ? root.field
        : root
  ) as JsonObject;
  if (!Array.isArray(field.choice_items)) return [];
  return field.choice_items.flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const choice = item as JsonObject;
    return typeof choice.title === 'string' && typeof choice.slug === 'string'
      ? [{ title: choice.title, slug: choice.slug }]
      : [];
  });
}

/**
 * 定義 (fields + logic) を Formaloo に push。form 未作成なら作成、既存なら slug を使う。
 * 各 field を作成して slug を集め、logic を Formaloo slug ベースで保存する。
 */
export async function pushDefinitionToFormaloo(
  client: FormalooClient,
  params: {
    formalooSlug: string | null;
    title: string;
    description?: string | null;
    fields: HarnessField[];
    logic: HarnessLogicRule[];
    /**
     * harness field id → Formaloo field slug の既知対応 (呼び出し前に field_map から構築)。
     * ここに slug がある field は PATCH で更新し、無い field のみ probe/POST で作成する = 重複作成を根絶
     * (push-idempotency / update-vs-create)。未渡し (default {}) は従来 create 挙動へ自然縮退。
     */
    existingFieldSlugs?: Record<string, string>;
    /**
     * preserve-raw (formaloo-logic-fidelity Batch 1 / R0 実測): 未編集の実 Formaloo logic を pull で
     * 捕捉した bare array 逐語。渡された (かつ array) 場合、logic push は `PATCH /v3.0/forms/{slug}/
     * {logic:<bare array>}` でこの配列を **変換せず** 再送し compound/calc/variable/jump を欠けなく保持する。
     * 未渡し (default) は従来の PUT {logic:{rules}} へ縮退 (ハーネス発案 logic / byte 不変)。
     */
    preserveRawLogic?: unknown;
    /**
     * 複製元 provider identity を内部 ID/選択肢 title に置換した raw logic。
     * field upsert 後に新 slug へ解決してから送るため、元フォームの slug は再利用しない。
     */
    rawLogicTemplate?: unknown;
    /**
     * form-route-branching (R2): フォーム表示形式。pull baseline (prevFormType) から変化した時のみ
     * `PATCH /v3.0/forms/{slug}/ {form_type}` を送る (未変化 / 未渡しは送らない = 既存フォームを勝手に変えない)。
     */
    formType?: FormDisplayType;
    /** pull 時点の form_type (baseline)。formType との差分判定に使う。 */
    prevFormType?: FormDisplayType;
    /**
     * route-terminal-submit (T-C5): logic が空 (編集で全 rule 削除) の時に `PATCH {logic:[]}` を送って
     * remote logic を明示クリアするか。default(false) は従来どおり空 logic では PATCH を送らない
     * (design のみ save 等で remote logic を勝手に消さない = byte 不変)。最後の submit 削除で早期送信を消す用。
     */
    clearLogicIfEmpty?: boolean;
    /**
     * route-terminal-phase2 (Track 2): 反映したい successPages (desired state)。**提供時のみ** reconcile
     * (create/update + 削除除外分の DELETE) する。未提供 (undefined) は SP を触らない (prev を維持)。
     */
    successPages?: SuccessPageSpec[];
    /** pull baseline の successPages (slug carry + 削除検出 + logic resolver の SP slug 解決に使う)。 */
    prevSuccessPages?: SuccessPageSpec[];
    /**
     * fr-id-capture-fix (T-C3): friend system hidden field (fr_id/fr_name) を publish 経路で冪等 auto-push するか。
     * default false = 従来 byte 不変 (既存の直接呼び出し/単体テストは影響なし)。両テナント共通 publish route が
     * env `FORMALOO_SYSTEM_FIELDS_AUTOPUSH_DISABLE!=='1'` から true を渡す。fail-soft: ensure は throw しない・
     * fields_list を読めない/失敗は publish 本体を落とさず systemFields 結果に surface する。
     */
    ensureSystemFields?: boolean;
    /** fr_name (PII owner-gate) も ensure するか。default true (env `FORMALOO_FR_NAME_AUTOPUSH_DISABLE` で切る / codex#8)。 */
    includeOwnerGatedSystemFields?: boolean;
    /** UTM 流入元記録用 exact 3 hidden aliases も friend prefix の後ろへ ensure するか。default false。 */
    includeUtmSystemFields?: boolean;
    /**
     * fr-id-hardening-round2 (③): 新規作成した field に `alias=slug` を標準付与するか。Formaloo hosted の URL prefill は
     * field の alias 一致でのみ発火し (spike F1/F2)、/fo は本人再入場の回答 prefill を field slug をキーに組む
     * (?<slug>=<value>) ため、alias=slug が無いと再入場 prefill が全滅する (owner 実機の「真っ白」真因)。slug は POST
     * 応答で判明ゆえ POST 後に PATCH {alias:slug} を付与する (2 手・fail-soft)。default false = 従来 byte 不変 (既存直接
     * 呼び出し/単体テストは影響なし)。両テナント共通 publish route が env `FORMALOO_FIELD_ALIAS_AUTOSET_DISABLE!=='1'` から渡す。
     */
    setFieldAlias?: boolean;
  },
): Promise<PushResult> {
  const existingFieldSlugs = params.existingFieldSlugs ?? {};
  // treasure-b3-calc-dynamic: formula は harness 内部 id を保持する。新規 field の slug は POST 後にしか
  // 判明しないため、通常 field → 依存解決済み formula の順へ topological に並べ、未解決/cycle は API 送信前に止める。
  const formulaFields = params.fields.filter((field) => field.type === 'variable' && field.config.variableSubType === 'formula');
  // repeating_section の column_field は参照先 slug が必要なので、参照される通常/formula field の後へ送る。
  const repeatingFields = params.fields.filter((field) => field.type === 'repeating_section');
  const nonFormulaFields = params.fields.filter((field) => (
    !(field.type === 'variable' && field.config.variableSubType === 'formula')
    && field.type !== 'repeating_section'
  ));
  const knownIds = new Set([...params.fields.map((field) => field.id), ...Object.keys(existingFieldSlugs)]);
  for (const field of formulaFields) {
    const missing = formulaReferenceIds(field.config.formula ?? '').find((id) => !knownIds.has(id));
    if (missing) return { ok: false, formalooSlug: params.formalooSlug, error: `formula reference missing: ${missing}` };
  }
  // A known remote slug makes emission possible, but it does not make a formula dependency acyclic.
  // Keep current formula ids out until their own dependencies have been resolved topologically.
  const formulaFieldIds = new Set(formulaFields.map((field) => field.id));
  const resolvedOrderIds = new Set([
    ...nonFormulaFields.map((field) => field.id),
    ...Object.keys(existingFieldSlugs).filter((id) => !formulaFieldIds.has(id)),
  ]);
  const pendingFormulaFields = [...formulaFields];
  const orderedFields = [...nonFormulaFields];
  while (pendingFormulaFields.length > 0) {
    const index = pendingFormulaFields.findIndex((field) =>
      formulaReferenceIds(field.config.formula ?? '').every((id) => resolvedOrderIds.has(id)),
    );
    if (index < 0) {
      return { ok: false, formalooSlug: params.formalooSlug, error: 'formula reference cycle' };
    }
    const [field] = pendingFormulaFields.splice(index, 1);
    orderedFields.push(field!);
    resolvedOrderIds.add(field!.id);
  }
  for (const field of repeatingFields) {
    for (const column of field.config.repeatingColumns ?? []) {
      if (!knownIds.has(column.columnField)) {
        return { ok: false, formalooSlug: params.formalooSlug, error: `repeating column reference missing: ${column.columnField}` };
      }
      if (!resolvedOrderIds.has(column.columnField) && !existingFieldSlugs[column.columnField]) {
        return { ok: false, formalooSlug: params.formalooSlug, error: `repeating column dependency unresolved: ${column.columnField}` };
      }
    }
    orderedFields.push(field);
    resolvedOrderIds.add(field.id);
  }
  // form-ensure より前に「form が既に存在するか」を捕捉 (B2)。初回 push (form 新規作成) は全 field 新規 =
  // probe 不要 = 従来 POST 経路と同値 (R5 回帰)。form 既存時のみ、未知 field を probe で実在確認する。
  const formPreExisted = !!params.formalooSlug;

  // 1) form を確保 (未 push なら作成) — 既存挙動不変
  let slug = params.formalooSlug;
  let publicAddress: string | null = null;
  if (!slug) {
    const createBody = params.description === undefined
      ? { title: params.title }
      : { title: params.title, description: params.description ?? '' };
    const created = await client.post<FormCreateResp>('/v3.0/forms/', createBody);
    if (!created.ok) return { ok: false, error: `form create failed: HTTP ${created.status}` };
    const form = created.data?.data?.form;
    slug = form?.slug ?? null;
    publicAddress = form?.full_form_address ?? form?.address ?? null;
    if (!slug) return { ok: false, error: 'form create: slug missing' };
    // ⑤(a) 公開アドレス正本化: create 応答の full_form_address 欠落を直接判定し (bare address の有無に関係なく)、
    //   GET /v3.0/forms/{slug}/ を 1 回だけ叩いて正本 full_form_address を取り込む。
    //   host 推測補完 (o.formaloo.co) は soft-200 エラーページに着地する (実測 2026-07-17) ため一切しない。
    //   取得失敗/正本欠落は fail-soft: create 応答由来の address を保持する。
    if (!form?.full_form_address) {
      const fetched = await client.request<FormCreateResp>('GET', `/v3.0/forms/${slug}/`);
      if (fetched.ok) {
        const f = fetched.data?.data?.form;
        publicAddress = f?.full_form_address ?? f?.address ?? publicAddress;
      }
    }
  }

  const fieldSlugs: Record<string, string> = {};
  const resolveFieldSlug = (fieldId: string): string | undefined => fieldSlugs[fieldId] ?? existingFieldSlugs[fieldId];

  // field 新規作成 (POST /v3.0/fields/) の共通ヘルパ。full payload (choices 込み) で作成し slug を集める。
  // field は top-level /v3.0/fields/ へ送り、所属 form は body の `form` slug で紐づける (旧 form-nested path は
  // 本番 Formaloo API に存在せず HTTP 404 だった / 2026-07-10 本番検証)。
  const createField = async (field: HarnessField): Promise<PushResult | { fslug: string }> => {
    const payload: Record<string, unknown> = { ...toFormalooFieldPayload(field, resolveFieldSlug), form: slug };
    const createPath = field.type === 'matrix'
      ? '/v3.0/fields/matrix/'
      : field.type === 'repeating_section'
        ? '/v3.0/fields/repeating_section/'
        : '/v3.0/fields/';
    // type-specific endpoint は path 自体が type discriminator。OpenAPI Request schema に readOnly type は無いため送らない。
    if (field.type === 'matrix' || field.type === 'repeating_section') delete payload.type;
    const res = await client.post<FieldCreateResp>(createPath, payload);
    if (!res.ok) {
      return {
        ok: false,
        formalooSlug: slug,
        fieldSlugs: { ...fieldSlugs },
        publicAddress,
        error: `field push failed (${field.id}): HTTP ${res.status}`,
      };
    }
    const fslug = res.data?.data?.field?.slug ?? res.data?.data?.slug ?? res.data?.slug;
    if (!fslug) {
      return {
        ok: false,
        formalooSlug: slug,
        fieldSlugs: { ...fieldSlugs },
        publicAddress,
        error: `field push: slug missing (${field.id})`,
      };
    }
    // fr-id-hardening-round2 (③ alias=slug 標準付与): Formaloo hosted の URL prefill は field の alias 一致でのみ発火し、
    //   /fo は本人再入場の回答 prefill を field slug をキーに組む (?<slug>=<value>)。既定 field は alias=null ゆえ prefill が
    //   全滅する (owner 実機の「真っ白」真因)。slug は POST 応答で判明ゆえ **POST 後に PATCH {alias:slug}** で標準付与する
    //   (POST 時 alias=slug 指定は slug 未採番ゆえ不能 = 2 手が唯一解・F7 で PATCH alias→200 実証済)。fail-soft: alias PATCH
    //   失敗は field 作成を落とさない (field は回答可能・prefill は backfill が安全網)。alias 追加は fingerprint (通常 field の
    //   alias 非射影) / pull (fromFormalooField は alias 非取込) の双方に不可視 = false-drift ゼロ。
    if (params.setFieldAlias) {
      try {
        const pr = await client.request('PATCH', `/v3.0/fields/${fslug}/`, { alias: fslug });
        if (!pr.ok) console.warn(`[formaloo-sync] field alias 付与失敗 (${field.id} / ${fslug}): HTTP ${pr.status} — 再入場 prefill は backfill 待ち`);
      } catch (e) {
        console.warn(`[formaloo-sync] field alias 付与例外 (${field.id} / ${fslug}):`, e instanceof Error ? e.message : String(e));
      }
    }
    return { fslug };
  };

  // 2) fields を upsert (update-vs-create で冪等化 / N-13: field 単位。1 つでも失敗したら out_of_sync)。
  for (const field of orderedFields) {
    let fieldSlug: string | undefined = existingFieldSlugs[field.id];

    // slug 未知 かつ form 既存 → probe GET /v3.0/fields/{field.id}/ で実在確認 (B1/B2)。
    //   200 → 既存 (pull で id=slug fallback した Formaloo-native field 等) → PATCH 更新。
    //   404 → 真の新規 → POST 作成。
    //   その他 (401/403/429/5xx/例外=status 0) → fail-soft 停止 (憶測 create で重複を作らない)。
    if (!fieldSlug && formPreExisted) {
      const probe = await client.request('GET', `/v3.0/fields/${field.id}/`);
      if (probe.status === 200) {
        fieldSlug = field.id;
      } else if (probe.status === 404) {
        fieldSlug = undefined;
      } else {
        return {
          ok: false,
          formalooSlug: slug,
          fieldSlugs: { ...fieldSlugs },
          publicAddress,
          error: `field probe failed (${field.id}): HTTP ${probe.status}`,
        };
      }
    }

    if (fieldSlug) {
      // update = PATCH /v3.0/fields/{slug}/。choice_items は Formaloo 実 API の matrix でも 500 になるため送らない。
      const patchBody = toFormalooFieldPayload(field, resolveFieldSlug);
      delete patchBody.choice_items;
      const r = await client.request('PATCH', `/v3.0/fields/${fieldSlug}/`, patchBody);
      if (r.status === 404) {
        // self-heal: Formaloo 側で field 削除済 → full payload (choices 込み) で作り直し。
        const created = await createField(field);
        if ('ok' in created) return created;
        fieldSlugs[field.id] = created.fslug;
      } else if (!r.ok) {
        return {
          ok: false,
          formalooSlug: slug,
          fieldSlugs: { ...fieldSlugs },
          publicAddress,
          error: `field update failed (${field.id}): HTTP ${r.status}`,
        };
      } else {
        fieldSlugs[field.id] = fieldSlug; // PATCH は slug 既知 = 応答 parse 不要
      }
    } else {
      // 新規 = POST /v3.0/fields/ (choices 込み) — 初回 push の従来挙動と同値。
      const created = await createField(field);
      if ('ok' in created) return created;
      fieldSlugs[field.id] = created.fslug;
    }
  }

  // 2.2) fr-id-capture-fix (T-C3): field upsert 直後に friend system hidden field (fr_id/fr_name) を冪等 auto-push。
  //   両テナント共通経路 (この関数を通る全 publish)。fail-soft = 回答導線 (publish 本体) を落とさない: ensure は
  //   throw せず、fields_list を読めない/失敗は systemFields 結果に surface して呼び出し側が再試行対象化する。
  //   ensureSystemFields=false (default / env で無効化) は 1 byte も叩かない (byte 同等 / rollback = D-4)。
  let systemFields: SystemFieldEnsureResult | undefined;
  if (params.ensureSystemFields) {
    try {
      systemFields = await ensureSystemHiddenFields(client, slug, {
        includeOwnerGated: params.includeOwnerGatedSystemFields ?? true,
        includeUtm: params.includeUtmSystemFields === true,
      });
    } catch {
      // 二重ガード: ensure は throw しない設計だが、万一の例外でも publish 本体(回答導線)は落とさない。
      //   T-C3 round2: 例外時も「system field が揃ったか不明」= fail-closed で outOfSync=true surface (silent success 禁止)。
      systemFields = { ok: false, outOfSync: true, skipped: false, logicConflict: false, outcomes: [] };
    }
  }

  // 2.5) route-terminal-phase2 (Track 2): success-page を reconcile (logic push より前 = jump_to_success_page が
  //   参照する slug を先に確定する)。prev slug は常に resolver に供給 (未変更 SP 参照も解決)。提供時のみ
  //   create/update を実行し reconcile 後の successPages / slug 写像を確定する。削除は logic push 後 (CI-2)。
  const spSlugById: Record<string, string> = {};
  for (const sp of params.prevSuccessPages ?? []) if (sp.slug) spSlugById[sp.id] = sp.slug;
  let reconciledSuccessPages: SuccessPageSpec[] | undefined;
  if (params.successPages !== undefined) {
    const spRes = await pushSuccessPages(client, slug, params.successPages, params.prevSuccessPages ?? []);
    reconciledSuccessPages = spRes.successPages;
    Object.assign(spSlugById, spRes.slugById); // reconcile 後の slug が prev を上書き
    if (!spRes.ok) return { ok: false, formalooSlug: slug, fieldSlugs, publicAddress, successPages: reconciledSuccessPages, successPageSlugs: spSlugById, error: spRes.error };
  }
  const failAfterSuccessPageReconcile = (error: string): PushResult => ({
    ok: false,
    formalooSlug: slug,
    fieldSlugs,
    publicAddress,
    ...(reconciledSuccessPages !== undefined ? { successPages: reconciledSuccessPages } : {}),
    successPageSlugs: spSlugById,
    error,
  });

  // 複製された raw template は、field upsert で採番された新 slug と、新 choice slug を使って
  // 初回 push の直前に rehydrate する。解決不能なら元 provider slug を送らず fail-safe で止める。
  let resolvedRawLogic: unknown[] | undefined;
  const templateArray = serializeRawLogicForPush(params.rawLogicTemplate);
  if (templateArray) {
    const choiceFieldIds = new Set<string>();
    collectChoiceTemplateFieldIds(templateArray, choiceFieldIds);
    const choiceSlugsByFieldId = new Map<string, Map<string, string>>();
    for (const fieldId of choiceFieldIds) {
      const fieldSlug = resolveFieldSlug(fieldId);
      if (!fieldSlug) {
        return failAfterSuccessPageReconcile(`raw logic choice field unresolved: ${fieldId}`);
      }
      const fetched = await client.request('GET', `/v3.0/fields/${fieldSlug}/`);
      if (!fetched.ok) {
        return failAfterSuccessPageReconcile(
          `raw logic choice fetch failed (${fieldId}): HTTP ${fetched.status}`,
        );
      }
      const choices = extractChoiceItems(fetched.data);
      const seenChoiceTitles = new Set<string>();
      for (const choice of choices) {
        if (seenChoiceTitles.has(choice.title)) {
          return failAfterSuccessPageReconcile(
            `raw logic choice title duplicate: ${fieldId}/${choice.title}`,
          );
        }
        seenChoiceTitles.add(choice.title);
      }
      choiceSlugsByFieldId.set(
        fieldId,
        new Map(choices.map((choice) => [choice.title, choice.slug])),
      );
    }

    const resolveReference = (value: string): string | undefined =>
      resolveFieldSlug(value) ?? spSlugById[value];
    const resolveNode = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(resolveNode);
      if (!value || typeof value !== 'object') return value;
      const source = value as JsonObject;
      const result: JsonObject = {};
      const hasRuleIdentity = source.type !== 'field' && Array.isArray(source.actions);
      for (const [key, child] of Object.entries(source)) {
        if (key === '__harnessChoiceFieldId') continue;
        if ((key === 'identifier' || key === 'field') && typeof child === 'string') {
          if (key === 'identifier' && hasRuleIdentity) {
            result[key] = child;
            continue;
          }
          const resolved = resolveReference(child);
          if (!resolved) {
            throw new Error(`raw logic field reference unresolved: ${child}`);
          }
          result[key] = resolved;
          continue;
        }
        if (
          key === 'value'
          && source.type === 'field'
          && typeof child === 'string'
        ) {
          const resolved = resolveReference(child);
          if (!resolved) {
            throw new Error(`raw logic field reference unresolved: ${child}`);
          }
          result[key] = resolved;
          continue;
        }
        if (
          key === 'value'
          && source.type === 'choice'
          && typeof child === 'string'
        ) {
          if (typeof source.__harnessChoiceFieldId !== 'string') {
            throw new Error(`raw logic choice field marker missing: ${child}`);
          }
          const choiceSlug = choiceSlugsByFieldId
            .get(source.__harnessChoiceFieldId)
            ?.get(child);
          if (!choiceSlug) {
            throw new Error(
              `raw logic choice unresolved: ${source.__harnessChoiceFieldId}/${child}`,
            );
          }
          result[key] = choiceSlug;
          continue;
        }
        result[key] = resolveNode(child);
      }
      return result;
    };

    try {
      resolvedRawLogic = resolveNode(templateArray) as unknown[];
    } catch (error) {
      return failAfterSuccessPageReconcile(
        error instanceof Error ? error.message : 'raw logic template resolve failed',
      );
    }
  }

  // 3) logic を保存。field upsert (step1-2) は不可侵 (冪等 push / L-1)。ここだけ logic 経路。
  //    (a) preserve-raw (未編集の実 Formaloo logic) あり → R0 実測の PATCH で bare array を verbatim 再送
  //        (compound/calc/variable/jump を欠けなく保持。往復不変の芯)。
  //    (b) 無し + ハーネス発案/編集 logic あり → form-route-branching T-C1: R0 bare-array を PATCH で送る
  //        (旧 PUT {logic:{rules}} は spike T-A0 実測で本番 500 = latent-500。jump 有効化の前提)。
  const preserveArray = resolvedRawLogic ?? serializeRawLogicForPush(params.preserveRawLogic);
  if (preserveArray) {
    const res = await client.request('PATCH', `/v3.0/forms/${slug}/`, { logic: preserveArray });
    if (!res.ok) return failAfterSuccessPageReconcile(`logic push failed: HTTP ${res.status}`);
  } else if (params.logic.length > 0) {
    // 新規/複製 choice field は provider が choice slug を POST 後に採番するため、definition 側の
    // config.choices(title) だけでは hosted 発火形を作れない。比較 rule が参照する field だけを
    // 1 field 1 GET で read-back し、一時的な choiceItems を変換器へ渡す。解決不能・title 重複時に
    // constant へ弱化すると保存成功に見えて分岐が発火しないため、logic PATCH 前に fail-closed にする。
    const fieldsById = new Map(params.fields.map((field) => [field.id, field]));
    const choiceValuesByFieldId = new Map<string, Set<string>>();
    for (const rule of params.logic) {
      if (rule.action === 'submit') continue;
      const field = fieldsById.get(rule.sourceFieldId);
      if (
        !field
        || (
          field.type !== 'choice'
          && field.type !== 'dropdown'
          && field.type !== 'multiple_select'
        )
      ) {
        continue;
      }
      const existingItems = field.config.choiceItems ?? [];
      const currentFieldSlug = fieldSlugs[field.id];
      const fieldIdentityChanged = currentFieldSlug !== undefined
        && currentFieldSlug !== existingFieldSlugs[field.id];
      if (
        !fieldIdentityChanged
        && existingItems.some((item) => item.slug === rule.value || item.title === rule.value)
      ) {
        continue;
      }
      const values = choiceValuesByFieldId.get(field.id) ?? new Set<string>();
      values.add(rule.value);
      choiceValuesByFieldId.set(field.id, values);
    }

    const hydratedChoiceItems = new Map<string, Array<{ title: string; slug: string }>>();
    for (const [fieldId, values] of choiceValuesByFieldId) {
      const field = fieldsById.get(fieldId)!;
      const configuredTitles = field.config.choices ?? [];
      const configuredSeen = new Set<string>();
      for (const title of configuredTitles) {
        if (configuredSeen.has(title)) {
          return failAfterSuccessPageReconcile(
            `logic choice title duplicate: ${fieldId}/${title}`,
          );
        }
        configuredSeen.add(title);
      }

      const fieldSlug = resolveFieldSlug(fieldId);
      if (!fieldSlug) {
        return failAfterSuccessPageReconcile(`logic choice field unresolved: ${fieldId}`);
      }
      const fetched = await client.request('GET', `/v3.0/fields/${fieldSlug}/`);
      if (!fetched.ok) {
        return failAfterSuccessPageReconcile(
          `logic choice fetch failed (${fieldId}): HTTP ${fetched.status}`,
        );
      }
      const items = extractChoiceItems(fetched.data);
      const seenTitles = new Set<string>();
      for (const item of items) {
        if (seenTitles.has(item.title)) {
          return failAfterSuccessPageReconcile(
            `logic choice title duplicate: ${fieldId}/${item.title}`,
          );
        }
        seenTitles.add(item.title);
      }
      for (const value of values) {
        if (!items.some((item) => item.slug === value || item.title === value)) {
          return failAfterSuccessPageReconcile(`logic choice unresolved: ${fieldId}/${value}`);
        }
      }
      hydratedChoiceItems.set(fieldId, items);
    }

    // choice source の choice_slug 解決のため fieldById (params.fields) を渡す。src/tgt slug は fieldSlugs で解決。
    //   route-terminal-phase2 (Track 2): submit rule の target が SP を指す時は spSlugById で slug を解決する
    //   (jump_to_success_page.args.identifier に載る = ルート別完了ページへの着地)。
    const fieldById = (hid: string): HarnessField | undefined => {
      const field = fieldsById.get(hid);
      const choiceItems = hydratedChoiceItems.get(hid);
      return field && choiceItems
        ? { ...field, config: { ...field.config, choiceItems } }
        : field;
    };
    const logicArray = toFormalooRawLogic(params.logic, (hid) => fieldSlugs[hid] ?? spSlugById[hid], fieldById);
    const res = await client.request('PATCH', `/v3.0/forms/${slug}/`, { logic: logicArray });
    if (!res.ok) return failAfterSuccessPageReconcile(`logic push failed: HTTP ${res.status}`);
  } else if (params.clearLogicIfEmpty) {
    // route-terminal-submit (T-C5): 編集で logic 空 → 明示クリア (最後の submit 削除で remote 早期送信を消す)。
    const res = await client.request('PATCH', `/v3.0/forms/${slug}/`, { logic: [] });
    if (!res.ok) return failAfterSuccessPageReconcile(`logic clear failed: HTTP ${res.status}`);
  }

  // 3.5) route-terminal-phase2 (Track 2 / CI-2): desired から外れた SP を明示 DELETE (logic push **後** =
  //   参照 submit rule を既に '' へ repoint 済ゆえ dangling 参照を作らない)。form DELETE 非cascade の孤児回収と
  //   同経路。提供時 (desired 明示) のみ削除判定する (未提供は SP を触らない)。
  if (params.successPages !== undefined) {
    const desiredIds = new Set(params.successPages.map((sp) => sp.id));
    const removedSlugs = (params.prevSuccessPages ?? [])
      .filter((sp) => sp.slug && !desiredIds.has(sp.id))
      .map((sp) => sp.slug!);
    if (removedSlugs.length) {
      const del = await deleteSuccessPages(client, removedSlugs);
      if (!del.ok) return { ok: false, formalooSlug: slug, fieldSlugs, publicAddress, successPages: reconciledSuccessPages, successPageSlugs: spSlugById, error: del.error };
    }
  }

  // 4) form-route-branching R2: form_type を pull baseline から変化した時のみ PATCH (idempotent / 勝手に変えない)。
  //    未渡し (design 側だけの save 等) や未変化フォームは byte 不変 = 後方互換 (failure_observable 防御)。
  if (params.formType !== undefined && params.formType !== params.prevFormType) {
    const res = await client.request('PATCH', `/v3.0/forms/${slug}/`, { form_type: params.formType });
    if (!res.ok) return failAfterSuccessPageReconcile(`form_type push failed: HTTP ${res.status}`);
  }

  return {
    ok: true,
    formalooSlug: slug,
    fieldSlugs,
    publicAddress,
    successPages: reconciledSuccessPages,
    successPageSlugs: spSlugById,
    ...(resolvedRawLogic !== undefined ? { resolvedRawLogic } : {}),
    ...(systemFields
      ? { systemFields, systemFieldsOk: systemFields.ok, systemFieldsOutOfSync: systemFields.outOfSync }
      : {}),
  };
}
