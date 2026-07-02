/**
 * G57 リマインダ手動登録 — 純ロジックテスト (T-A5)。
 * enroll フォームの必須検証 (友だち選択 / 基準日) を固定する。
 */
import { describe, test, expect } from 'vitest'
import { validateEnrollForm } from './enroll-form'

describe('validateEnrollForm', () => {
  test('友だち未選択はエラー', () => {
    expect(validateEnrollForm({ friendId: null, targetDate: '2026-07-10' })).toBe(
      '友だちを選んでください',
    )
  })

  test('基準日未入力はエラー', () => {
    expect(validateEnrollForm({ friendId: 'fr_1', targetDate: '' })).toBe('基準日を選んでください')
    expect(validateEnrollForm({ friendId: 'fr_1', targetDate: '   ' })).toBe('基準日を選んでください')
  })

  test('友だち選択 + 基準日 揃えば null', () => {
    expect(validateEnrollForm({ friendId: 'fr_1', targetDate: '2026-07-10' })).toBeNull()
  })

  test('友だち未選択が基準日未入力より優先 (友だち先)', () => {
    expect(validateEnrollForm({ friendId: null, targetDate: '' })).toBe('友だちを選んでください')
  })
})
