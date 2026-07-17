// @vitest-environment jsdom
/**
 * form-image-decoration (T-B2) — builder palette + 差し込み画像 設定パネル region のみ。
 *   palette に「画像」追加ボタン / newField('image') 既定 config={imageWidth:'medium'} /
 *   SettingsPanel: ImageFieldPanel (URL・幅) の変更が config に反映。
 * form-settings 文言/confirm/serializeForm region は不可触 (並走 form-copy-sync-warning-fix 域)。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import FormBuilder from './builder'
import type { HarnessField } from '@line-crm/shared'

afterEach(() => cleanup())

const base = (overrides = {}) => ({
  formTitle: 'テスト',
  status: 'draft' as const,
  initialFields: [] as HarnessField[],
  initialLogic: [],
  onSave: vi.fn(),
  ...overrides,
})
const fld = (type: HarnessField['type'], config: Record<string, unknown> = {}): HarnessField =>
  ({ id: `${type}1`, type, label: type, required: false, position: 0, config: config as HarnessField['config'] })

describe('T-B2 builder — 差し込み画像 palette', () => {
  it('パレットに「画像を追加」ボタンが出る', () => {
    render(<FormBuilder {...base()} />)
    expect(screen.getByLabelText('画像を追加')).toBeTruthy()
  })

  it('画像を追加すると type=image・config.imageWidth="medium"', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)
    fireEvent.click(screen.getByLabelText('画像を追加'))
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields[0].type).toBe('image')
    expect(saved.fields[0].config.imageWidth).toBe('medium')
  })
})

describe('T-B2 builder — ImageFieldPanel 反映', () => {
  it('image 選択時に画像URL入力が出て config.imageUrl に反映', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ initialFields: [fld('image', { imageWidth: 'medium' })], onSave })} />)
    fireEvent.change(screen.getByLabelText('画像URL'), { target: { value: 'https://cdn.test/a.png' } })
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields[0].config.imageUrl).toBe('https://cdn.test/a.png')
  })

  it('表示幅を全幅にすると config.imageWidth="full"', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ initialFields: [fld('image', { imageWidth: 'medium' })], onSave })} />)
    fireEvent.click(screen.getByRole('button', { name: '全幅（100%）' }))
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields[0].config.imageWidth).toBe('full')
  })
})
