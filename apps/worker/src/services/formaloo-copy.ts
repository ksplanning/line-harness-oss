import {
  JP_LOCALIZED_CONTENT,
  MANAGED_LOCALIZATION_KEYS,
  FORM_COPY_KEYS,
  FORM_COPY_TO_FORMALOO,
  buildLocalizedContentMerge,
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

/** `localized_content` の管理 key だけを運ぶ meta PATCH fragment。 */
export interface LocalizedContentPatchFields {
  localized_content?: Record<string, unknown>;
}

function localizationRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * 現行 form の `localized_content` を GET して、管理 key だけを ON/OFF merge する。
 * `combined_localized_content` は英語 default 全体を含むため merge 元にはしない。
 * GET 失敗や既に目的状態なら `{}` を返し、foreign clobber / 不要 PATCH を避ける。
 */
export async function localizedContentFields(
  client: FormalooClient,
  formalooSlug: string,
  enabled: boolean,
): Promise<LocalizedContentPatchFields> {
  const g = await client.request('GET', `/v3.0/forms/${formalooSlug}/`);
  if (!g.ok) return {};
  const form = extractForm(g.data);
  const existing = localizationRecord(form.localized_content);
  const merged = buildLocalizedContentMerge(existing, enabled);
  return merged === existing ? {} : { localized_content: merged };
}

/** localized_content の soft-200 確認結果。 */
export interface LocalizedContentReflectionResult {
  ok: boolean;
  error?: string;
}

/**
 * GET-after-PATCH で管理 key の ON=日本語全一致 / OFF=全件不在を確認する。
 * foreign key は比較対象外。GET 失敗・不一致は route が out_of_sync に surface できる形で返す。
 */
export async function confirmLocalizedContentReflected(
  client: FormalooClient,
  formalooSlug: string,
  enabled: boolean,
  opts?: { retries?: number; sleep?: (ms: number) => Promise<void> },
): Promise<LocalizedContentReflectionResult> {
  const retries = opts?.retries ?? 2;
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let lastMiss = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const g = await client.request('GET', `/v3.0/forms/${formalooSlug}/`);
    if (g.ok) {
      const current = localizationRecord(extractForm(g.data).localized_content);
      let allMatch = true;
      for (const key of MANAGED_LOCALIZATION_KEYS) {
        const matches = enabled
          ? current[key] === JP_LOCALIZED_CONTENT[key]
          : !Object.prototype.hasOwnProperty.call(current, key);
        if (!matches) {
          allMatch = false;
          lastMiss = key;
          break;
        }
      }
      if (allMatch) return { ok: true };
    }
    if (attempt < retries) await sleep(200 * (attempt + 1));
  }
  return {
    ok: false,
    error: `日本語 UI が公開ページ設定に反映されませんでした（${lastMiss || '確認に失敗しました'}）`,
  };
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
 * 反映確認の比較専用正規化 (form-copy-sync-warning-fix / evidence/spike-normalization-matrix.md §2+§4)。
 * Formaloo はサーバ側で文言を保存時に正規化する (実測):
 *   - **full NFKC**: 全角！→半角! / ？→? / （）→() / 全角英数→半角 / 丸数字①→1 / ㈱→(株) /
 *     半角カナ→全角 / ローマ数字Ⅳ→IV / 単位㎏→kg / 濁点合成 が→が / NBSP→space。
 *   - NFKC 非対象の追加 fold: 制御空白 \r \t → space / 連続スペース → 単一 space。
 * harness は owner が打った全角値をそのまま送るため、strict 等値だと恒久不一致 → out_of_sync 誤警告になる。
 * 比較の両辺に本正規化を掛けることで Formaloo の fold と **exact mirror** し誤警告を消す (over-fold なし)。
 *
 * fail-closed 温存 (最重要): \n は保持・lowercase/trim は追加しない (copy は大小区別・sent は既に trim 済)。
 *   英語既定 'Thanks! submitted successfully' や旧異文言など **真の未反映** は本正規化後も日本語 copy と
 *   不一致のまま → 依然 out_of_sync (確認を殺さない)。**送信経路 (formCopyFields/PATCH body) は 1 バイトも
 *   変えない** = 比較専用 (comparison-only)。owner 入力の全角値は Formaloo にそのまま渡し続ける。
 */
function normalizeForCompare(s: string): string {
  return s.normalize('NFKC').replace(/[\r\t]/g, ' ').replace(/ +/g, ' ');
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
        // form-copy-sync-warning-fix: Formaloo の server-side 正規化 (全角→半角 等) に耐性を持たせる比較。
        //   非 string (欠落/null = soft-200 無言無視の兆候) は従来通り不一致扱い (fail-closed 温存)。
        const got = form[field];
        if (typeof got !== 'string' || normalizeForCompare(got) !== normalizeForCompare(value)) {
          allMatch = false; lastMiss = field; break;
        }
      }
      if (allMatch) return { ok: true };
    }
    if (attempt < retries) await sleep(200 * (attempt + 1));
  }
  return { ok: false, error: `文言が公開ページに反映されませんでした（${lastMiss || '確認に失敗しました'}）` };
}
