/**
 * B-5 (T-E1) — /knowledge の nav 出し分け (NAV_FEATURE に '/knowledge':'faq' additive・faq 権限で表示 / H-4)。
 * sidebar.tsx の固定 nav 配列への項目追加は本 map と対で必要 (NAV_FEATURE だけでは非表示)。sidebar 側は build で担保。
 */
import { describe, expect, test } from 'vitest'
import { NAV_FEATURE, isNavVisible } from './nav-permissions'

describe('/knowledge nav 権限', () => {
  test("NAV_FEATURE に '/knowledge':'faq' が additive で載る", () => {
    expect(NAV_FEATURE['/knowledge']).toBe('faq')
  })
  test('custom role で faq 権限があれば表示・なければ非表示', () => {
    expect(isNavVisible('/knowledge', { permissions: ['faq'], hasCustomRole: true })).toBe(true)
    expect(isNavVisible('/knowledge', { permissions: ['chat'], hasCustomRole: true })).toBe(false)
  })
  test('built-in role (custom でない) は常に表示 (byte-identical)', () => {
    expect(isNavVisible('/knowledge', { permissions: null, hasCustomRole: false })).toBe(true)
  })
})
