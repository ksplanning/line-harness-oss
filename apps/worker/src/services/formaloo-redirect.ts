import { buildRedirectTargetUrl, type FormRedirect } from '@line-crm/shared';
import type { FormalooClient } from './formaloo-client.js';

// =============================================================================
// route-terminal-phase2 (Track 1) — worker redirect push helpers。
// -----------------------------------------------------------------------------
// formaloo-copy.ts (form-jp-localization) を写経元にした present-key-only 写像 + soft-200 対策の
//   GET-after-PATCH 確認。formaloo-copy.ts を触らず file-disjoint に隔離 (並走衝突最小化)。
// 🚨 spike 実測 (2026-07-18 / spike-results.md):
//   - M1: form_redirects_after_submit は form 直下 top-level string。hosted 送信後に実ナビゲーション。
//   - M7: form PATCH は存在しないプロパティ・受理不能値を soft-200 で無言無視する → metaRes.ok だけを idle
//     根拠にすると「保存済に見えて hosted に出ない」殻完了を再発させる → GET-after-PATCH で反映確認。
// update 意味論: url が非空のときだけ送る (未設定/クリアは route が別扱い = clear payload を明示 null)。
// =============================================================================

/**
 * FormRedirect の present key を Formaloo form 直キーへ写像する (present key のみ)。
 *   - url 非空: form_redirects_after_submit = buildRedirectTargetUrl(url, openExternalBrowser)
 *     (openExternalBrowser=1 を URL 構造付与済の **最終 target** を載せる = M8)。
 *   - includeData(boolean): include_data_on_redirect (reserved / MVP 非露出)。
 *   - url 未設定は form_redirects_after_submit を送らない (clear は route が form_redirects_after_submit:null)。
 * title/description の既存 meta PATCH body にこの object を merge する (新エンドポイント不要)。
 */
export function redirectFields(r: FormRedirect | undefined | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!r || typeof r !== 'object') return out;
  if (typeof r.url === 'string' && r.url.trim()) {
    out.form_redirects_after_submit = buildRedirectTargetUrl(r.url.trim(), r.openExternalBrowser === true);
  }
  if (typeof r.includeData === 'boolean') {
    out.include_data_on_redirect = r.includeData;
  }
  return out;
}

/** confirmRedirectReflected の結果 (fail-soft: throw せず ok/error を返す・CopyReflectionResult と同型)。 */
export interface RedirectReflectionResult {
  /** 送った form_redirects_after_submit が remote に反映されていれば true。送る url が無ければ確認スキップで true。 */
  ok: boolean;
  /** 不一致 / GET 失敗時の owner 向け要約 (out_of_sync の lastError 用)。 */
  error?: string;
}

/** GET 応答 envelope 抽出 (formaloo-copy.ts extractForm と同 shape・fixture-vs-reality 乖離回避)。 */
function extractForm(data: unknown): Record<string, unknown> {
  const r = (data ?? {}) as Record<string, any>;
  return (r?.data?.form ?? r?.data ?? r?.form ?? {}) as Record<string, unknown>;
}

/** URL 等値 (Formaloo が保存時に canonicalize する trailing slash 差等を吸収 / fail-closed は温存)。 */
function urlEqual(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return new URL(a).toString() === new URL(b).toString();
  } catch {
    return false;
  }
}

/**
 * meta PATCH 後に GET-after-PATCH で「送った redirect URL が本当に反映されたか」を確認する (soft-200 対策)。
 * redirectFields の form_redirects_after_submit (最終 target URL) を remote GET の値と URL 等値で比較し、
 * eventual consistency 用に bounded retry する。一致で ok / 不一致・GET 失敗は ok:false (route が out_of_sync)。
 * 送る url が無ければ確認対象なしとして GET せず ok:true (confirmFormCopyReflected と同型)。
 */
export async function confirmRedirectReflected(
  client: FormalooClient,
  formalooSlug: string,
  redirect: FormRedirect | undefined | null,
  opts?: { retries?: number; sleep?: (ms: number) => Promise<void> },
): Promise<RedirectReflectionResult> {
  const wanted = redirectFields(redirect).form_redirects_after_submit;
  if (typeof wanted !== 'string') return { ok: true }; // 送る url なし = 確認対象なし (GET しない)

  const retries = opts?.retries ?? 2;
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; attempt <= retries; attempt++) {
    const g = await client.request('GET', `/v3.0/forms/${formalooSlug}/`);
    if (g.ok) {
      const form = extractForm(g.data);
      const got = form.form_redirects_after_submit;
      // 非 string (欠落/null = soft-200 無言無視の兆候) は不一致扱い (fail-closed 温存)。
      if (typeof got === 'string' && urlEqual(got, wanted)) return { ok: true };
    }
    if (attempt < retries) await sleep(200 * (attempt + 1));
  }
  return { ok: false, error: '飛び先 URL が公開ページに反映されませんでした' };
}
