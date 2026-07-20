// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { HarnessField } from '@line-crm/shared'
import FormBuilder from './builder'

const INITIAL_VIEWPORT_WIDTH = window.innerWidth

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'innerWidth', { value: INITIAL_VIEWPORT_WIDTH, configurable: true })
})

function base(overrides: Record<string, unknown> = {}) {
  return {
    formTitle: 'パーツ説明確認',
    status: 'draft' as const,
    initialFields: [] as HarnessField[],
    initialLogic: [],
    onSave: vi.fn(),
    ...overrides,
  }
}

function field(type: HarnessField['type'], label: string, config: HarnessField['config'] = {}): HarnessField {
  return {
    id: `field-${type}`,
    type,
    label,
    required: false,
    position: 0,
    config,
  }
}

describe('builder parts help — city 後方互換', () => {
  it('city は新規追加できないが、既存 city field は表示・編集・保存できる', () => {
    const existingCity = field('city', '既存の市区町村', { description: '以前からある補足' })
    const onSave = vi.fn()

    render(<FormBuilder {...base({ initialFields: [existingCity], onSave })} />)

    expect(within(screen.getByTestId('palette')).queryByLabelText('市区町村を追加')).toBeNull()
    expect(within(screen.getByTestId('canvas')).getByText('既存の市区町村')).toBeTruthy()
    expect((screen.getByLabelText('ラベル') as HTMLInputElement).value).toBe('既存の市区町村')
    expect((screen.getByLabelText('補足説明') as HTMLTextAreaElement).value).toBe('以前からある補足')

    fireEvent.change(screen.getByLabelText('ラベル'), { target: { value: 'お住まいの市区町村' } })
    fireEvent.click(screen.getByText('保存'))

    expect(onSave.mock.calls[0][0].fields[0]).toEqual({
      ...existingCity,
      label: 'お住まいの市区町村',
    })
  })

  it('再取り込みで戻った既存 city field を欠落・書き換えなく保存できる', async () => {
    const pulledCity = field('city', '取り込み済みの市区町村', {
      description: '以前からある説明',
      maxLength: 42,
    })
    pulledCity.required = true
    const onSave = vi.fn()
    const onReimport = vi.fn().mockResolvedValue({
      ok: true,
      fields: [pulledCity],
      logic: [],
      note: '取り込み完了',
    })

    render(<FormBuilder {...base({ onSave, onReimport })} />)

    fireEvent.click(screen.getByText('Formaloo から再取り込み'))
    fireEvent.click(within(screen.getByTestId('reimport-confirm')).getByText('はい'))
    expect(await within(screen.getByTestId('canvas')).findByText('取り込み済みの市区町村')).toBeTruthy()
    expect(within(screen.getByTestId('palette')).queryByLabelText('市区町村を追加')).toBeNull()

    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][0].fields).toEqual([pulledCity])
  })
})

describe('builder parts help — パレットの説明ポップオーバー', () => {
  it('「?」をタップすると3層説明が開き、閉じるボタンで閉じられる', () => {
    render(<FormBuilder {...base()} />)
    const trigger = screen.getByRole('button', { name: '1行テキストの説明を見る' })

    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(trigger.className).toContain('min-h-[32px]')
    expect(screen.queryByRole('dialog', { name: '1行テキストの説明' })).toBeNull()
    expect(within(screen.getByTestId('palette')).getAllByRole('button', { name: /の説明を見る$/ })).toHaveLength(23)

    fireEvent.mouseEnter(trigger)
    expect(screen.queryByRole('dialog', { name: '1行テキストの説明' })).toBeNull()

    fireEvent.click(trigger)

    const dialog = screen.getByRole('dialog', { name: '1行テキストの説明' })
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(within(dialog).getByText('機能')).toBeTruthy()
    expect(within(dialog).getByText('使い方')).toBeTruthy()
    expect(within(dialog).getByText('使用例')).toBeTruthy()
    expect(dialog.textContent).toContain('短い文章を1行で入力')
    expect(dialog.className).toContain('max-w-[calc(100vw-2rem)]')

    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }))
    expect(screen.queryByRole('dialog', { name: '1行テキストの説明' })).toBeNull()
  })

  it('説明を開いてもパーツは追加されない', () => {
    render(<FormBuilder {...base()} />)

    fireEvent.click(screen.getByRole('button', { name: '数値の説明を見る' }))

    expect(screen.getByRole('dialog', { name: '数値の説明' })).toBeTruthy()
    expect(within(screen.getByTestId('canvas')).getByText(/左のパレットから/)).toBeTruthy()
    expect(within(screen.getByTestId('settings')).getByText('項目を選ぶと設定が表示されます')).toBeTruthy()
  })

  it('375px 幅では中央寄りの「?」から開いても画面の左右へはみ出さない配置になる', () => {
    Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true })
    const { container } = render(<FormBuilder {...base()} />)
    const trigger = screen.getByRole('button', { name: '1行テキストの説明を見る' })
    const root = trigger.parentElement as HTMLElement
    root.getBoundingClientRect = () => ({
      left: 160,
      right: 192,
      top: 100,
      bottom: 132,
      width: 32,
      height: 32,
      x: 160,
      y: 100,
      toJSON: () => ({}),
    }) as DOMRect

    fireEvent.click(trigger)

    const dialog = within(container).getByRole('dialog', { name: '1行テキストの説明' })
    expect(dialog.className).toContain('fixed')
    expect(dialog.className).toContain('inset-x-4')
  })
})

describe('builder parts help — 高度パーツの使い方ガイド', () => {
  it.each([
    ['file', 'ファイル添付'],
    ['variable', '計算'],
    ['matrix', '行列'],
    ['repeating_section', '繰り返しセクション'],
    ['signature', '署名'],
  ] as const)('%s を選ぶと設定欄に3層の使い方ガイドが出る', (type, label) => {
    render(<FormBuilder {...base({ initialFields: [field(type, label)] })} />)

    const guide = screen.getByRole('region', { name: `${label}の使い方ガイド` })
    expect(within(guide).getByText('機能')).toBeTruthy()
    expect(within(guide).getByText('使い方')).toBeTruthy()
    expect(within(guide).getByText('使用例')).toBeTruthy()
  })

  it('通常の入力パーツには高度パーツ用ガイドを出さない', () => {
    render(<FormBuilder {...base({ initialFields: [field('text', 'お名前')] })} />)

    expect(screen.queryByRole('region', { name: /使い方ガイド/ })).toBeNull()
  })
})
