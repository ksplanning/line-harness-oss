// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { HarnessField } from '@line-crm/shared'
import FormBuilder from './builder'

afterEach(() => cleanup())

const LOCK_LABEL = '編集URLからの編集を許可しない'
const LOCK_HELP = 'チェックすると、編集リンクを開いた人には内容が表示されますが、書き換えや添付の追加・削除はできません。管理画面やスプレッドシートからは今までどおり変更できます。'

function field(
  type: HarnessField['type'],
  config: HarnessField['config'] = {},
): HarnessField {
  return {
    id: `field-${type}`,
    type,
    label: `設定対象 ${type}`,
    required: false,
    position: 0,
    config,
  }
}

function base(overrides: Record<string, unknown> = {}) {
  return {
    formTitle: '編集不可テスト',
    status: 'draft' as const,
    initialFields: [field('text')],
    initialLogic: [],
    initialRenderBackend: 'internal' as const,
    onSave: vi.fn(),
    ...overrides,
  }
}

describe('field edit lock — builder setting and round trip', () => {
  test('legacy field starts unlocked, saves the checked flag, and restores it after reload', () => {
    const onSave = vi.fn()
    const first = render(<FormBuilder {...base({ onSave })} />)
    const checkbox = screen.getByLabelText(LOCK_LABEL) as HTMLInputElement

    expect(checkbox.checked).toBe(false)
    expect(screen.getByText(LOCK_HELP)).toBeTruthy()

    fireEvent.click(checkbox)
    fireEvent.click(screen.getByText('保存'))
    const savedFields = (onSave.mock.calls[0][0] as { fields: HarnessField[] }).fields
    expect(savedFields[0].config.editLocked).toBe(true)

    first.unmount()
    render(<FormBuilder {...base({ initialFields: savedFields })} />)
    expect((screen.getByLabelText(LOCK_LABEL) as HTMLInputElement).checked).toBe(true)
  })

  test.each([
    ['file', {}],
    ['matrix', {
      matrixChoiceItems: { good: { title: '良い' } },
      matrixChoiceGroups: [{ title: '接客' }],
    }],
    ['repeating_section', {
      repeatingColumns: [{ columnField: 'name', title: '氏名' }],
      minRows: 1,
      maxRows: 3,
    }],
  ] as const)('%s field exposes the same internal edit-lock setting', (type, config) => {
    render(<FormBuilder {...base({
      initialFields: [field(type, config as HarnessField['config'])],
    })} />)

    expect(screen.getByLabelText(LOCK_LABEL)).toBeTruthy()
  })

  test('Formaloo builder does not expose an internal-edit-only setting', () => {
    render(<FormBuilder {...base({ initialRenderBackend: 'formaloo' })} />)

    expect(screen.queryByLabelText(LOCK_LABEL)).toBeNull()
  })
})
