/**
 * rich-menu-analytics/tap-view.ts の純ロジック検証 (熱量色 / ラベル / 割合 / max)。
 */
import { describe, test, expect } from 'vitest'
import { actionTypeLabel, isMeasurable, tapCountToAlpha, tapRatio, maxTapCount } from './tap-view'
import type { AreaTapResult } from '../api'

function ar(o: Partial<AreaTapResult>): AreaTapResult {
  return {
    areaId: 'a', pageId: 'p', boundsX: 0, boundsY: 0, boundsWidth: 100, boundsHeight: 100,
    actionType: 'postback', postbackData: 'x', count: 0, measurable: true, unmeasurableReason: null,
    ...o,
  }
}

describe('actionTypeLabel', () => {
  test('adds Japanese label with english suffix', () => {
    expect(actionTypeLabel('postback')).toBe('ボタン応答 (postback)')
    expect(actionTypeLabel('uri')).toBe('URL移動 (uri)')
    expect(actionTypeLabel('message')).toBe('メッセージ送信 (message)')
    expect(actionTypeLabel('richmenuswitch')).toBe('タブ切替 (richmenuswitch)')
  })
})

describe('isMeasurable', () => {
  test('follows the measurable flag', () => {
    expect(isMeasurable({ measurable: true })).toBe(true)
    expect(isMeasurable({ measurable: false })).toBe(false)
  })
})

describe('tapCountToAlpha', () => {
  test('null / max<=0 give the faint base color', () => {
    expect(tapCountToAlpha(null, 10)).toBe('rgba(59,130,246,0.05)')
    expect(tapCountToAlpha(5, 0)).toBe('rgba(59,130,246,0.05)')
  })
  test('max tap gives the hottest (reddish) color', () => {
    expect(tapCountToAlpha(10, 10)).toBe('rgba(239,68,68,0.60)')
  })
  test('half gives an intermediate color', () => {
    const c = tapCountToAlpha(5, 10)
    expect(c).toMatch(/^rgba\(149,99,157,0\.35\)$/)
  })
})

describe('tapRatio', () => {
  test('percentage to 1 decimal; 0 for null/zero max', () => {
    expect(tapRatio(64, 100)).toBe(64)
    expect(tapRatio(null, 100)).toBe(0)
    expect(tapRatio(5, 0)).toBe(0)
  })
})

describe('maxTapCount', () => {
  test('max over measurable areas; ignores non-measurable/null', () => {
    expect(maxTapCount([ar({ count: 3 }), ar({ count: 8 }), ar({ measurable: false, count: null })])).toBe(8)
  })
  test('0 when no measurable areas', () => {
    expect(maxTapCount([ar({ measurable: false, count: null })])).toBe(0)
  })
})
