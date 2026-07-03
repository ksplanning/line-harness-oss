/**
 * G23 チャット定型文 — 純ロジック (入力検証)。
 * page.tsx / modal (client component) から import。UI と分離してテスト可能にする。
 * worker 側でも検証されるが (二重検証)、client は UX 補助として空入力を弾く。
 */

/**
 * タイトル/本文の必須検証。エラー時はメッセージ文字列、OK なら null。
 * trim 後の空を弾く (server と同じ基準)。
 */
export function validateCannedResponse(input: { title: string; content: string }): string | null {
  if (!input.title.trim()) return 'タイトルを入力してください'
  if (!input.content.trim()) return '本文を入力してください'
  return null
}

/** 一覧の本文プレビュー: 改行/連続空白を潰して 60 文字で切り詰め (…付き)。 */
export function previewContent(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > 60 ? oneLine.slice(0, 60) + '…' : oneLine
}
