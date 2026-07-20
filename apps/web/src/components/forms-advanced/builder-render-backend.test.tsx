// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import FormBuilder from './builder'
import type { HarnessField } from '@line-crm/shared'

afterEach(() => cleanup())

function base(overrides: Record<string, unknown> = {}) {
  return {
    formTitle: 'テスト',
    status: 'draft' as const,
    initialFields: [] as HarnessField[],
    initialLogic: [],
    onSave: vi.fn(),
    ...overrides,
  }
}

describe('FormBuilder — 配信方式', () => {
  it('defaults to Formaloo and shows the exact beta label', () => {
    render(<FormBuilder {...base()} />)
    const select = screen.getByLabelText('配信方式') as HTMLSelectElement
    expect(select.value).toBe('formaloo')
    expect(screen.getByRole('option', { name: '自前配信 (β)' })).toBeTruthy()
  })

  it('restores an internal initial value', () => {
    render(<FormBuilder {...base({ initialRenderBackend: 'internal' })} />)
    expect((screen.getByLabelText('配信方式') as HTMLSelectElement).value).toBe('internal')
  })

  it('persists a change through the dedicated callback, not the definition save payload', async () => {
    const onRenderBackendChange = vi.fn().mockResolvedValue(undefined)
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave, onRenderBackendChange })} />)

    fireEvent.change(screen.getByLabelText('配信方式'), { target: { value: 'internal' } })
    await waitFor(() => expect(onRenderBackendChange).toHaveBeenCalledWith('internal'))
    fireEvent.click(screen.getByText('保存'))

    const saved = onSave.mock.calls[0][0] as Record<string, unknown>
    expect('renderBackend' in saved).toBe(false)
  })

  it('rolls back the selector and shows an honest error when PATCH fails', async () => {
    const onRenderBackendChange = vi.fn().mockRejectedValue(new Error('failed'))
    render(<FormBuilder {...base({ onRenderBackendChange })} />)

    fireEvent.change(screen.getByLabelText('配信方式'), { target: { value: 'internal' } })

    await waitFor(() => expect((screen.getByLabelText('配信方式') as HTMLSelectElement).value).toBe('formaloo'))
    expect(screen.getByRole('alert').textContent).toContain('配信方式の変更に失敗しました')
  })
})
