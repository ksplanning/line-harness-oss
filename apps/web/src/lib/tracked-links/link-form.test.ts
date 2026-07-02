/**
 * G43 計測リンク — 純ロジックテスト (T-A3)。
 * 入力検証 (リンク名必須 / URL 形式) を固定する。UI 描画は browser-evaluator E2E で検証。
 */
import { describe, test, expect } from 'vitest'
import { validateLinkName, validateOriginalUrl } from './link-form'

describe('validateLinkName (リンク名必須)', () => {
  test('空はエラー文言', () => {
    expect(validateLinkName('')).toBe('リンク名を入力してください')
    expect(validateLinkName('   ')).toBe('リンク名を入力してください')
  })
  test('有効な名前は null', () => {
    expect(validateLinkName('春キャンペーン')).toBeNull()
  })
})

describe('validateOriginalUrl (遷移先 URL 形式)', () => {
  test('空はエラー文言', () => {
    expect(validateOriginalUrl('')).toBe('遷移先 URL を入力してください')
    expect(validateOriginalUrl('   ')).toBe('遷移先 URL を入力してください')
  })
  test('URL でない文字列はエラー', () => {
    expect(validateOriginalUrl('not a url')).toBe('正しい URL を入力してください（例: https://example.com）')
    expect(validateOriginalUrl('example.com')).toBe('正しい URL を入力してください（例: https://example.com）')
  })
  test('http/https の正しい URL は null', () => {
    expect(validateOriginalUrl('https://example.com')).toBeNull()
    expect(validateOriginalUrl('https://example.com/path?q=1')).toBeNull()
    expect(validateOriginalUrl('http://example.com')).toBeNull()
  })
  test('前後空白は trim して判定', () => {
    expect(validateOriginalUrl('  https://example.com  ')).toBeNull()
  })
})
