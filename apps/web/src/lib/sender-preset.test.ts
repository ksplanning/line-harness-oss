/**
 * T-C9 — 送信者プリセット管理 UI の client 検証ロジック (name 20文字 / iconUrl https)。
 */
import { describe, it, expect } from 'vitest'
import { validateSenderPresetInput } from './sender-preset'

describe('T-C9 validateSenderPresetInput', () => {
  it('空名は日本語エラー', () => {
    const e = validateSenderPresetInput('  ', '')
    expect(e).toBeTruthy()
    expect(e).not.toMatch(/[a-zA-Z]{6,}/)
  })
  it('21文字はエラー', () => {
    expect(validateSenderPresetInput('あ'.repeat(21), '')).toBeTruthy()
  })
  it('20文字 + iconUrl なしは OK', () => {
    expect(validateSenderPresetInput('あ'.repeat(20), '')).toBeNull()
  })
  it('iconUrl 非 https はエラー', () => {
    expect(validateSenderPresetInput('担当A', 'http://x/i.png')).toBeTruthy()
  })
  it('iconUrl https は OK', () => {
    expect(validateSenderPresetInput('担当A', 'https://x/i.png')).toBeNull()
  })
})
