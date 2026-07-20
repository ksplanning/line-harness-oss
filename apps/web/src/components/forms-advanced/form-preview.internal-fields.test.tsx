// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { HarnessField } from '@line-crm/shared'
import FormPreview from './form-preview'

afterEach(() => cleanup())

function field(
  type: HarnessField['type'],
  label: string,
  config: HarnessField['config'] = {},
): HarnessField {
  return { id: `field-${type}`, type, label, required: false, position: 0, config }
}

describe('internal preview input freedoms', () => {
  test.each([
    ['text', '1行'],
    ['textarea', '複数行'],
  ] as const)('%s renders the configured placeholder and a live Unicode-aware remaining counter', (type, label) => {
    render(<FormPreview
      title="確認"
      renderBackend="internal"
      fields={[field(type, label, { placeholder: '自由に入力', minLength: 2, maxLength: 5 })]}
    />)

    const input = screen.getByLabelText(label) as HTMLInputElement | HTMLTextAreaElement
    expect(input.placeholder).toBe('自由に入力')
    expect(input.minLength).toBe(2)
    expect(input.maxLength).toBe(5)
    fireEvent.change(input, { target: { value: '😀あ' } })
    expect(screen.getByTestId('preview-char-counter').textContent).toContain('残り 3 文字')
  })

  test('renders configured defaults for single, dropdown, and multiple selections', () => {
    render(<FormPreview
      title="確認"
      renderBackend="internal"
      fields={[
        field('choice', 'ひとつ', { choices: ['A', 'B'], defaultValue: 'B' }),
        field('dropdown', '一覧', { choices: ['A', 'B'], defaultValue: 'B', placeholder: '選んでください' }),
        field('multiple_select', '複数', { choices: ['A', 'B'], defaultValues: ['A'] }),
      ]}
    />)

    expect((screen.getByLabelText('ひとつ: B') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('一覧') as HTMLSelectElement).value).toBe('B')
    expect((screen.getByLabelText('複数: A') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('複数: B') as HTMLInputElement).checked).toBe(false)
  })

  test('updates displayed defaults while the builder stays mounted', () => {
    const { rerender } = render(<FormPreview
      title="確認"
      renderBackend="internal"
      fields={[
        field('choice', 'ひとつ', { choices: ['A', 'B'], defaultValue: 'A' }),
        field('multiple_select', '複数', { choices: ['A', 'B'], defaultValues: ['A'] }),
      ]}
    />)

    rerender(<FormPreview
      title="確認"
      renderBackend="internal"
      fields={[
        field('choice', 'ひとつ', { choices: ['A', 'B'], defaultValue: 'B' }),
        field('multiple_select', '複数', { choices: ['A', 'B'], defaultValues: ['B'] }),
      ]}
    />)

    expect((screen.getByLabelText('ひとつ: B') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('複数: A') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByLabelText('複数: B') as HTMLInputElement).checked).toBe(true)
  })

  test.each([
    ['datetime', 'datetime-local'],
    ['country', 'text'],
    ['postal_code', 'text'],
    ['prefecture', 'text'],
    ['address_city', 'text'],
    ['address_street', 'text'],
    ['address_building', 'text'],
  ] as const)('%s has an operable internal preview control', (type, htmlType) => {
    render(<FormPreview title="確認" renderBackend="internal" fields={[field(type, `項目-${type}`)]} />)
    expect((screen.getByLabelText(`項目-${type}`) as HTMLInputElement).type).toBe(htmlType)
  })
})
