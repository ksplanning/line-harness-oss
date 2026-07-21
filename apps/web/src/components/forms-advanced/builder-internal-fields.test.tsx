// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { HarnessField } from '@line-crm/shared'
import FormBuilder from './builder'

afterEach(() => cleanup())

function field(
  type: HarnessField['type'],
  label: string,
  config: HarnessField['config'] = {},
): HarnessField {
  return { id: `field-${type}`, type, label, required: false, position: 0, config }
}

function base(overrides: Record<string, unknown> = {}) {
  return {
    formTitle: '自前フォーム',
    status: 'draft' as const,
    initialFields: [] as HarnessField[],
    initialLogic: [],
    initialRenderBackend: 'internal' as const,
    onSave: vi.fn(),
    ...overrides,
  }
}

describe('internal builder palette', () => {
  test('shows datetime, country, and the five Japanese-address parts only for internal delivery', () => {
    const internal = render(<FormBuilder {...base()} />)
    const palette = screen.getByTestId('palette')

    for (const label of ['日時', '国', '郵便番号', '都道府県', '市区町村（日本）', '町名・番地', '建物名・部屋番号']) {
      expect(within(palette).getByLabelText(`${label}を追加`)).toBeTruthy()
    }
    expect(within(palette).queryByLabelText('動的選択肢を追加')).toBeNull()

    internal.unmount()
    render(<FormBuilder {...base({ initialRenderBackend: 'formaloo' })} />)
    const formalooPalette = screen.getByTestId('palette')
    expect(within(formalooPalette).getByLabelText('動的選択肢を追加')).toBeTruthy()
    for (const label of ['日時', '国', '郵便番号', '都道府県', '市区町村（日本）', '町名・番地', '建物名・部屋番号']) {
      expect(within(formalooPalette).queryByLabelText(`${label}を追加`)).toBeNull()
    }
  })
})

describe('internal placeholder and character limits', () => {
  test.each([
    ['text', '1行テキスト'],
    ['textarea', '複数行テキスト'],
  ] as const)('%s keeps placeholder separate from help and persists min/max length', (type, label) => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({
      initialFields: [field(type, label, { description: '補足は別です' })],
      onSave,
    })} />)

    fireEvent.change(screen.getByLabelText('プレースホルダー'), { target: { value: 'ここに入力してください' } })
    fireEvent.change(screen.getByLabelText('最小文字数'), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText('最大文字数'), { target: { value: '40' } })
    fireEvent.click(screen.getByText('保存'))

    const saved = (onSave.mock.calls[0][0] as { fields: HarnessField[] }).fields[0]
    expect(saved.config).toMatchObject({
      description: '補足は別です',
      placeholder: 'ここに入力してください',
      minLength: 3,
      maxLength: 40,
    })
  })

  test.each([
    ['matrix', { matrixChoiceGroups: [{ title: '接客' }], matrixChoiceItems: { good: { title: '良い' } } }],
    ['repeating_section', { repeatingColumns: [{ columnField: 'name', title: '氏名' }], minRows: 1, maxRows: 3 }],
  ] as const)('%s also exposes the common placeholder setting', (type, config) => {
    const fields = type === 'repeating_section'
      ? [field('text', '氏名'), field(type, '参加者', config)]
      : [field(type, '満足度', config)]
    render(<FormBuilder {...base({ initialFields: fields })} />)

    if (type === 'repeating_section') {
      fireEvent.click(within(screen.getByTestId('canvas')).getByText('参加者').closest('button')!)
    }
    expect(screen.getByLabelText('プレースホルダー')).toBeTruthy()
  })

  test('Formaloo retains its existing one-line max-only settings', () => {
    render(<FormBuilder {...base({
      initialRenderBackend: 'formaloo',
      initialFields: [field('text', '名前')],
    })} />)

    expect(screen.queryByLabelText('プレースホルダー')).toBeNull()
    expect(screen.queryByLabelText('最小文字数')).toBeNull()
    expect(screen.getByLabelText('最大文字数')).toBeTruthy()
  })
})

describe('internal default selections', () => {
  test.each([
    ['choice', '単一選択'],
    ['dropdown', 'ドロップダウン'],
  ] as const)('%s saves one explicit default choice', (type, label) => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({
      initialFields: [field(type, label, { choices: ['A', 'B'] })],
      onSave,
    })} />)

    fireEvent.change(screen.getByLabelText('既定選択肢'), { target: { value: 'B' } })
    fireEvent.click(screen.getByText('保存'))

    const saved = (onSave.mock.calls[0][0] as { fields: HarnessField[] }).fields[0]
    expect(saved.config.defaultValue).toBe('B')
  })

  test('multiple select saves every checked default choice', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({
      initialFields: [field('multiple_select', '複数選択', { choices: ['A', 'B', 'C'] })],
      onSave,
    })} />)

    fireEvent.click(screen.getByLabelText('既定選択肢: A'))
    fireEvent.click(screen.getByLabelText('既定選択肢: C'))
    fireEvent.click(screen.getByText('保存'))

    const saved = (onSave.mock.calls[0][0] as { fields: HarnessField[] }).fields[0]
    expect(saved.config.defaultValues).toEqual(['A', 'C'])
  })

  test('renaming or deleting a choice keeps its defaults valid', async () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({
      initialFields: [field('choice', '単一選択', { choices: ['A', 'B'], defaultValue: 'B' })],
      onSave,
    })} />)

    fireEvent.change(screen.getByLabelText('選択肢2'), { target: { value: 'C' } })
    fireEvent.click(screen.getByText('保存'))
    expect((onSave.mock.calls[0][0] as { fields: HarnessField[] }).fields[0].config.defaultValue).toBe('C')
    await waitFor(() => expect(screen.getByText('保存')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('選択肢2を削除'))
    fireEvent.click(screen.getByText('保存'))
    expect((onSave.mock.calls[1][0] as { fields: HarnessField[] }).fields[0].config.defaultValue).toBeUndefined()
  })
})

describe('internal-only editor boundaries', () => {
  test('hides Formaloo sync recovery while keeping internal branching controls', () => {
    render(<FormBuilder {...base({
      initialFields: [field('text', '名前'), { ...field('email', 'メール'), position: 1 }],
      syncStatus: 'out_of_sync',
      syncError: '古い Formaloo エラー',
    })} />)

    expect(screen.queryByTestId('sync-badge')).toBeNull()
    expect(screen.queryByTestId('sync-recovery')).toBeNull()
    expect(screen.getByText('＋ 分岐を追加')).toBeTruthy()
    expect(screen.getByText(/条件分岐（この項目の回答で他項目を出し分け）/)).toBeTruthy()
  })
})
