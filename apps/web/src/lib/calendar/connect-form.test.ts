/**
 * G20 カレンダー連携 — 純ロジックテスト (T-A4)。
 * connect フォームの必須検証 (calendarId / authType=api_key 時の apiKey)。
 */
import { describe, test, expect } from 'vitest'
import { validateConnectForm } from './connect-form'

describe('validateConnectForm', () => {
  test('calendarId 空はエラー', () => {
    expect(validateConnectForm({ calendarId: '', authType: 'api_key', apiKey: 'AIza' })).toBe(
      'カレンダー ID を入力してください',
    )
    expect(validateConnectForm({ calendarId: '   ', authType: 'api_key', apiKey: 'AIza' })).toBe(
      'カレンダー ID を入力してください',
    )
  })

  test('authType=api_key で apiKey 空はエラー', () => {
    expect(validateConnectForm({ calendarId: 'me@gmail.com', authType: 'api_key', apiKey: '' })).toBe(
      'API キーを入力してください',
    )
  })

  test('authType=api_key + calendarId + apiKey 揃えば null', () => {
    expect(
      validateConnectForm({ calendarId: 'me@gmail.com', authType: 'api_key', apiKey: 'AIzaXXX' }),
    ).toBeNull()
  })

  test('api_key 以外の authType では apiKey 空でも calendarId あれば null', () => {
    expect(validateConnectForm({ calendarId: 'me@gmail.com', authType: 'oauth', apiKey: '' })).toBeNull()
  })
})
