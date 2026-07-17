// @vitest-environment jsdom
/**
 * b1-field-polish (T-D1 / T-D2) — builder の per-field 動画サイズ select + form-level 星色 picker。
 *   T-D1 video SettingsPanel に「表示サイズ」select (小/中/大)・変更が config.videoHeight に反映・URL 入力は不変。
 *   T-D2 rating field 有フォームで design region に「評価スターの色」picker・選択が design.ratingStarColor に反映。
 *   form-settings region (弾 form-jp-localization 域) は不可触 (D-1 は git diff で別途 assert)。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import FormBuilder from './builder'
import { VIDEO_SIZE_PRESETS } from './field-types'
import { DEFAULT_RATING_STAR_COLOR } from '@line-crm/shared'
import type { HarnessField, FormDesign } from '@line-crm/shared'

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

describe('b1-field-polish T-D1 — builder video 表示サイズ select', () => {
  it('video 選択時に「表示サイズ」select が出て、変更が config.videoHeight に反映', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ initialFields: [fld('video', { videoUrl: 'https://youtu.be/x' })], onSave })} />)
    const select = screen.getByLabelText('表示サイズ') as HTMLSelectElement
    expect(select).toBeTruthy()
    const big = VIDEO_SIZE_PRESETS[VIDEO_SIZE_PRESETS.length - 1].value // 大
    fireEvent.change(select, { target: { value: big } })
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields[0].config.videoHeight).toBe(big)
  })

  it('未選択 (既定) の video は config.videoHeight が未設定', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ initialFields: [fld('video', { videoUrl: 'https://youtu.be/x' })], onSave })} />)
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields[0].config.videoHeight).toBeUndefined()
  })

  it('preset から「（既定）」(空) に戻すと config.videoHeight が未設定に戻る', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ initialFields: [fld('video', { videoUrl: 'https://youtu.be/x', videoHeight: '400px' })], onSave })} />)
    const select = screen.getByLabelText('表示サイズ') as HTMLSelectElement
    expect(select.value).toBe('400px')
    fireEvent.change(select, { target: { value: '' } })
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields[0].config.videoHeight).toBeUndefined()
  })

  it('URL 入力は不変 (共存)', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ initialFields: [fld('video', { videoUrl: '' })], onSave })} />)
    fireEvent.change(screen.getByLabelText('動画URL'), { target: { value: 'https://youtu.be/abc' } })
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields[0].config.videoUrl).toBe('https://youtu.be/abc')
  })
})

describe('b1-field-polish T-D2 — builder 星色 picker (form-level)', () => {
  it('rating field 有フォームで「評価スターの色」picker が出て、選択が design.ratingStarColor に反映', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ initialFields: [fld('rating')], onSave })} />)
    const blue = screen.getByLabelText('スター色 青')
    expect(blue).toBeTruthy()
    fireEvent.click(blue)
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { design?: FormDesign }
    expect(saved.design?.ratingStarColor).toBe('#3B82F6')
  })

  it('rating field 無しフォームでは星色 picker を出さない', () => {
    render(<FormBuilder {...base({ initialFields: [fld('text')] })} />)
    expect(screen.queryByLabelText('スター色 青')).toBeNull()
  })

  it('未設定時は既定黄が選択状態 (aria-pressed)', () => {
    render(<FormBuilder {...base({ initialFields: [fld('rating')] })} />)
    const yellow = screen.getByLabelText('スター色 黄')
    expect(yellow.getAttribute('aria-pressed')).toBe('true')
    expect(DEFAULT_RATING_STAR_COLOR).toBe('#F5B301')
  })
})
