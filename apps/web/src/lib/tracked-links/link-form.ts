/**
 * G43 計測リンク — 純ロジック (入力検証)。
 * page.tsx (client component) から import。worker 側も検証するが client は UX 補助。
 */

/** リンク名の必須検証。エラー時はメッセージ、OK なら null。 */
export function validateLinkName(name: string): string | null {
  if (!name.trim()) return 'リンク名を入力してください'
  return null
}

/**
 * 遷移先 URL の形式検証。空 / URL 非形式 / http(s) 以外はエラー。
 * URL コンストラクタで parse し、http/https スキームのみ許可。
 */
export function validateOriginalUrl(url: string): string | null {
  const trimmed = url.trim()
  if (!trimmed) return '遷移先 URL を入力してください'
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return '正しい URL を入力してください（例: https://example.com）'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return '正しい URL を入力してください（例: https://example.com）'
  }
  return null
}
