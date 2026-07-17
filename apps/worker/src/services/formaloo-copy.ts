import {
  FORM_COPY_KEYS,
  FORM_COPY_TO_FORMALOO,
  type FormCopy,
  type FormCopyKey,
} from '@line-crm/shared';
import type { FormalooClient } from './formaloo-client.js';

// =============================================================================
// form-jp-localization push helpers — harness FormCopy を Formaloo form 直フィールドへ反映。
// -----------------------------------------------------------------------------
// designColorFields / confirmDesignReflected (formaloo-design.ts) を写経元にした present-key-only 写像 +
//   soft-200 対策の GET-after-PATCH 確認。formaloo-design.ts を触らず file-disjoint に隔離 (並走衝突最小化)。
// 🚨 spike 実測 (2026-07-17 confirmed-table.md):
//   - button_text / success_message / error_message は form 直下 top-level string で、hosted 公開ページが
//     **そのまま直読描画**する (色のような JSON-string RGBA format 罠なし = string は string)。
//   - form PATCH は存在しないプロパティを soft-200 で無言無視する地雷があるため、metaRes.ok だけを idle
//     根拠にすると「保存済に見えて hosted に出ない」殻完了を再発させる → GET-after-PATCH で反映を確認する。
// update 意味論: 非空文言だけ送る (未指定/空は載せない = Formaloo 側の既存文言を誤って潰さない)。
// =============================================================================

/**
 * FormCopy の非空 string を Formaloo form 直キー (button_text/success_message/error_message) に変換する
 *   (present key のみ)。title/description の既存 meta PATCH body にこの object を merge する (新エンドポイント不要)。
 * 未設定 / 空文字の文言は送らない = Formaloo 側を未変更のまま残す (誤クリア防止 / update 意味論)。
 */
export function formCopyFields(copy: FormCopy | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!copy || typeof copy !== 'object') return out;
  for (const key of FORM_COPY_KEYS) {
    const v = copy[key as FormCopyKey];
    if (typeof v !== 'string' || !v.trim()) continue;
    out[FORM_COPY_TO_FORMALOO[key as FormCopyKey]] = v.trim();
  }
  return out;
}

/** confirmFormCopyReflected の結果 (fail-soft: throw せず ok/error を返す・DesignReflectionResult と同型)。 */
export interface CopyReflectionResult {
  /** 送った全文言が remote に反映されていれば true。送る文言が無ければ確認スキップで true。 */
  ok: boolean;
  /** 不一致 / GET 失敗時の owner 向け要約 (out_of_sync の lastError 用)。 */
  error?: string;
}

/** GET 応答 envelope 抽出 (formaloo-design.ts extractForm と同 shape・id-191 fixture-vs-reality 乖離回避)。 */
function extractForm(data: unknown): Record<string, unknown> {
  const r = (data ?? {}) as Record<string, any>;
  return (r?.data?.form ?? r?.data ?? r?.form ?? {}) as Record<string, unknown>;
}

/**
 * meta PATCH 後に GET-after-PATCH で「送った文言が本当に反映されたか」を確認する (soft-200 対策)。
 * 送った各文言 (formCopyFields で Formaloo 直キー + 値へ) を remote GET の値と厳密一致で比較し、
 * eventual consistency 用に bounded retry する。全一致で ok / 不一致・GET 失敗は ok:false (route が out_of_sync)。
 * 送る文言が 1 つも無ければ確認対象なしとして GET せず ok:true (confirmDesignReflected と同型)。
 */
export async function confirmFormCopyReflected(
  client: FormalooClient,
  formalooSlug: string,
  copy: FormCopy | undefined | null,
  opts?: { retries?: number; sleep?: (ms: number) => Promise<void> },
): Promise<CopyReflectionResult> {
  const wanted = Object.entries(formCopyFields(copy)); // [[formaloo_field, expected_value], ...]
  if (wanted.length === 0) return { ok: true }; // 送る文言なし = 確認対象なし (GET しない)

  const retries = opts?.retries ?? 2;
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastMiss = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const g = await client.request('GET', `/v3.0/forms/${formalooSlug}/`);
    if (g.ok) {
      const form = extractForm(g.data);
      let allMatch = true;
      for (const [field, value] of wanted) {
        if (form[field] !== value) { allMatch = false; lastMiss = field; break; }
      }
      if (allMatch) return { ok: true };
    }
    if (attempt < retries) await sleep(200 * (attempt + 1));
  }
  return { ok: false, error: `文言が公開ページに反映されませんでした（${lastMiss || '確認に失敗しました'}）` };
}
