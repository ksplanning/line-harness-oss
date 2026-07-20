// @vitest-environment jsdom
/**
 * treasure-e1-field-parts (D-4) — live hosted 表示まで確認できた入力型を
 * 共通設定・プレビューへ公開する。city は既存 field の後方互換のみ維持する。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { HarnessField } from '@line-crm/shared'
import FormBuilder from './builder'
import FormPreview from './form-preview'
import { FIELD_TYPE_META, fieldTypeLabel } from './field-types'

afterEach(() => cleanup())

const ADOPTED_FIELDS = [
  {
    type: 'yes_no',
    label: 'はい/いいえ',
    summary: '「はい」か「いいえ」で答えてもらえます。',
    category: '選択',
  },
  {
    type: 'time',
    label: '時刻',
    summary: '時刻だけを入力してもらえます。',
    category: '入力',
  },
  {
    type: 'website',
    label: 'URL',
    summary: 'ホームページなどのURL（ページの住所）を入力してもらえます。',
    category: '入力',
  },
] as const

function base(overrides: Record<string, unknown> = {}) {
  return {
    formTitle: 'E1確認フォーム',
    status: 'draft' as const,
    initialFields: [] as HarnessField[],
    initialLogic: [],
    onSave: vi.fn(),
    ...overrides,
  }
}

function field(type: string, label: string): HarnessField {
  return {
    id: `field-${type}`,
    type: type as HarnessField['type'],
    label,
    required: false,
    position: 0,
    config: {},
  }
}

describe('E1 field parts — パレット公開範囲', () => {
  it('新規追加できる3型に日本語ラベルと日常語の説明を持たせる', () => {
    const byType = Object.fromEntries(FIELD_TYPE_META.map((meta) => [String(meta.type), meta]))

    for (const expected of ADOPTED_FIELDS) {
      expect(byType[expected.type]).toMatchObject({
        label: expected.label,
        category: expected.category,
      })
      expect(byType[expected.type].help.summary).toBe(expected.summary)
      expect(fieldTypeLabel(expected.type as HarnessField['type'])).toBe(expected.label)
    }
  })

  it('パレットに3型の追加ボタンと非エンジニア向け説明を表示する', () => {
    render(<FormBuilder {...base()} />)
    const palette = screen.getByTestId('palette')

    for (const expected of ADOPTED_FIELDS) {
      expect(within(palette).getByLabelText(`${expected.label}を追加`)).toBeTruthy()
      expect(within(palette).getByText(expected.summary)).toBeTruthy()
    }
    expect(within(palette).queryByLabelText('市区町村を追加')).toBeNull()
  })

  it('日時(datetime)・国(country)は Formaloo パレットに出さず、自前配信専用メタとして持つ', () => {
    render(<FormBuilder {...base()} />)
    const palette = screen.getByTestId('palette')
    const byType = Object.fromEntries(FIELD_TYPE_META.map((meta) => [String(meta.type), meta]))

    expect(byType.datetime).toMatchObject({ label: '日時', internalOnly: true })
    expect(byType.country).toMatchObject({ label: '国', internalOnly: true })
    expect(within(palette).queryByLabelText('日時を追加')).toBeNull()
    expect(within(palette).queryByLabelText('国を追加')).toBeNull()
  })
})

describe('E1 field parts — 共通属性編集', () => {
  it.each(ADOPTED_FIELDS)('$label はラベル・必須・補足説明を編集して保存できる', (expected) => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)

    fireEvent.click(screen.getByLabelText(`${expected.label}を追加`))
    expect((screen.getByLabelText('ラベル') as HTMLInputElement).value).toBe(expected.label)
    fireEvent.change(screen.getByLabelText('ラベル'), { target: { value: `${expected.label}（確認）` } })
    fireEvent.click(screen.getByLabelText('必須'))
    fireEvent.change(screen.getByLabelText('補足説明'), { target: { value: `${expected.label}を入力してください` } })
    fireEvent.click(screen.getByText('保存'))

    const saved = (onSave.mock.calls[0][0] as { fields: HarnessField[] }).fields[0]
    expect(saved).toMatchObject({
      type: expected.type,
      label: `${expected.label}（確認）`,
      required: true,
      config: { description: `${expected.label}を入力してください` },
    })
  })
})

describe('E1 field parts — 入力プレビュー', () => {
  it('はい/いいえを2択のラジオ入力として操作できる', () => {
    render(<FormPreview title="確認" fields={[field('yes_no', '参加しますか')]} />)
    const group = screen.getByRole('group', { name: '参加しますか' })
    const yes = within(group).getByLabelText('はい') as HTMLInputElement
    const no = within(group).getByLabelText('いいえ') as HTMLInputElement

    expect(within(group).getAllByRole('radio')).toHaveLength(2)
    fireEvent.click(yes)
    expect(yes.checked).toBe(true)
    expect(no.checked).toBe(false)
  })

  it.each([
    ['time', '希望時刻', 'time', '09:30'],
    ['website', 'ホームページ', 'url', 'https://example.com'],
    ['city', 'お住まいの市区町村', 'text', '千代田区'],
  ] as const)('%s を適切なHTML入力として操作できる', (type, label, htmlType, value) => {
    render(<FormPreview title="確認" fields={[field(type, label)]} />)
    const input = screen.getByLabelText(label) as HTMLInputElement

    expect(input.type).toBe(htmlType)
    fireEvent.change(input, { target: { value } })
    expect(input.value).toBe(value)
  })
})
