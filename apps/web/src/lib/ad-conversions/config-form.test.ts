/**
 * 広告CV連携 config-form 純ロジックテスト (batch2 C6 / G34)。
 *
 * 最重要: secret マスク破壊の回避 (編集は「空欄=維持」で入力欄だけ送る)。
 * platform 別フィールド定義が worker が読む config キーに一致することも固定。
 */
import { describe, test, expect } from 'vitest'
import {
  PLATFORM_FIELDS,
  PLATFORM_OPTIONS,
  buildConfigForSave,
  platformDisplay,
  isPlatformName,
} from './config-form'

describe('platform フィールド定義 (worker config キー一致)', () => {
  test('4 platform (meta/google/x/tiktok) をカバー', () => {
    expect(PLATFORM_OPTIONS).toEqual(['meta', 'google', 'x', 'tiktok'])
  })

  test('meta の config キーは pixel_id/access_token/test_event_code (改名不可)', () => {
    expect(PLATFORM_FIELDS.meta.map((f) => f.key)).toEqual(['pixel_id', 'access_token', 'test_event_code'])
  })

  test('google の config キーは customer_id/conversion_action_id/oauth_token/developer_token', () => {
    expect(PLATFORM_FIELDS.google.map((f) => f.key)).toEqual([
      'customer_id', 'conversion_action_id', 'oauth_token', 'developer_token',
    ])
  })

  test('secret 欄 (access_token/oauth_token/developer_token) は secret フラグ', () => {
    expect(PLATFORM_FIELDS.meta.find((f) => f.key === 'access_token')?.secret).toBe(true)
    expect(PLATFORM_FIELDS.google.find((f) => f.key === 'oauth_token')?.secret).toBe(true)
    expect(PLATFORM_FIELDS.google.find((f) => f.key === 'developer_token')?.secret).toBe(true)
  })

  test('全ラベルに日本語 + 補助文がある (専門語ゼロ方針)', () => {
    for (const fields of Object.values(PLATFORM_FIELDS)) {
      for (const f of fields) {
        expect(f.label.length).toBeGreaterThan(0)
        expect(f.hint.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('buildConfigForSave — 新規登録 (全欄)', () => {
  test('全必須欄が埋まれば config を作る', () => {
    const r = buildConfigForSave('meta', { pixel_id: '123', access_token: 'tok', test_event_code: '' }, true)
    expect(r).toEqual({ pixel_id: '123', access_token: 'tok' }) // 任意の test_event_code は空なので含めない
  })

  test('任意欄 (test_event_code) が埋まれば含める', () => {
    const r = buildConfigForSave('meta', { pixel_id: '1', access_token: 't', test_event_code: 'TEST1' }, true)
    expect(r).toEqual({ pixel_id: '1', access_token: 't', test_event_code: 'TEST1' })
  })

  test('必須欄が空なら null (保存させない)', () => {
    expect(buildConfigForSave('meta', { pixel_id: '', access_token: 'tok' }, true)).toBeNull()
    expect(buildConfigForSave('meta', { pixel_id: '1', access_token: '' }, true)).toBeNull()
  })

  test('前後空白は trim される', () => {
    const r = buildConfigForSave('meta', { pixel_id: '  1  ', access_token: ' t ' }, true)
    expect(r).toEqual({ pixel_id: '1', access_token: 't' })
  })
})

describe('buildConfigForSave — 編集 (空欄=維持・secret マスク破壊回避)', () => {
  test('全欄空欄なら config は空オブジェクト (何も上書きしない = 今のまま維持)', () => {
    // 編集モーダルは全欄空欄スタート。ユーザーが何も入力しなければ config を送らず既存値維持。
    const r = buildConfigForSave('meta', { pixel_id: '', access_token: '', test_event_code: '' }, false)
    expect(r).toEqual({})
  })

  test('入力があった欄だけ送る (マスク値 abcd****wxyz を送り返さない)', () => {
    // access_token だけ新しい値を入力 → その欄だけ送る。pixel_id は空欄=維持。
    const r = buildConfigForSave('meta', { pixel_id: '', access_token: 'new-real-token', test_event_code: '' }, false)
    expect(r).toEqual({ access_token: 'new-real-token' })
    expect(r).not.toHaveProperty('pixel_id') // 空欄は送らない (維持)
  })

  test('複数欄を変えればその全部を送る', () => {
    const r = buildConfigForSave('google', {
      customer_id: '9999999999', conversion_action_id: '', oauth_token: 'newoauth', developer_token: '',
    }, false)
    expect(r).toEqual({ customer_id: '9999999999', oauth_token: 'newoauth' })
  })
})

describe('platformDisplay / isPlatformName', () => {
  test('displayName があればそれを返す', () => {
    expect(platformDisplay('meta', '本番用')).toBe('本番用')
  })

  test('displayName が空なら platform 日本語ラベル', () => {
    expect(platformDisplay('meta', '')).toBe('Meta（Facebook / Instagram）')
    expect(platformDisplay('google', null)).toBe('Google広告')
  })

  test('未知 platform はキーそのまま', () => {
    expect(platformDisplay('unknown', null)).toBe('unknown')
  })

  test('isPlatformName は validNames のみ true', () => {
    expect(isPlatformName('meta')).toBe(true)
    expect(isPlatformName('line')).toBe(false)
  })
})
