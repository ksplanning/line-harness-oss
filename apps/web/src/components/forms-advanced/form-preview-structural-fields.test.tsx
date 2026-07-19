// @vitest-environment jsdom
import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { HarnessField } from '@line-crm/shared'
import FormPreview from './form-preview'

afterEach(() => cleanup())

function field(type: HarnessField['type'], id: string, label: string, config: HarnessField['config']): HarnessField {
  return { id, type, label, required: false, position: 0, config }
}

describe('structural field preview fidelity', () => {
  test('matrix は行見出し×列見出しの表を描き、hosted 差を注記する', () => {
    render(<FormPreview title="満足度" fields={[field('matrix', 'm', '評価', {
      matrixChoiceItems: { good: { title: '良い' }, normal: { title: '普通' } },
      matrixChoiceGroups: [{ title: '接客' }, { title: '速度' }],
    })]} />)

    expect(screen.getByRole('columnheader', { name: '良い' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: '普通' })).toBeTruthy()
    expect(screen.getByRole('rowheader', { name: '接客' })).toBeTruthy()
    expect(screen.getByRole('rowheader', { name: '速度' })).toBeTruthy()
    expect(screen.getByTestId('preview-matrix-note').textContent).toMatch(/公開フォーム|Formaloo/)
  })

  test('repeating_section は列見出しと代表行を描き、複数行入力は hosted と注記する', () => {
    render(<FormPreview title="申込" fields={[field('repeating_section', 'r', '参加者', {
      repeatingColumns: [
        { columnField: 'name', title: '氏名' },
        { columnField: 'email', title: 'メール' },
      ],
      minRows: 1,
      maxRows: 5,
    })]} />)

    expect(screen.getByRole('columnheader', { name: '氏名' })).toBeTruthy()
    expect(screen.getByRole('columnheader', { name: 'メール' })).toBeTruthy()
    expect(screen.getAllByRole('textbox')).toHaveLength(2)
    expect(screen.getByTestId('preview-repeating-note').textContent).toMatch(/1.*5|公開フォーム/)
  })
})
