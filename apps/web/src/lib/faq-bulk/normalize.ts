/**
 * question 正規化 — 重複突合の「単一正典」。
 *
 * UI 側 (validate.ts) と Worker 側 (routes/faqs.ts の bulk ハンドラ) が
 * **同一入力→同一出力**を出すことで、「UI では重複・サーバでは新規」による
 * 二重登録を防ぐ (spec §API 重複判定 / D-19)。
 *
 * ⚠️ 重要: Worker 側の正規化を変更するときは必ずこのロジックと一致させること。
 * 変更時は normalize.test.ts と faqs.test.ts の両方のパリティテストを緑にする。
 *
 * 正規化ステップ:
 *  1. 全角 ASCII (！-～ = U+FF01..U+FF5E) を半角 (U+0021..U+007E) に変換
 *  2. 全角スペース (U+3000) を半角スペースに変換
 *  3. 連続する空白を単一スペースに畳む + 前後 trim
 *  4. 小文字化 (ASCII 大小無視)
 */
export function normalizeQuestion(input: string): string {
  if (!input) return ''
  // 1. 全角 ASCII → 半角 ASCII
  let s = input.replace(/[！-～]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
  )
  // 2. 全角スペース → 半角スペース
  s = s.replace(/　/g, ' ')
  // 3. 連続空白を単一スペースに + trim
  s = s.replace(/\s+/g, ' ').trim()
  // 4. 小文字化
  return s.toLowerCase()
}
