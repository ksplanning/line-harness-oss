// =============================================================================
// form-jp-localization — フォーム公開ページの system 文言 (送信ボタン/完了/送信エラー) を
//   harness から Formaloo form の top-level string field へ個別指定する契約 (LANE / worker + web 共有)。
// -----------------------------------------------------------------------------
// 🚨 spike 実測 (2026-07-17 / .plans/2026-07-17-form-jp-localization/evidence/confirmed-table.md):
//   - button_text / success_message / error_message は form 直下の top-level string で、hosted 公開
//     ページが**そのまま直読描画**する (色のような JSON-string RGBA format 罠なし = string は string)。
//   - 文字数オーバー/必須/placeholder 等の field validation 文言は hosted app bundle (main.js) に
//     ハードコードされ localized_content 上書きを無視する = **API で変えられない** (owner 要望①)。
//   - 言語=日本語は Formaloo アカウントに存在しない (10 言語に無し) = language トグル日本語化は不可。
// MVP 意味論 (set/absent・merge): builder が非空で入力した文言だけ push する。空欄は「未指定=触らない」
//   = 既存フォームの文言を勝手に消さない (failure_observable 直対応)。既定へ戻す clear (空欄→既定) は
//   backlog: 本 slice では serializeForm 経由の現在値表示が並走衝突で不可 → 空欄=clear と解釈すると
//   誤消去する構造リスクがあるため非採用 (plan §4 が明示許可する MVP 経路)。
// fingerprint 非関与: 文言は canonicalDefinitionProjection (fields+logic) に入らない = cron drift 誤検知不可。
// =============================================================================

/**
 * owner が個別指定できる 3 文言 (Formaloo top-level string・hosted 描画 実測 PASS)。
 * key 不在 = 未指定 (触らない)。design の色 key と同じ additive-optional 契約。
 */
export interface FormCopy {
  /** 送信ボタン文言 (Formaloo `button_text`)。既定 `Submit`。 */
  buttonText?: string;
  /** 送信完了メッセージ (Formaloo `success_message`)。既定 `Thanks! submitted successfully`。 */
  successMessage?: string;
  /** 送信エラー文言 (Formaloo `error_message`)。 */
  errorMessage?: string;
}

/** harness canonical key の順序安定リスト (normalize / push 写像が反復に使う)。 */
export const FORM_COPY_KEYS = ['buttonText', 'successMessage', 'errorMessage'] as const;

export type FormCopyKey = (typeof FORM_COPY_KEYS)[number];

/** harness canonical key → Formaloo form 直フィールド名 (worker push が利用)。 */
export const FORM_COPY_TO_FORMALOO: Record<FormCopyKey, string> = {
  buttonText: 'button_text',
  successMessage: 'success_message',
  errorMessage: 'error_message',
};

function hasOwn(o: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

/**
 * 不明キーを剥がし、更新に安全な FormCopy に正規化する (normalizeFormDesign と同型の whitelist / M-21)。
 *  - 未知キーは drop。非 string は drop。値は前後空白を trim。
 *  - **空文字 (trim 後 '') は drop** = MVP set/absent 意味論。空欄は「未指定=触らない」であり、
 *    誤って既存文言を消さない (clear=空欄 は本 slice 非採用・backlog)。
 *  - key 不在は結果でも不在 (absent)。誤クリア防止のため undefined / 空 object から既定文言を生成しない。
 */
export function normalizeFormCopy(raw: unknown): FormCopy {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const input = raw as Record<string, unknown>;
  const copy: FormCopy = {};
  for (const key of FORM_COPY_KEYS) {
    if (!hasOwn(input, key)) continue;
    const v = input[key];
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (!trimmed) continue; // 空欄 = 未指定 (触らない) = set/absent MVP
    copy[key] = trimmed;
  }
  return copy;
}
