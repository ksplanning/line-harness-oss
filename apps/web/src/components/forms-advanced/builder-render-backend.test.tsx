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
    await waitFor(() => expect((screen.getByLabelText('配信方式') as HTMLSelectElement).value).toBe('internal'))
    fireEvent.click(screen.getByText('保存'))

    const saved = onSave.mock.calls[0][0] as Record<string, unknown>
    expect('renderBackend' in saved).toBe(false)
  })

  it('rolls back the selector and shows an honest error when PATCH fails', async () => {
    const onRenderBackendChange = vi.fn().mockRejectedValue({ body: { error: 'この項目があるため切り替えられません' } })
    render(<FormBuilder {...base({ onRenderBackendChange })} />)

    fireEvent.change(screen.getByLabelText('配信方式'), { target: { value: 'internal' } })

    await waitFor(() => expect((screen.getByLabelText('配信方式') as HTMLSelectElement).value).toBe('formaloo'))
    expect(screen.getByRole('alert').textContent).toContain('この項目があるため切り替えられません')
  })

  it('adopts the authoritative provider returned after a concurrent switch', async () => {
    const onRenderBackendChange = vi.fn().mockResolvedValue('formaloo')
    render(<FormBuilder {...base({
      onRenderBackendChange,
    })} />)

    fireEvent.change(screen.getByLabelText('配信方式'), { target: { value: 'internal' } })

    await waitFor(() => expect(onRenderBackendChange).toHaveBeenCalledWith('internal'))
    expect((screen.getByLabelText('配信方式') as HTMLSelectElement).value).toBe('formaloo')
  })

  it('keeps internal delivery when returning to Formaloo could lose saved content', () => {
    const onRenderBackendChange = vi.fn()
    render(<FormBuilder {...base({
      initialRenderBackend: 'internal',
      onRenderBackendChange,
    })} />)

    fireEvent.change(screen.getByLabelText('配信方式'), { target: { value: 'formaloo' } })

    expect(onRenderBackendChange).not.toHaveBeenCalled()
    expect((screen.getByLabelText('配信方式') as HTMLSelectElement).value).toBe('internal')
    expect(screen.getByRole('alert').textContent).toContain('内容を失わないため')
  })

  it('does not expose the new provider UI until the backend change is confirmed', async () => {
    let resolveChange!: () => void
    const pending = new Promise<void>((resolve) => { resolveChange = resolve })
    const onRenderBackendChange = vi.fn().mockReturnValue(pending)
    render(<FormBuilder {...base({ onRenderBackendChange })} />)

    fireEvent.change(screen.getByLabelText('配信方式'), { target: { value: 'internal' } })

    const select = screen.getByLabelText('配信方式') as HTMLSelectElement
    expect(select.value).toBe('formaloo')
    expect(select.disabled).toBe(true)
    expect(screen.queryByRole('button', { name: '経由チャネルの表示ルールを追加' })).toBeNull()

    resolveChange()
    await waitFor(() => expect(select.value).toBe('internal'))
  })

  it('locks definition editing while a provider change is in flight', async () => {
    let resolveChange!: () => void
    const pending = new Promise<void>((resolve) => { resolveChange = resolve })
    const onRenderBackendChange = vi.fn().mockReturnValue(pending)
    render(<FormBuilder {...base({ onRenderBackendChange })} />)

    fireEvent.change(screen.getByLabelText('配信方式'), { target: { value: 'internal' } })

    const title = screen.getByLabelText('フォームタイトル') as HTMLInputElement
    expect(title.matches(':disabled')).toBe(true)

    resolveChange()
    await waitFor(() => expect(title.matches(':disabled')).toBe(false))
  })

  it('does not start a provider change while a definition save is in flight', async () => {
    let resolveSave!: () => void
    const pendingSave = new Promise<void>((resolve) => { resolveSave = resolve })
    const onSave = vi.fn().mockReturnValue(pendingSave)
    const onRenderBackendChange = vi.fn()
    render(<FormBuilder {...base({ onSave, onRenderBackendChange })} />)

    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    const select = screen.getByLabelText('配信方式') as HTMLSelectElement
    expect(select.disabled).toBe(true)
    fireEvent.change(select, { target: { value: 'internal' } })
    expect(onRenderBackendChange).not.toHaveBeenCalled()

    resolveSave()
    await waitFor(() => expect(select.disabled).toBe(false))
  })

  it('does not send internal-only channel logic to Formaloo where it would be lost', () => {
    const onRenderBackendChange = vi.fn()
    const fields: HarnessField[] = [
      { id: 'email', type: 'email', label: 'メール', required: false, position: 0, config: {} },
    ]
    render(<FormBuilder {...base({
      initialRenderBackend: 'internal',
      initialFields: fields,
      initialLogic: [{
        id: 'web-email', sourceFieldId: '__channel__', operator: 'equals', value: 'web',
        action: 'show', targetFieldId: 'email',
      }],
      onRenderBackendChange,
    })} />)

    fireEvent.change(screen.getByLabelText('配信方式'), { target: { value: 'formaloo' } })

    expect(onRenderBackendChange).not.toHaveBeenCalled()
    expect((screen.getByLabelText('配信方式') as HTMLSelectElement).value).toBe('internal')
    expect(screen.getByRole('alert').textContent).toContain('内容を失わないため')
  })

  it('does not send one-page ordinary-field branching to Formaloo where it would stop working', () => {
    const onRenderBackendChange = vi.fn()
    const fields: HarnessField[] = [
      { id: 'route', type: 'choice', label: 'ルート', required: false, position: 0, config: { choices: ['A', 'B'] } },
      { id: 'email', type: 'email', label: 'メール', required: false, position: 1, config: {} },
    ]
    render(<FormBuilder {...base({
      initialRenderBackend: 'internal',
      initialFormType: 'simple',
      initialFields: fields,
      initialLogic: [{
        id: 'show-email', sourceFieldId: 'route', operator: 'equals', value: 'A',
        action: 'show', targetFieldId: 'email',
      }],
      onRenderBackendChange,
    })} />)

    fireEvent.change(screen.getByLabelText('配信方式'), { target: { value: 'formaloo' } })

    expect(onRenderBackendChange).not.toHaveBeenCalled()
    expect((screen.getByLabelText('配信方式') as HTMLSelectElement).value).toBe('internal')
  })

  it('treats an omitted display type as one-page when guarding a provider switch', () => {
    const onRenderBackendChange = vi.fn()
    const fields: HarnessField[] = [
      { id: 'route', type: 'choice', label: 'ルート', required: false, position: 0, config: { choices: ['A'] } },
      { id: 'email', type: 'email', label: 'メール', required: false, position: 1, config: {} },
    ]
    render(<FormBuilder {...base({
      initialRenderBackend: 'internal',
      initialFields: fields,
      initialLogic: [{
        id: 'show-email', sourceFieldId: 'route', operator: 'equals', value: 'A',
        action: 'show', targetFieldId: 'email',
      }],
      onRenderBackendChange,
    })} />)

    fireEvent.change(screen.getByLabelText('配信方式'), { target: { value: 'formaloo' } })

    expect(onRenderBackendChange).not.toHaveBeenCalled()
    expect((screen.getByLabelText('配信方式') as HTMLSelectElement).value).toBe('internal')
  })

  it('does not send one-page terminal submission branching to Formaloo', () => {
    const onRenderBackendChange = vi.fn()
    const fields: HarnessField[] = [
      { id: 'route', type: 'choice', label: 'ルート', required: false, position: 0, config: { choices: ['A'] } },
    ]
    render(<FormBuilder {...base({
      initialRenderBackend: 'internal',
      initialFormType: 'simple',
      initialFields: fields,
      initialLogic: [{
        id: 'finish-a', sourceFieldId: 'route', operator: 'equals', value: 'A',
        action: 'submit', targetFieldId: 'done-a', terminalTrigger: 'on_answered',
      }],
      initialSuccessPages: [{ id: 'done-a', title: 'A完了' }],
      onRenderBackendChange,
    })} />)

    fireEvent.change(screen.getByLabelText('配信方式'), { target: { value: 'formaloo' } })

    expect(onRenderBackendChange).not.toHaveBeenCalled()
    expect((screen.getByLabelText('配信方式') as HTMLSelectElement).value).toBe('internal')
  })

  it('does not send compound internal logic to a Formaloo save path that would weaken it', () => {
    const onRenderBackendChange = vi.fn()
    const fields: HarnessField[] = [
      { id: 'route', type: 'text', label: 'ルート', required: false, position: 0, config: {} },
      { id: 'email', type: 'email', label: 'メール', required: false, position: 1, config: {} },
    ]
    render(<FormBuilder {...base({
      initialRenderBackend: 'internal',
      initialFormType: 'multi_step',
      initialFields: fields,
      initialLogic: [{
        id: 'compound', sourceFieldId: 'route', operator: 'equals', value: 'A',
        action: 'show', targetFieldId: 'email', conditionJoin: 'and',
        conditions: [
          { sourceFieldId: 'route', operator: 'equals', value: 'A' },
          { sourceFieldId: 'email', operator: 'equals', value: 'a@example.com' },
        ],
        actions: [{ action: 'show', targetFieldId: 'email' }],
      }],
      onRenderBackendChange,
    })} />)

    fireEvent.change(screen.getByLabelText('配信方式'), { target: { value: 'formaloo' } })

    expect(onRenderBackendChange).not.toHaveBeenCalled()
    expect((screen.getByLabelText('配信方式') as HTMLSelectElement).value).toBe('internal')
  })
})
