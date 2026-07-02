/**
 * G8 タグ管理 — 純ロジックテスト (T-A2)。
 * env=node のため UI 描画でなく、入力検証・パレット・行内確認 pin ロジックを固定する。
 */
import { describe, test, expect } from 'vitest'
import { TAG_COLOR_PALETTE, validateTagName, DEFAULT_TAG_COLOR } from './tag-form'

describe('TAG_COLOR_PALETTE', () => {
  test('8 色ちょうど・全て HEX・先頭は LINE 緑 (default)', () => {
    expect(TAG_COLOR_PALETTE).toHaveLength(8)
    for (const c of TAG_COLOR_PALETTE) {
      expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/)
    }
    expect(TAG_COLOR_PALETTE[0]).toBe('#06C755')
    expect(DEFAULT_TAG_COLOR).toBe('#06C755')
  })

  test('重複色なし (新色を増やしても被らない)', () => {
    expect(new Set(TAG_COLOR_PALETTE).size).toBe(TAG_COLOR_PALETTE.length)
  })
})

describe('validateTagName (名前必須検証)', () => {
  test('空文字はエラー文言を返す', () => {
    expect(validateTagName('')).toBe('タグ名を入力してください')
  })
  test('空白のみはエラー', () => {
    expect(validateTagName('   ')).toBe('タグ名を入力してください')
  })
  test('有効な名前は null (エラーなし)', () => {
    expect(validateTagName('新規客')).toBeNull()
    expect(validateTagName('  VIP  ')).toBeNull()
  })
})
