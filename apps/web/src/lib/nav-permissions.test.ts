/**
 * nav-permissions (G64 fold-in ①) — sidebar/dashboard 共有の権限出し分けコア。
 * custom role は許可外 href を隠す / built-in・未取得・未掲載 href は常に表示 (byte-identical)。
 */
import { describe, it, expect } from 'vitest'
import { isNavVisible, NAV_FEATURE } from './nav-permissions'

describe('isNavVisible', () => {
  const chatOnly = { permissions: ['chat', 'friend'], hasCustomRole: true }

  it('custom role: 許可 feature の href は表示', () => {
    expect(isNavVisible('/chats', chatOnly)).toBe(true)
    expect(isNavVisible('/friends', chatOnly)).toBe(true)
  })

  it('custom role: 許可外 feature の href は非表示', () => {
    expect(isNavVisible('/broadcasts', chatOnly)).toBe(false)
    expect(isNavVisible('/scenarios', chatOnly)).toBe(false)
    expect(isNavVisible('/health', chatOnly)).toBe(false)
    expect(isNavVisible('/staff', chatOnly)).toBe(false)
  })

  it('custom role: 未掲載 href (ダッシュボード等) は常に表示', () => {
    expect(isNavVisible('/', chatOnly)).toBe(true)
    expect(isNavVisible('/unknown', chatOnly)).toBe(true)
  })

  it('built-in role (hasCustomRole=false): 全 href 表示 (byte-identical)', () => {
    const builtin = { permissions: ['chat'], hasCustomRole: false }
    expect(isNavVisible('/broadcasts', builtin)).toBe(true)
    expect(isNavVisible('/staff', builtin)).toBe(true)
  })

  it('permissions 未取得 (null): 全 href 表示 (フォールバック)', () => {
    const loading = { permissions: null, hasCustomRole: true }
    expect(isNavVisible('/broadcasts', loading)).toBe(true)
  })

  it('NAV_FEATURE は代表 href を正しい feature に対応', () => {
    expect(NAV_FEATURE['/broadcasts']).toBe('broadcast')
    expect(NAV_FEATURE['/scenarios']).toBe('scenario')
    expect(NAV_FEATURE['/health']).toBe('system_update')
    expect(NAV_FEATURE['/staff']).toBe('staff_admin')
  })
})
