// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import FormBuilder from './builder'

afterEach(() => cleanup())

function base(overrides = {}) {
  return {
    formTitle: '分岐フォーム',
    status: 'draft' as const,
    initialFields: [],
    initialLogic: [],
    initialRenderBackend: 'internal' as const,
    onSave: vi.fn(),
    ...overrides,
  }
}

describe('edit-branch-editability — builder toggle (D-1/D-4)', () => {
  it('internal form では既定 OFF かつ回答後編集 OFF の間は無効', () => {
    render(<FormBuilder {...base()} />)
    const branch = screen.getByLabelText('編集時に分岐項目の変更を許可する') as HTMLInputElement
    expect(branch.checked).toBe(false)
    expect(branch.disabled).toBe(true)
    expect(branch.dataset.settingId).toBe('allow-branch-edit')
  })

  it('回答後編集と分岐編集を許可すると 1/1 を保存する', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)
    fireEvent.click(screen.getByLabelText('回答後の編集を許可する'))
    const branch = screen.getByLabelText('編集時に分岐項目の変更を許可する') as HTMLInputElement
    expect(branch.disabled).toBe(false)
    fireEvent.click(branch)
    fireEvent.click(screen.getByText('保存'))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      allowPostEdit: 1,
      allowBranchEdit: 1,
    }))
  })

  it('保存値 1 を復元し、Formaloo backend には未対応トグルを表示しない', () => {
    const { unmount } = render(<FormBuilder {...base({ initialAllowPostEdit: 1, initialAllowBranchEdit: 1 })} />)
    expect((screen.getByLabelText('編集時に分岐項目の変更を許可する') as HTMLInputElement).checked).toBe(true)

    unmount()
    render(<FormBuilder {...base({ initialRenderBackend: 'formaloo', initialAllowPostEdit: 1, initialAllowBranchEdit: 1 })} />)
    expect(screen.queryByLabelText('編集時に分岐項目の変更を許可する')).toBeNull()
  })
})
