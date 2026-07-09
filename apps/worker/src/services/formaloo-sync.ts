import {
  toFormalooFieldPayload,
  toFormalooLogic,
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
// ⚠️ 書き込み endpoint (POST /forms/・/fields/・logic) の厳密な payload は live push (closer S-1 +
//   browser-evaluator) で最終確定する。本実装は documented API 形に沿った fail-soft な骨格。
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
  },
): Promise<PushResult> {
  // 1) form を確保 (未 push なら作成)
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

  // 2) fields を作成し slug を集める (N-13: field 単位。1 つでも失敗したら out_of_sync)
  const fieldSlugs: Record<string, string> = {};
  for (const field of params.fields) {
    const payload = toFormalooFieldPayload(field);
    const res = await client.post<FieldCreateResp>(`/v3.0/forms/${slug}/fields/`, payload);
    if (!res.ok) return { ok: false, formalooSlug: slug, error: `field push failed (${field.id}): HTTP ${res.status}` };
    const fslug = res.data?.data?.field?.slug ?? res.data?.data?.slug;
    if (!fslug) return { ok: false, formalooSlug: slug, error: `field push: slug missing (${field.id})` };
    fieldSlugs[field.id] = fslug;
  }

  // 3) logic を Formaloo slug ベースで保存 (harness field id → Formaloo slug に解決)
  if (params.logic.length > 0) {
    const logicObj = toFormalooLogic(params.logic, (hid) => fieldSlugs[hid]);
    const res = await client.put(`/v3.0/forms/${slug}/`, { logic: logicObj });
    if (!res.ok) return { ok: false, formalooSlug: slug, fieldSlugs, error: `logic push failed: HTTP ${res.status}` };
  }

  return { ok: true, formalooSlug: slug, fieldSlugs, publicAddress };
}
