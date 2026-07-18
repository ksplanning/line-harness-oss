// =============================================================================
// form-response-display-fix (T-C1): 回答データ画面の日時表示ヘルパ (JST 壁時計)。
//   mirror submitted_at は Formaloo created_at (UTC ISO・末尾 Z) をそのまま保存しているため、
//   従来の `iso.slice(0,16).replace('T',' ')` は UTC を素通しで出していた (owner 実機: 08:18 = JST 17:18)。
//   formatJstMinute は epoch に +9h shift してから UTC 整形することで JST 壁時計を得る
//   (packages/db utils.ts:toJstString と同型イディオム)。tz 明示入力 (Z/+00:00/+09:00) は真の instant から
//   正しい JST を出す = +09:00 の値でも二重変換にならない (shift は wall-clock でなく epoch に適用)。
//   保存形式は変えない (表示のみ / 期間フィルタの julianday UTC 比較を壊さない)。
// =============================================================================

/** JST offset: UTC+9 をミリ秒で。 */
const JST_OFFSET_MS = 9 * 60 * 60_000

/**
 * ISO 日時文字列を JST 壁時計 'YYYY-MM-DD HH:mm' へ整形する。
 *   - Z / +00:00 / +09:00 いずれの tz 明示入力でも、真の instant を epoch 化 → +9h shift → 分精度で整形。
 *   - 空 / null / undefined は '—' (欠損表示)。
 *   - 解釈不能な文字列 (NaN) は throw せず原文をそのまま返す (表示を壊さない fallback)。
 */
export function formatJstMinute(iso: string | null | undefined): string {
  if (!iso) return '—'
  const ms = new Date(iso).getTime()
  if (Number.isNaN(ms)) return iso
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ')
}
