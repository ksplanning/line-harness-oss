import {
  toFormalooFieldPayload,
  toFormalooLogic,
  serializeRawLogicForPush,
  type HarnessField,
  type HarnessLogicRule,
} from '@line-crm/shared';
import type { FormalooClient } from './formaloo-client';

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
    const created = await client.post<FormCreateResp>('/v3.0/forms/', { title: params.title });
    if (!created.ok) return { ok: false, error: `form create failed: HTTP ${created.status}` };
    const form = created.data?.data?.form;
    slug = form?.slug ?? null;
    publicAddress = form?.full_form_address ?? form?.address ?? null;
    if (!slug) return { ok: false, error: 'form create: slug missing' };
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

  // 3) logic を保存。field upsert (step1-2) は不可侵 (冪等 push / L-1)。ここだけ logic 経路。
  //    (a) preserve-raw (未編集の実 Formaloo logic) あり → R0 実測の PATCH で bare array を verbatim 再送
  //        (compound/calc/variable/jump を欠けなく保持。往復不変の芯)。
  //    (b) 無し + ハーネス発案 logic あり → 従来の PUT {logic:{rules}} (byte 不変 / 既存テスト green)。
  const preserveArray = serializeRawLogicForPush(params.preserveRawLogic);
  if (preserveArray) {
    const res = await client.request('PATCH', `/v3.0/forms/${slug}/`, { logic: preserveArray });
    if (!res.ok) return { ok: false, formalooSlug: slug, fieldSlugs, error: `logic push failed: HTTP ${res.status}` };
  } else if (params.logic.length > 0) {
    const logicObj = toFormalooLogic(params.logic, (hid) => fieldSlugs[hid]);
    const res = await client.put(`/v3.0/forms/${slug}/`, { logic: logicObj });
    if (!res.ok) return { ok: false, formalooSlug: slug, fieldSlugs, error: `logic push failed: HTTP ${res.status}` };
  }

  return { ok: true, formalooSlug: slug, fieldSlugs, publicAddress };
}
