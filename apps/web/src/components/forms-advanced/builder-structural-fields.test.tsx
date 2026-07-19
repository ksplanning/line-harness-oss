// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { HarnessField } from '@line-crm/shared'

const choiceListsApi = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() }))
vi.mock('@/lib/formaloo-choice-lists-api', () => ({ formalooChoiceListsApi: choiceListsApi }))

import FormBuilder from './builder'

afterEach(() => cleanup())
beforeEach(() => {
  choiceListsApi.list.mockReset().mockResolvedValue([])
  choiceListsApi.create.mockReset()
  choiceListsApi.update.mockReset()
  choiceListsApi.remove.mockReset()
})

function field(type: HarnessField['type'], id: string, label: string, config: HarnessField['config'] = {}): HarnessField {
  return { id, type, label, required: false, position: 0, config }
}

function base(overrides: Record<string, unknown> = {}) {
  return {
    formId: 'form_1', formTitle: '申込', status: 'draft' as const,
    initialFields: [] as HarnessField[], initialLogic: [], onSave: vi.fn(), ...overrides,
  }
}

describe('matrix field builder', () => {
  test('palette 追加時に行と列の最小 editor を作り、保存する', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)

    fireEvent.click(screen.getByLabelText('行列を追加'))
    expect((screen.getByLabelText('行（1行に1項目）') as HTMLTextAreaElement).value).toBe('行1\n行2')
    expect((screen.getByLabelText('列（1行に1項目）') as HTMLTextAreaElement).value).toBe('列1\n列2')
    fireEvent.change(screen.getByLabelText('行（1行に1項目）'), { target: { value: '接客\n速度' } })
    fireEvent.change(screen.getByLabelText('列（1行に1項目）'), { target: { value: '良い\n普通\n悪い' } })
    fireEvent.click(screen.getByText('保存'))

    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields[0]).toMatchObject({
      type: 'matrix',
      config: {
        matrixChoiceGroups: [{ title: '接客' }, { title: '速度' }],
        matrixChoiceItems: {
          column_1: { title: '良い' },
          column_2: { title: '普通' },
          column_3: { title: '悪い' },
        },
      },
    })
  })

  test('pull 済み row/column の slug 等をタイトル編集で失わない', () => {
    const onSave = vi.fn()
    const matrix = field('matrix', 'm', '満足度', {
      matrixChoiceItems: {
        good: { title: '良い', slug: 'GOOD' },
        bad: { title: '悪い', slug: 'BAD' },
      },
      matrixChoiceGroups: [
        { refId: 'REF', slug: 'ROW', title: '接客', jsonKey: 'service' },
        { title: '速度' },
      ],
    })
    render(<FormBuilder {...base({ initialFields: [matrix], onSave })} />)

    fireEvent.change(screen.getByLabelText('行（1行に1項目）'), { target: { value: '応対\n速さ' } })
    fireEvent.change(screen.getByLabelText('列（1行に1項目）'), { target: { value: '満足\n不満' } })
    fireEvent.click(screen.getByText('保存'))
    const config = (onSave.mock.calls[0][0] as { fields: HarnessField[] }).fields[0].config
    expect(config.matrixChoiceGroups).toEqual([
      { refId: 'REF', slug: 'ROW', title: '応対', jsonKey: 'service' },
      { title: '速さ' },
    ])
    expect(config.matrixChoiceItems).toEqual({
      good: { title: '満足', slug: 'GOOD' },
      bad: { title: '不満', slug: 'BAD' },
    })
  })

  test('中間の行と列を削除しても後続の remote identity と raw metadata を付け替えない', () => {
    const onSave = vi.fn()
    const matrix = field('matrix', 'm', '満足度', {
      matrixChoiceItems: {
        a: { title: '列A', slug: 'COL_A' },
        b: { title: '列B', slug: 'COL_B' },
        c: { title: '列C', slug: 'COL_C', provider_extension: { opaque: true } },
      },
      matrixChoiceGroups: [
        { refId: 'REF_A', slug: 'ROW_A', title: '行A', jsonKey: 'row_a' },
        { refId: 'REF_B', slug: 'ROW_B', title: '行B', jsonKey: 'row_b' },
        { refId: 'REF_C', slug: 'ROW_C', title: '行C', jsonKey: 'row_c' },
      ],
    })
    render(<FormBuilder {...base({ initialFields: [matrix], onSave })} />)

    fireEvent.change(screen.getByLabelText('行（1行に1項目）'), { target: { value: '行A\n行C' } })
    fireEvent.change(screen.getByLabelText('列（1行に1項目）'), { target: { value: '列A\n列C' } })
    fireEvent.click(screen.getByText('保存'))

    const config = (onSave.mock.calls[0][0] as { fields: HarnessField[] }).fields[0].config
    expect(config.matrixChoiceGroups).toEqual([
      { refId: 'REF_A', slug: 'ROW_A', title: '行A', jsonKey: 'row_a' },
      { refId: 'REF_C', slug: 'ROW_C', title: '行C', jsonKey: 'row_c' },
    ])
    expect(config.matrixChoiceItems).toEqual({
      a: { title: '列A', slug: 'COL_A' },
      c: { title: '列C', slug: 'COL_C', provider_extension: { opaque: true } },
    })
  })

  test('列名を隣と同じ名前へ変更しても remote identity の並びを入れ替えない', () => {
    const onSave = vi.fn()
    const matrix = field('matrix', 'm', '満足度', {
      matrixChoiceItems: {
        a: { title: '列A', slug: 'COL_A' },
        b: { title: '列B', slug: 'COL_B' },
      },
      matrixChoiceGroups: [{ title: '行' }],
    })
    render(<FormBuilder {...base({ initialFields: [matrix], onSave })} />)

    fireEvent.change(screen.getByLabelText('列（1行に1項目）'), { target: { value: '列B\n列B' } })
    fireEvent.click(screen.getByText('保存'))

    const items = (onSave.mock.calls[0][0] as { fields: HarnessField[] }).fields[0].config.matrixChoiceItems
    expect(Object.keys(items ?? {})).toEqual(['a', 'b'])
    expect(items).toEqual({
      a: { title: '列B', slug: 'COL_A' },
      b: { title: '列B', slug: 'COL_B' },
    })
  })

  test('同名列が複数ある状態で先頭列を削除しても残る identity の順序を保つ', () => {
    const onSave = vi.fn()
    const matrix = field('matrix', 'm', '満足度', {
      matrixChoiceItems: {
        a: { title: '列A', slug: 'COL_A' },
        b1: { title: '列B', slug: 'COL_B1' },
        b2: { title: '列B', slug: 'COL_B2' },
      },
      matrixChoiceGroups: [{ title: '行' }],
    })
    render(<FormBuilder {...base({ initialFields: [matrix], onSave })} />)

    fireEvent.change(screen.getByLabelText('列（1行に1項目）'), { target: { value: '列B\n列B' } })
    fireEvent.click(screen.getByText('保存'))

    const items = (onSave.mock.calls[0][0] as { fields: HarnessField[] }).fields[0].config.matrixChoiceItems
    expect(Object.keys(items ?? {})).toEqual(['b1', 'b2'])
    expect(items).toEqual({
      b1: { title: '列B', slug: 'COL_B1' },
      b2: { title: '列B', slug: 'COL_B2' },
    })
  })

  test('未型付けの choice_items は別の列を編集しても raw のまま保持する', () => {
    const onSave = vi.fn()
    const matrix = field('matrix', 'm', '満足度', {
      matrixChoiceItems: {
        good: { title: '良い', slug: 'GOOD' },
        provider_extension: ['provider', { opaque: true }],
      },
      matrixChoiceGroups: [{ title: '接客' }],
    })
    render(<FormBuilder {...base({ initialFields: [matrix], onSave })} />)

    fireEvent.change(screen.getByLabelText('列（1行に1項目）'), {
      target: { value: '満足\nprovider_extension' },
    })
    fireEvent.click(screen.getByText('保存'))

    const config = (onSave.mock.calls[0][0] as { fields: HarnessField[] }).fields[0].config
    expect(config.matrixChoiceItems).toEqual({
      good: { title: '満足', slug: 'GOOD' },
      provider_extension: ['provider', { opaque: true }],
    })
  })

  test('末尾で Enter を押してから通常入力で行と列を追加できる', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)
    fireEvent.click(screen.getByLabelText('行列を追加'))

    const rows = screen.getByLabelText('行（1行に1項目）') as HTMLTextAreaElement
    fireEvent.change(rows, { target: { value: '行1\n行2\n' } })
    expect(rows.value).toBe('行1\n行2\n')
    fireEvent.change(rows, { target: { value: '行1\n行2\n行3' } })
    expect(rows.value).toBe('行1\n行2\n行3')

    const columns = screen.getByLabelText('列（1行に1項目）') as HTMLTextAreaElement
    fireEvent.change(columns, { target: { value: '列1\n列2\n' } })
    expect(columns.value).toBe('列1\n列2\n')
    fireEvent.change(columns, { target: { value: '列1\n列2\n列3' } })
    expect(columns.value).toBe('列1\n列2\n列3')

    fireEvent.click(screen.getByText('保存'))
    const saved = (onSave.mock.calls[0][0] as { fields: HarnessField[] }).fields[0]
    expect(saved.config.matrixChoiceGroups?.map((row) => row.title)).toEqual(['行1', '行2', '行3'])
    expect(Object.values(saved.config.matrixChoiceItems ?? {}).map((item) => (
      item && typeof item === 'object' && !Array.isArray(item) ? item.title : undefined
    ))).toEqual(['列1', '列2', '列3'])
  })
})

