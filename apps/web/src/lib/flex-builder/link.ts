/**
 * リンク種別の純ロジック (link-picker から分離してテスト可能に)。
 * 電話番号の正規化・種別ごとの LinkSpec 生成を扱う。
 */
import type { LinkSpec, ButtonStyle } from './types'

export interface TrackedLinkChoiceLike {
  id: string
  trackingUrl: string
}

/** 電話番号をハイフン許容で受け、tel: + 数字のみに正規化する。 */
export function telUri(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '')
  return `tel:${digits}`
}

/** URL 種別の LinkSpec。 */
export function urlLink(uri: string): LinkSpec {
  return { type: 'url', uri: uri.trim() }
}

/** tracked link を選んだときの LinkSpec (uri = trackingUrl)。 */
export function trackedLink(choice: TrackedLinkChoiceLike): LinkSpec {
  return { type: 'tracked', trackedLinkId: choice.id, uri: choice.trackingUrl }
}

/** tel 種別の LinkSpec。 */
export function telLink(phone: string): LinkSpec {
  return { type: 'tel', phone, uri: telUri(phone) }
}

/** 予約ページ URL の LinkSpec。 */
export function bookingLink(uri: string): LinkSpec {
  return { type: 'booking', uri: uri.trim() }
}

/** ボタンの見た目 3 択の日本語ラベル。 */
export const BUTTON_STYLE_OPTIONS: { value: ButtonStyle; label: string }[] = [
  { value: 'primary', label: '緑 (目立つ)' },
  { value: 'secondary', label: '白ふち' },
  { value: 'link', label: '文字だけ' },
]

export type { LinkSpec }
