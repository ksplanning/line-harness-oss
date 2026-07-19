// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { HarnessField } from '@line-crm/shared'
import FormPreview from './form-preview'

afterEach(() => cleanup())

function field(type: HarnessField['type'], id: string, label: string, config: HarnessField['config']): HarnessField {
  return { id, type, label, required: false, position: 0, config }
}

describe('dynamic field preview fidelity', () => {
  test('variable は偽の計算をせず、公開フォームで計算される placeholder を出す', () => {
    render(<FormPreview title="見積り" fields={[
      field('variable', 'total', '合計', { variableSubType: 'formula', formula: '{price}*{quantity}' }),
    ]} />)

    expect(screen.getByTestId('preview-variable').textContent).toMatch(/計算結果|自動計算/)
    expect(screen.getByTestId('preview-variable-note').textContent).toMatch(/公開フォーム/)
  })

  test('choice_fetch は保存中の実値を value 付き option で描画し、公開時の再取得を注記する', () => {
    render(<FormPreview title="予約" fields={[
      field('choice_fetch', 'store', '店舗', {
        choicesSource: 'https://worker.test/formaloo/choices/form/list',
        choiceFetchItems: [
          { label: '渋谷店', value: 'shibuya' },
          { label: '新宿店', value: 'shinjuku' },
        ],
      }),
    ]} />)

    const select = screen.getByLabelText('店舗') as HTMLSelectElement
    expect(Array.from(select.options).map((option) => [option.text, option.value])).toEqual([
      ['渋谷店', 'shibuya'],
      ['新宿店', 'shinjuku'],
    ])
    expect(screen.getByTestId('preview-choice-fetch-note').textContent).toMatch(/供給URL|公開フォーム/)
  })
})
