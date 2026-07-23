// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('./email-sender-settings-panel', () => ({
  default: ({ accountId }: { accountId: string }) => (
    <div>
      <input aria-label="差出人メールアドレス" data-account-id={accountId} />
      <button type="button">パネル末尾</button>
    </div>
  ),
}))

import EmailSenderSettingsDialog from './email-sender-settings-dialog'

afterEach(() => {
  cleanup()
  document.body.style.overflow = ''
})

describe('EmailSenderSettingsDialog', () => {
  test('初期focus・Tab trap・Escape終了・scroll lock・focus復元を行う', async () => {
    const onClose = vi.fn()
    const view = render(<button type="button">設定を開く</button>)
    const opener = screen.getByRole('button', { name: '設定を開く' })
    opener.focus()

    view.rerender(
      <>
        <button type="button">設定を開く</button>
        <EmailSenderSettingsDialog
          accountId="account-1"
          accountName="メイン"
          onClose={onClose}
        />
      </>,
    )

    const close = screen.getByRole('button', { name: 'メール差出人設定を閉じる' })
    await waitFor(() => expect(document.activeElement).toBe(close))
    expect(document.body.style.overflow).toBe('hidden')

    const last = screen.getByRole('button', { name: 'パネル末尾' })
    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    view.rerender(<button type="button">設定を開く</button>)
    expect(document.body.style.overflow).toBe('')
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '設定を開く' }))
  })
})
