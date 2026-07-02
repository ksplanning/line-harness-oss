/**
 * G8 タグ管理 — 純ロジック (入力検証・色パレット)。
 * page.tsx (client component) から import。UI と分離してテスト可能にする。
 */

/**
 * タグ色プリセット (8 色・新色禁止)。
 * ui-design.md §0「タグ色プリセット」準拠。admin で既に使う LINE 緑を先頭 (default)。
 */
export const TAG_COLOR_PALETTE = [
  '#06C755', // LINE緑
  '#3B82F6', // blue-500
  '#F59E0B', // amber-500
  '#EF4444', // red-500
  '#8B5CF6', // violet-500
  '#EC4899', // pink-500
  '#10B981', // emerald-500
  '#6B7280', // gray-500
] as const

export const DEFAULT_TAG_COLOR = TAG_COLOR_PALETTE[0]

/**
 * タグ名の必須検証。エラー時はメッセージ文字列、OK なら null。
 * worker 側でも検証されるが (二重検証)、client は UX 補助として空入力を弾く。
 */
export function validateTagName(name: string): string | null {
  if (!name.trim()) return 'タグ名を入力してください'
  return null
}