describe('repeating section builder', () => {
  test('pull で未指定の min/max は空欄のまま保持し、数値入力後も空欄へ戻せる', () => {
    const onSave = vi.fn()
    const fields = [
      field('text', 'name', '氏名'),
      field('repeating_section', 'repeat', '参加者', {
        repeatingColumns: [{ columnField: 'name', title: '氏名' }],
      }),
    ]
    render(<FormBuilder {...base({ initialFields: fields, onSave })} />)

    const canvas = screen.getByTestId('canvas')
    fireEvent.click(within(canvas).getByText('参加者').closest('button')!)
    const minRows = screen.getByLabelText('最小行数') as HTMLInputElement
    const maxRows = screen.getByLabelText('最大行数') as HTMLInputElement
    expect(minRows.value).toBe('')
    expect(maxRows.value).toBe('')

    fireEvent.change(minRows, { target: { value: '2' } })
    fireEvent.change(minRows, { target: { value: '' } })
    fireEvent.click(screen.getByText('保存'))

    const saved = (onSave.mock.calls[0][0] as { fields: HarnessField[] }).fields[1]
    expect(saved.config).not.toHaveProperty('minRows')
    expect(saved.config).not.toHaveProperty('maxRows')
  })

  test('min/max と列 field 構成を編集して保存する', () => {
    const onSave = vi.fn()
    const fields = [field('text', 'name', '氏名'), field('email', 'email', 'メール')]
    render(<FormBuilder {...base({ initialFields: fields, onSave })} />)

    fireEvent.click(screen.getByLabelText('繰り返しセクションを追加'))
    expect((screen.getByLabelText('最小行数') as HTMLInputElement).value).toBe('1')
    expect((screen.getByLabelText('最大行数') as HTMLInputElement).value).toBe('5')
    expect((screen.getByLabelText('繰り返し列1の項目') as HTMLSelectElement).value).toBe('name')
    fireEvent.change(screen.getByLabelText('最大行数'), { target: { value: '8' } })
    fireEvent.click(screen.getByRole('button', { name: '列を追加' }))
    fireEvent.change(screen.getByLabelText('繰り返し列2の項目'), { target: { value: 'email' } })
    fireEvent.change(screen.getByLabelText('繰り返し列2の見出し'), { target: { value: '連絡先' } })
    fireEvent.click(screen.getByText('保存'))

    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields.at(-1)).toMatchObject({
      type: 'repeating_section',
      config: {
        minRows: 1,
        maxRows: 8,
        repeatingColumns: [
          { columnField: 'name', title: '氏名' },
          { columnField: 'email', title: '連絡先' },
        ],
      },
    })
  })

  test('構造 field 自身は列候補に出さない', () => {
    render(<FormBuilder {...base({ initialFields: [
      field('text', 'name', '氏名'),
      field('matrix', 'matrix', '行列', {
        matrixChoiceItems: { c: { title: '列' } }, matrixChoiceGroups: [{ title: '行' }],
      }),
      field('repeating_section', 'repeat', '参加者', {
        repeatingColumns: [{ columnField: 'name', title: '氏名' }], minRows: 1, maxRows: 2,
      }),
    ] })} />)
    const canvas = screen.getByTestId('canvas')
    fireEvent.click(within(canvas).getByText('参加者').closest('button')!)
    const values = Array.from((screen.getByLabelText('繰り返し列1の項目') as HTMLSelectElement).options).map((option) => option.value)
    expect(values).toEqual(['name'])
  })

  test('繰り返し列から参照中の通常項目は削除させない', () => {
    const fields = [
      field('text', 'name', '氏名'),
      field('repeating_section', 'repeat', '参加者', {
        repeatingColumns: [{ columnField: 'name', title: '氏名' }], minRows: 1, maxRows: 2,
      }),
    ]
    render(<FormBuilder {...base({ initialFields: fields })} />)

    const canvas = screen.getByTestId('canvas')
    fireEvent.click(within(canvas).getAllByLabelText('削除')[0])
    fireEvent.click(within(canvas).getByText('はい'))

    expect(within(canvas).getByText('氏名')).toBeTruthy()
    expect(screen.getByTestId('drop-feedback').textContent).toMatch(/参加者.*繰り返し列.*削除できません/)
  })
})
