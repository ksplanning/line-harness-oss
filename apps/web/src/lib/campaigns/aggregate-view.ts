/**
 * F2 G3 キャンペーン集計 view の純ロジック (率計算 / 表示整形 / client 検証)。
 * UI から切り離して単体テストする (率計算・null 整形・fallback 名)。
 */

import type { CampaignAggregate, CampaignBroadcastSummary } from '../api'

/** 開封率 (%)。分母 (対象) 0 or 開封 null なら null (「-」表示)。小数第 1 位。 */
export function openRate(agg: Pick<CampaignAggregate, 'totalTarget' | 'totalOpened'>): number | null {
  if (agg.totalOpened === null || agg.totalTarget <= 0) return null
  return Math.round((agg.totalOpened / agg.totalTarget) * 1000) / 10
}

/** クリック率 (%)。分母 0 or クリック null なら null。 */
export function clickRate(agg: Pick<CampaignAggregate, 'totalTarget' | 'totalClicked'>): number | null {
  if (agg.totalClicked === null || agg.totalTarget <= 0) return null
  return Math.round((agg.totalClicked / agg.totalTarget) * 1000) / 10
}

/** 数値表示。null は「-」、それ以外は ja-JP ロケールの「N人」等 (suffix 指定可)。 */
export function formatCount(n: number | null, suffix = ''): string {
  if (n === null) return '-'
  return `${n.toLocaleString('ja-JP')}${suffix}`
}

/** 率表示。null は「-」、それ以外は「X.X%」。 */
export function formatRate(r: number | null): string {
  if (r === null) return '-'
  return `${r.toLocaleString('ja-JP')}%`
}

/**
 * 配信名の表示 (batch1 L-3 教訓)。title が null/空なら
 * 「名前未取得 (ID: xxxxxx)」に fallback (末尾 6 文字)。
 */
export function broadcastDisplayName(b: Pick<CampaignBroadcastSummary, 'title' | 'broadcastId'>): string {
  const t = (b.title ?? '').trim()
  if (t) return t
  return `名前未取得 (ID: ${b.broadcastId.slice(-6)})`
}

/** キャンペーン名の client 検証 (UX 側)。trim 後 1..100 文字。 */
export function validateCampaignName(name: string): { ok: true } | { ok: false; error: string } {
  const t = name.trim()
  if (!t) return { ok: false, error: 'キャンペーン名を入力してください' }
  if (t.length > 100) return { ok: false, error: 'キャンペーン名は 100 文字以内で入力してください' }
  return { ok: true }
}
