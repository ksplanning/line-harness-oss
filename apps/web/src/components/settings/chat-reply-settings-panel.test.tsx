// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    accountSettings: {
      getChatReplySettings: (...args: unknown[]) => mocks.get(...args),
      updateChatReplySettings: (...args: unknown[]) => mocks.update(...args),
    },
  },
}))

import ChatReplySettingsPanel from './chat-reply-settings-panel'

function view(defaultReplyName: string) {
  return {
    success: true,
    data: { defaultReplyName },
  }
}

beforeEach(() => {
  mocks.get.mockReset().mockResolvedValue(view('変更前'))
  mocks.update.mockReset().mockResolvedValue(view('受付係'))
})

afterEach(() => cleanup())

describe('ChatReplySettingsPanel', () => {
  test('saves and then reloads the exact persisted reply name', async () => {
    mocks.get
      .mockResolvedValueOnce(view('変更前'))
      .mockResolvedValueOnce(view('受付係'))
    render(<ChatReplySettingsPanel accountId="account-1" />)

    const input = await screen.findByLabelText('既定の返信者名')
    expect((input as HTMLInputElement).value).toBe('変更前')
    fireEvent.change(input, { target: { value: '受付係' } })
    fireEvent.click(screen.getByRole('button', { name: '返信者名を保存' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith(
      'account-1',
      '受付係',
    ))
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2))
    expect((screen.getByLabelText('既定の返信者名') as HTMLInputElement).value)
      .toBe('受付係')
    expect(screen.getByRole('status').textContent).toContain('保存しました')
  })

  test('saves an empty name and explains that empty means no prefix', async () => {
    mocks.get
      .mockResolvedValueOnce(view('受付係'))
      .mockResolvedValueOnce(view(''))
    mocks.update.mockResolvedValueOnce(view(''))
    render(<ChatReplySettingsPanel accountId="account-1" />)

    const input = await screen.findByLabelText('既定の返信者名')
    expect(screen.getByText(
      '空欄で保存すると、返信文の先頭に名乗りを付けません。',
    )).toBeTruthy()
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '返信者名を保存' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('account-1', ''))
    await waitFor(() => {
      expect((screen.getByLabelText('既定の返信者名') as HTMLInputElement).value)
        .toBe('')
    })
  })

  test('loads each selected account independently', async () => {
    mocks.get.mockImplementation(async (accountId: string) => (
      view(accountId === 'account-a' ? 'A受付' : 'B受付')
    ))
    const rendered = render(<ChatReplySettingsPanel accountId="account-a" />)

    expect((await screen.findByLabelText('既定の返信者名') as HTMLInputElement).value)
      .toBe('A受付')

    rendered.rerender(<ChatReplySettingsPanel accountId="account-b" />)
    await waitFor(() => {
      expect((screen.getByLabelText('既定の返信者名') as HTMLInputElement).value)
        .toBe('B受付')
    })
    expect(mocks.get).toHaveBeenCalledWith('account-a')
    expect(mocks.get).toHaveBeenCalledWith('account-b')
  })

  test('does not apply a stale GET response after the account changes', async () => {
    let resolveOld!: (value: ReturnType<typeof view>) => void
    mocks.get.mockImplementation((accountId: string) => {
      if (accountId === 'account-old') {
        return new Promise((resolve) => {
          resolveOld = resolve
        })
      }
      return Promise.resolve(view('新アカウント担当'))
    })
    const rendered = render(<ChatReplySettingsPanel accountId="account-old" />)
    rendered.rerender(<ChatReplySettingsPanel accountId="account-new" />)

    expect((await screen.findByLabelText('既定の返信者名') as HTMLInputElement).value)
      .toBe('新アカウント担当')

    await act(async () => {
      resolveOld(view('古いアカウント担当'))
      await Promise.resolve()
    })
    expect((screen.getByLabelText('既定の返信者名') as HTMLInputElement).value)
      .toBe('新アカウント担当')
  })
})
