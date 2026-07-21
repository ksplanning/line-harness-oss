// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import FormBuilder from './builder'
import type { HarnessField } from '@line-crm/shared'

afterEach(() => cleanup())

const field: HarnessField = {
  id: 'name', type: 'text', label: 'お名前', required: true, position: 0, config: {},
}

function base(overrides: Record<string, unknown> = {}) {
  return {
    formTitle: '夏の相談会',
    status: 'draft' as const,
    initialFields: [field],
    initialLogic: [],
    initialRenderBackend: 'internal' as const,
    initialOperationsSettings: {
      maxSubmitCount: 30,
      submitStartTime: '2026-07-25T09:00:00+09:00',
      submitEndTime: '2026-08-01T18:00:00+09:00',
    },
    onSave: vi.fn().mockResolvedValue({ ok: true, publishRevision: 'revision-1' }),
    onPublish: vi.fn().mockResolvedValue(true),
    ...overrides,
  }
}

describe('internal publish confirmation', () => {
  it('publishes directly through one large modal only after the current definition is saved', async () => {
    const order: string[] = []
    const onSave = vi.fn(async () => { order.push('save'); return { ok: true, publishRevision: 'revision-1' } })
    const onPublish = vi.fn(async () => { order.push('publish'); return true })
    render(<FormBuilder {...base({ onSave, onPublish, onSubmitForReview: vi.fn() })} />)

    expect(screen.queryByText('レビュー依頼')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '公開' }))

    const dialog = screen.getByRole('dialog', { name: '自前フォームを公開' })
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.className).toContain('max-w-2xl')
    expect(dialog.textContent).toContain('夏の相談会')
    expect(dialog.textContent).toContain('2026年7月25日 09:00')
    expect(dialog.textContent).toContain('2026年8月1日 18:00')
    expect(dialog.textContent).toContain('30件')
    expect(onSave).not.toHaveBeenCalled()
    expect(onPublish).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'この内容で公開する' }))
    await waitFor(() => expect(order).toEqual(['save', 'publish']))
    expect(onPublish).toHaveBeenCalledWith('revision-1')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('keeps the modal open and never publishes when the preceding save is not confirmed', async () => {
    const onPublish = vi.fn()
    render(<FormBuilder {...base({
      onSave: vi.fn().mockResolvedValue(undefined),
      onPublish,
    })} />)

    fireEvent.click(screen.getByRole('button', { name: '公開' }))
    fireEvent.click(screen.getByRole('button', { name: 'この内容で公開する' }))

    await waitFor(() => expect(onPublish).not.toHaveBeenCalled())
    expect(screen.getByRole('dialog', { name: '自前フォームを公開' })).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('公開していません')
  })

  it('fails closed when save succeeds without a confirmation revision', async () => {
    const onPublish = vi.fn()
    render(<FormBuilder {...base({
      onSave: vi.fn().mockResolvedValue({ ok: true }),
      onPublish,
    })} />)

    fireEvent.click(screen.getByRole('button', { name: '公開' }))
    fireEvent.click(screen.getByRole('button', { name: 'この内容で公開する' }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('保存した内容を確認できなかった'))
    expect(onPublish).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: '自前フォームを公開' })).toBeTruthy()
  })

  it('keeps publish failure inside the modal and supports focus, Escape, and short mobile scrolling', async () => {
    render(<FormBuilder {...base({ onPublish: vi.fn().mockResolvedValue(false) })} />)

    fireEvent.click(screen.getByRole('button', { name: '公開' }))
    const dialog = screen.getByRole('dialog', { name: '自前フォームを公開' })
    expect(dialog.className).toContain('max-h-[calc(100dvh-2rem)]')
    expect(dialog.className).toContain('overflow-y-auto')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'この内容で公開する' })))

    fireEvent.click(screen.getByRole('button', { name: 'この内容で公開する' }))
    expect((await screen.findByRole('alert')).textContent).toContain('公開できませんでした')
    expect(screen.getByRole('dialog', { name: '自前フォームを公開' })).toBeTruthy()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: '公開' })))
  })

  it('keeps keyboard focus inside the modal while the pre-publish save is pending', async () => {
    let resolveSave!: (value: { ok: boolean }) => void
    const onSave = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => { resolveSave = resolve }))
    render(<FormBuilder {...base({ onSave })} />)

    const openButton = screen.getByRole('button', { name: '公開' })
    openButton.focus()
    const backgroundFocus = vi.spyOn(openButton, 'focus')
    fireEvent.click(openButton)
    const dialog = screen.getByRole('dialog', { name: '自前フォームを公開' })
    await waitFor(() => expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'この内容で公開する' }),
    ))
    fireEvent.click(screen.getByRole('button', { name: 'この内容で公開する' }))

    await waitFor(() => expect(screen.getAllByRole('button', { name: '保存中...' })).toHaveLength(2))
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(backgroundFocus).not.toHaveBeenCalled()

    // 保存中は2つの操作ボタンが無効になる。その間も Tab を背景へ逃がさない。
    openButton.focus()
    expect(fireEvent.keyDown(document, { key: 'Tab' })).toBe(false)
    expect(document.activeElement).toBe(dialog)

    resolveSave({ ok: false })
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  })

  it('hides Formaloo-only sync and reimport controls for internal forms', () => {
    render(<FormBuilder {...base({
      syncStatus: 'out_of_sync',
      syncError: 'remote error',
      driftStatus: 'conflict',
      onReimport: vi.fn(),
    })} />)

    expect(screen.queryByTestId('sync-badge')).toBeNull()
    expect(screen.queryByTestId('sync-recovery')).toBeNull()
    expect(screen.queryByText('Formaloo から再取り込み')).toBeNull()
  })

  it('shows honest availability instead of a generic published label', () => {
    render(<FormBuilder {...base({
      status: 'published',
      publicUrl: 'https://api.example.test/f/form-1',
      internalAvailability: { status: 'upcoming', message: '受付開始前・7月25日から' },
    })} />)

    expect(screen.getAllByText(/受付開始前・7月25日から/).length).toBeGreaterThan(0)
    expect(screen.queryByText(/公開中/)).toBeNull()
  })

  it('passes saved internal copy into the interactive preview', () => {
    render(<FormBuilder {...base({
      initialFormCopy: { buttonText: '相談を申し込む', successMessage: '相談を受け付けました' },
    })} />)

    expect(screen.getByRole('button', { name: '相談を申し込む' })).toBeTruthy()
  })

  it('passes the saved redirect destination into the interactive preview without navigating', () => {
    render(<FormBuilder {...base({
      initialFormRedirect: {
        url: 'https://example.test/thanks?from=preview',
        openExternalBrowser: true,
      },
    })} />)

    const preview = within(screen.getByTestId('preview-pane'))
    fireEvent.change(preview.getByLabelText('お名前'), { target: { value: '佐藤' } })
    fireEvent.click(preview.getByRole('button', { name: '送信する' }))

    expect(preview.getByTestId('preview-redirect-completion').textContent)
      .toContain('https://example.test/thanks?from=preview')
    expect(preview.getByTestId('preview-redirect-completion').textContent)
      .toContain('LINE外のブラウザ')
  })

  it('hides unsupported Formaloo-only controls while keeping internal受付 controls', () => {
    render(<FormBuilder {...base({ initialFriendMetadataMappings: [{ formalooFieldKey: 'email', friendMetadataKey: '連絡先' }] })} />)

    expect(screen.queryByLabelText(/reCAPTCHA/)).toBeNull()
    expect(screen.queryByLabelText('下書き保存')).toBeNull()
    expect(screen.queryByLabelText(/UTM/)).toBeNull()
    expect(screen.queryByLabelText('後編集を許可しない')).toBeNull()
    expect(screen.queryByLabelText('メールで編集URLを送る')).toBeNull()
    expect(screen.queryByTestId('friend-metadata-mapping-section')).toBeNull()
    expect(screen.queryByLabelText('送信エラー時の文言')).toBeNull()
    expect(screen.getByLabelText(/送信上限/)).toBeTruthy()
    expect(screen.getByLabelText('受付開始')).toBeTruthy()
    expect(screen.getByLabelText('受付終了')).toBeTruthy()
  })

  it('does not let hidden legacy Formaloo edit-mail settings block an internal publish', async () => {
    const onSave = vi.fn().mockResolvedValue({ ok: true, publishRevision: 'revision-1' })
    const onPublish = vi.fn().mockResolvedValue(true)
    render(<FormBuilder {...base({
      initialAllowPostEdit: 1,
      initialAllowEditMail: 1,
      initialEditMailFieldId: null,
      onSave,
      onPublish,
    })} />)

    fireEvent.click(screen.getByRole('button', { name: '公開' }))
    fireEvent.click(screen.getByRole('button', { name: 'この内容で公開する' }))

    await waitFor(() => expect(onPublish).toHaveBeenCalledTimes(1))
    expect(onSave).toHaveBeenCalledWith(expect.not.objectContaining({
      allowPostEdit: expect.anything(),
      allowEditMail: expect.anything(),
      editMailFieldId: expect.anything(),
    }))
  })

  it('leaves the existing Formaloo review confirmation inline and without a modal', () => {
    render(<FormBuilder {...base({
      status: 'in_review', initialRenderBackend: 'formaloo', onPublish: vi.fn(),
    })} />)

    fireEvent.click(screen.getByRole('button', { name: '公開' }))
    expect(screen.getByTestId('publish-confirm')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('lets the owner save a field visibility rule for LINE or direct-link traffic', () => {
    const onSave = vi.fn()
    const email: HarnessField = {
      id: 'email', type: 'email', label: 'メール', required: false, position: 1, config: {},
    }
    render(<FormBuilder {...base({ initialFields: [field, email], onSave })} />)
    fireEvent.click(screen.getByRole('tab', { name: '公開と共有' }))

    fireEvent.click(screen.getByRole('button', { name: '経由チャネルの表示ルールを追加' }))
    fireEvent.change(screen.getByLabelText('経由チャネル'), { target: { value: 'web' } })
    fireEvent.change(screen.getByLabelText('チャネル分岐アクション'), { target: { value: 'show' } })
    fireEvent.change(screen.getByLabelText('チャネル分岐対象'), { target: { value: 'email' } })
    fireEvent.click(screen.getByText('保存'))

    expect((onSave.mock.calls[0][0] as { logic: unknown[] }).logic).toEqual([
      expect.objectContaining({
        sourceFieldId: '__channel__', value: 'web', action: 'show', targetFieldId: 'email',
      }),
    ])
  })
})
