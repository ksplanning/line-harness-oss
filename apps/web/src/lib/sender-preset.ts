/**
 * 送信者プリセット (G25) の client 側入力検証 (即時フィードバック用・server が正典)。
 * React 非依存で node 環境の vitest から単体テストできる。
 */

/** name (必須・20 文字以内) + iconUrl (任意・https)。OK なら null、不正なら日本語エラー。 */
export function validateSenderPresetInput(name: string, iconUrl: string): string | null {
  const n = name.trim()
  if (!n) return '送信者の名前を入力してください'
  if (n.length > 20) return '送信者の名前は20文字以内で入力してください'
  if (iconUrl && !/^https:\/\/\S+/.test(iconUrl)) return 'アイコン画像URLは https で入力してください'
  return null
}
