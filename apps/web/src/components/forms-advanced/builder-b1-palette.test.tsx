// @vitest-environment jsdom
/**
 * treasure-b1-palette (T-F1/T-F2/T-F3) — ビルダー palette + per-field 設定パネル region のみ。
 *   T-F1 palette に rating/signature/video が該当カテゴリで出る
 *   T-F2 SettingsPanel: rating→評価スタイル picker / video→URL 入力・変更が config に反映
 *   T-F3 新規追加の既定 config: video={videoUrl:''} / rating={}(sub_type 未設定=star)
 * form-settings region (後編集を許可しない トグル) は本テスト対象外 (弾L 域・不可触)。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import FormBuilder from './builder'
import type { HarnessField } from '@line-crm/shared'

afterEach(() => cleanup())

function base(overrides = {}) {
  return {
    formTitle: 'テスト',
    status: 'draft' as const,
    initialFields: [] as HarnessField[],
    initialLogic: [],
    onSave: vi.fn(),
    ...overrides,
  }
}
function fld(type: HarnessField['type'], config: Record<string, unknown> = {}, over: Partial<HarnessField> = {}): HarnessField {
  return { id: `${type}1`, type, label: type, required: false, position: 0, config: config as HarnessField['config'], ...over }
}

describe('B1 builder — palette 3 型 (T-F1)', () => {
  it('パレットに rating/signature/video の追加ボタンが出る', () => {
    render(<FormBuilder {...base()} />)
    expect(screen.getByLabelText('評価を追加')).toBeTruthy()
    expect(screen.getByLabelText('署名を追加')).toBeTruthy()
    expect(screen.getByLabelText('動画を追加')).toBeTruthy()
  })
})

describe('B1 builder — SettingsPanel rating picker (T-F2)', () => {
  it('rating 選択時に評価スタイル picker が出て、変更が config.ratingSubType に反映', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ initialFields: [fld('rating')], onSave })} />)
    const picker = screen.getByLabelText('評価スタイル') as HTMLSelectElement
    expect(picker).toBeTruthy()
    fireEvent.change(picker, { target: { value: 'nps' } })
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields[0].config.ratingSubType).toBe('nps')
  })
  it('評価スタイルを星に戻すと config.ratingSubType は未設定 (star drop)', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ initialFields: [fld('rating', { ratingSubType: 'nps' })], onSave })} />)
    fireEvent.change(screen.getByLabelText('評価スタイル'), { target: { value: 'star' } })
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields[0].config.ratingSubType).toBeUndefined()
  })
})

describe('B1 builder — SettingsPanel video URL (T-F2)', () => {
  it('video 選択時に URL 入力が出て、変更が config.videoUrl に反映', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ initialFields: [fld('video', { videoUrl: '' })], onSave })} />)
    const input = screen.getByLabelText('動画URL') as HTMLInputElement
    expect(input).toBeTruthy()
    fireEvent.change(input, { target: { value: 'https://youtu.be/abc' } })
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields[0].config.videoUrl).toBe('https://youtu.be/abc')
  })
})

describe('B1 builder — 新規追加の既定 config (T-F3)', () => {
  it('video を追加すると config.videoUrl="" になる', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)
    fireEvent.click(screen.getByLabelText('動画を追加'))
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields[0].type).toBe('video')
    expect(saved.fields[0].config.videoUrl).toBe('')
  })
  it('rating を追加すると sub_type 未設定 (config に ratingSubType 無し=既定 star)', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)
    fireEvent.click(screen.getByLabelText('評価を追加'))
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields[0].type).toBe('rating')
    expect('ratingSubType' in saved.fields[0].config).toBe(false)
  })
})
