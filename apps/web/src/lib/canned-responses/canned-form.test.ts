/**
 * G23 canned-form 純ロジック test — client 検証 (保存 disable 条件) + プレビュー整形。
 */
import { describe, test, expect } from 'vitest'
import { validateCannedResponse, previewContent } from './canned-form'

describe('validateCannedResponse', () => {
  test('title 空 (trim) はタイトルエラー', () => {
    expect(validateCannedResponse({ title: '   ', content: '本文' })).toBe('タイトルを入力してください')
  })

  test('content 空 (trim) は本文エラー', () => {
    expect(validateCannedResponse({ title: 'タイトル', content: '  ' })).toBe('本文を入力してください')
  })

  test('両方あれば null (保存可)', () => {
    expect(validateCannedResponse({ title: '営業案内', content: '本日はご案内します' })).toBeNull()
  })
})

describe('previewContent', () => {
  test('改行・連続空白を 1 空白に潰す', () => {
    expect(previewContent('あいう\n\nえお   かき')).toBe('あいう えお かき')
  })

  test('60 文字超は … で切り詰め', () => {
    const long = 'あ'.repeat(80)
    const out = previewContent(long)
    expect(out.length).toBe(61)
    expect(out.endsWith('…')).toBe(true)
  })

  test('60 文字以下はそのまま', () => {
    expect(previewContent('短い本文')).toBe('短い本文')
  })
})
