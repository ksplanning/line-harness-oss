import {
  toFormalooFieldPayload,
  toFormalooRawLogic,
  serializeRawLogicForPush,
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
  },
): Promise<PushResult> {
  const existingFieldSlugs = params.existingFieldSlugs ?? {};
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

  // field 新規作成 (POST /v3.0/fields/) の共通ヘルパ。full payload (choices 込み) で作成し slug を集める。
  // field は top-level /v3.0/fields/ へ送り、所属 form は body の `form` slug で紐づける (旧 form-nested path は
  // 本番 Formaloo API に存在せず HTTP 404 だった / 2026-07-10 本番検証)。
  const createField = async (field: HarnessField): Promise<PushResult | { fslug: string }> => {
    const payload = { ...toFormalooFieldPayload(field), form: slug };
    const res = await client.post<FieldCreateResp>('/v3.0/fields/', payload);
    if (!res.ok) return { ok: false, formalooSlug: slug, error: `field push failed (${field.id}): HTTP ${res.status}` };
    const fslug = res.data?.data?.field?.slug ?? res.data?.data?.slug;
    if (!fslug) return { ok: false, formalooSlug: slug, error: `field push: slug missing (${field.id})` };
    return { fslug };
  };

  // 2) fields を upsert (update-vs-create で冪等化 / N-13: field 単位。1 つでも失敗したら out_of_sync)。
  const fieldSlugs: Record<string, string> = {};
  for (const field of params.fields) {
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
        return { ok: false, formalooSlug: slug, error: `field probe failed (${field.id}): HTTP ${probe.status}` };
      }
    }

    if (fieldSlug) {
      // update = PATCH /v3.0/fields/{slug}/。choice_items を送らない (B6) = choices は不変 (dup も wipe も無し)。
      const patchBody = toFormalooFieldPayload(field);
      delete patchBody.choice_items;
      const r = await client.request('PATCH', `/v3.0/fields/${fieldSlug}/`, patchBody);
      if (r.status === 404) {
        // self-heal: Formaloo 側で field 削除済 → full payload (choices 込み) で作り直し。
        const created = await createField(field);
        if ('ok' in created) return created;
        fieldSlugs[field.id] = created.fslug;
      } else if (!r.ok) {
        return { ok: false, formalooSlug: slug, error: `field update failed (${field.id}): HTTP ${r.status}` };
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
    if (!spRes.ok) return { ok: false, formalooSlug: slug, fieldSlugs, successPages: reconciledSuccessPages, successPageSlugs: spSlugById, error: spRes.error };
  }

  // 3) logic を保存。field upsert (step1-2) は不可侵 (冪等 push / L-1)。ここだけ logic 経路。
  //    (a) preserve-raw (未編集の実 Formaloo logic) あり → R0 実測の PATCH で bare array を verbatim 再送
  //        (compound/calc/variable/jump を欠けなく保持。往復不変の芯)。
  //    (b) 無し + ハーネス発案/編集 logic あり → form-route-branching T-C1: R0 bare-array を PATCH で送る
  //        (旧 PUT {logic:{rules}} は spike T-A0 実測で本番 500 = latent-500。jump 有効化の前提)。
  const preserveArray = serializeRawLogicForPush(params.preserveRawLogic);
  if (preserveArray) {
    const res = await client.request('PATCH', `/v3.0/forms/${slug}/`, { logic: preserveArray });
    if (!res.ok) return { ok: false, formalooSlug: slug, fieldSlugs, error: `logic push failed: HTTP ${res.status}` };
  } else if (params.logic.length > 0) {
    // choice source の choice_slug 解決のため fieldById (params.fields) を渡す。src/tgt slug は fieldSlugs で解決。
    //   route-terminal-phase2 (Track 2): submit rule の target が SP を指す時は spSlugById で slug を解決する
    //   (jump_to_success_page.args.identifier に載る = ルート別完了ページへの着地)。
    const fieldById = (hid: string): HarnessField | undefined => params.fields.find((f) => f.id === hid);
    const logicArray = toFormalooRawLogic(params.logic, (hid) => fieldSlugs[hid] ?? spSlugById[hid], fieldById);
    const res = await client.request('PATCH', `/v3.0/forms/${slug}/`, { logic: logicArray });
    if (!res.ok) return { ok: false, formalooSlug: slug, fieldSlugs, error: `logic push failed: HTTP ${res.status}` };
  } else if (params.clearLogicIfEmpty) {
    // route-terminal-submit (T-C5): 編集で logic 空 → 明示クリア (最後の submit 削除で remote 早期送信を消す)。
    const res = await client.request('PATCH', `/v3.0/forms/${slug}/`, { logic: [] });
    if (!res.ok) return { ok: false, formalooSlug: slug, fieldSlugs, error: `logic clear failed: HTTP ${res.status}` };
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
      if (!del.ok) return { ok: false, formalooSlug: slug, fieldSlugs, successPages: reconciledSuccessPages, successPageSlugs: spSlugById, error: del.error };
    }
  }

  // 4) form-route-branching R2: form_type を pull baseline から変化した時のみ PATCH (idempotent / 勝手に変えない)。
  //    未渡し (design 側だけの save 等) や未変化フォームは byte 不変 = 後方互換 (failure_observable 防御)。
  if (params.formType !== undefined && params.formType !== params.prevFormType) {
    const res = await client.request('PATCH', `/v3.0/forms/${slug}/`, { form_type: params.formType });
    if (!res.ok) return { ok: false, formalooSlug: slug, fieldSlugs, error: `form_type push failed: HTTP ${res.status}` };
  }

  return {
    ok: true,
    formalooSlug: slug,
    fieldSlugs,
    publicAddress,
    successPages: reconciledSuccessPages,
    successPageSlugs: spSlugById,
    ...(systemFields
      ? { systemFields, systemFieldsOk: systemFields.ok, systemFieldsOutOfSync: systemFields.outOfSync }
      : {}),
  };
}
