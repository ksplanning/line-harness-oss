/**
 * F2 G58 タップ数分析 view の純ロジック (熱量カラー / アクション種別ラベル / 割合)。
 * UI から切り離して単体テストする。
 */

import type { AreaTapResult } from '../api'

/** アクション種別の日本語ラベル (生英語は括弧補足)。 */
export function actionTypeLabel(type: AreaTapResult['actionType']): string {
  switch (type) {
    case 'postback':
      return 'ボタン応答 (postback)'
    case 'uri':
      return 'URL移動 (uri)'
    case 'message':
      return 'メッセージ送信 (message)'
    case 'richmenuswitch':
      return 'タブ切替 (richmenuswitch)'
  }
}

/** area がタップ数を計測できるか (postback かつ一意帰属)。measurable フラグをそのまま採用。 */
export function isMeasurable(a: Pick<AreaTapResult, 'measurable'>): boolean {
  return a.measurable
}

/**
 * 熱量オーバーレイの背景色 (機能的色・情報表現。テキスト色には新色を使わない)。
 * count=0 → 薄い青 / max → 濃い赤 の線形補間。max<=0 or count null は透明寄り。
 */
export function tapCountToAlpha(count: number | null, max: number): string {
  if (count === null || max <= 0) return 'rgba(59,130,246,0.05)'
  const t = Math.max(0, Math.min(1, count / max))
  // blue(59,130,246) → red(239,68,68) を t で補間、alpha は 0.1..0.6。
  const r = Math.round(59 + (239 - 59) * t)
  const g = Math.round(130 + (68 - 130) * t)
  const b = Math.round(246 + (68 - 246) * t)
  const a = (0.1 + 0.5 * t).toFixed(2)
  return `rgba(${r},${g},${b},${a})`
}

/** 割合 (%)。max=0 or count null は 0。棒バーの width 用。 */
export function tapRatio(count: number | null, max: number): number {
  if (count === null || max <= 0) return 0
  return Math.round((count / max) * 1000) / 10
}

/** measurable な area の中での最大タップ数 (割合/熱量の分母)。0 件なら 0。 */
export function maxTapCount(areas: Pick<AreaTapResult, 'count' | 'measurable'>[]): number {
  const counts = areas.filter((a) => a.measurable && a.count !== null).map((a) => a.count as number)
  return counts.length > 0 ? Math.max(...counts) : 0
}
