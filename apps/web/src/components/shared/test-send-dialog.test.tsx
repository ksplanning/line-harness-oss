// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const { getTestRecipients, sendTest } = vi.hoisted(() => ({
  getTestRecipients: vi.fn(),
  sendTest: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    testSends: {
      getRecipients: (...args: unknown[]) => getTestRecipients(...args),
      send: (...args: unknown[]) => sendTest(...args),
    },
  },
}))

import TestSendDialog from './test-send-dialog'

beforeEach(() => {
  getTestRecipients.mockReset()
  sendTest.mockReset()
})

afterEach(() => cleanup())

describe('TestSendDialog', () => {
  it('loads configured recipients and sends each account without accepting recipient ids from the screen', async () => {
    getTestRecipients.mockImplementation(async (_source: string, accountId: string) => ({
      success: true,
      data: [{ id: `friend-${accountId}`, displayName: `担当者 ${accountId}`, pictureUrl: null }],
    }))
    sendTest.mockResolvedValue({ success: true, sent: 1, failed: 0 })

    render(
      <TestSendDialog
        accountIds={['acc-1', 'acc-2', 'acc-1']}
        source="broadcast"
        messages={[{ type: 'text', content: 'こんにちは {{display_name}}' }]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'テスト送信' }))
    await waitFor(() => expect(screen.getByText('担当者 acc-1')).toBeTruthy())
    expect(screen.getByText('担当者 acc-2')).toBeTruthy()
    expect(getTestRecipients).toHaveBeenCalledTimes(2)
    expect(getTestRecipients).toHaveBeenCalledWith('broadcast', 'acc-1')
    expect(getTestRecipients).toHaveBeenCalledWith('broadcast', 'acc-2')

    fireEvent.click(screen.getByRole('button', { name: 'テスト送信する' }))
    await waitFor(() => expect(sendTest).toHaveBeenCalledTimes(2))

    for (const [payload] of sendTest.mock.calls) {
      expect(payload).toEqual(expect.objectContaining({
        source: 'broadcast',
        messages: [{ type: 'text', content: 'こんにちは {{display_name}}' }],
        idempotencyKey: expect.any(String),
      }))
      expect(payload).not.toHaveProperty('friendIds')
      expect(payload.idempotencyKey.length).toBeGreaterThanOrEqual(8)
    }
    expect(sendTest.mock.calls.map(([payload]) => payload.accountId)).toEqual(['acc-1', 'acc-2'])
    await waitFor(() => expect(screen.getByText('2件の送信先へテスト送信しました')).toBeTruthy())
  })

  it('guides the operator to settings and does not send when any account has no recipient', async () => {
    getTestRecipients.mockImplementation(async (_source: string, accountId: string) => ({
      success: true,
      data: accountId === 'acc-ready'
        ? [{ id: 'friend-1', displayName: '設定済み', pictureUrl: null }]
        : [],
    }))

    render(
      <TestSendDialog
        accountIds={['acc-ready', 'acc-empty']}
        source="scenario"
        messages={[{ type: 'text', content: '確認' }]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'テスト送信' }))
    await waitFor(() => expect(screen.getByText(/先に設定してください/)).toBeTruthy())
    expect(screen.getByRole('link', { name: 'テスト送信先を設定する' }).getAttribute('href')).toBe('/accounts')
    expect(screen.getByRole('button', { name: 'テスト送信する' })).toHaveProperty('disabled', true)
    expect(sendTest).not.toHaveBeenCalled()
  })

  it('prevents duplicate requests while the first send is in flight', async () => {
    getTestRecipients.mockResolvedValue({
      success: true,
      data: [{ id: 'friend-1', displayName: 'テスター', pictureUrl: null }],
    })
    let finish!: (value: unknown) => void
    sendTest.mockImplementation(() => new Promise((resolve) => { finish = resolve }))

    render(
      <TestSendDialog
        accountIds={['acc-1']}
        source="reminder"
        messages={[{ type: 'text', content: 'リマインド' }]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'テスト送信' }))
    const sendButton = await screen.findByRole('button', { name: 'テスト送信する' })

    fireEvent.click(sendButton)
    fireEvent.click(sendButton)
    expect(sendTest).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: '送信中...' })).toHaveProperty('disabled', true)

    finish({ success: true, sent: 1, failed: 0 })
    await waitFor(() => expect(screen.getByText('1件の送信先へテスト送信しました')).toBeTruthy())
  })

  it('reports partial multi-account results and keeps per-account idempotency keys for retry', async () => {
    getTestRecipients.mockImplementation(async (_source: string, accountId: string) => ({
      success: true,
      data: [{ id: `friend-${accountId}`, displayName: `担当者 ${accountId}`, pictureUrl: null }],
    }))
    sendTest.mockImplementation(async ({ accountId }: { accountId: string }) => {
      if (accountId === 'acc-2') throw new Error('回線失敗')
      return { success: true, sent: 1, failed: 0 }
    })

    render(
      <TestSendDialog
        accountIds={['acc-1', 'acc-2']}
        source="broadcast"
        messages={[{ type: 'text', content: '確認' }]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'テスト送信' }))
    const sendButton = await screen.findByRole('button', { name: 'テスト送信する' })

    fireEvent.click(sendButton)
    await waitFor(() => expect(screen.getByText('1件成功、1件失敗しました。成功済みの送信は重複しません')).toBeTruthy())
    const firstKeys = sendTest.mock.calls.map(([payload]) => payload.idempotencyKey)

    fireEvent.click(sendButton)
    await waitFor(() => expect(sendTest).toHaveBeenCalledTimes(4))
    expect(sendTest.mock.calls.slice(2).map(([payload]) => payload.idempotencyKey)).toEqual(firstKeys)
  })

  it('shows a retryable error when recipient settings cannot be loaded', async () => {
    getTestRecipients.mockRejectedValue(new Error('network'))
    render(
      <TestSendDialog
        accountIds={['acc-1']}
        source="template_pack"
        messages={[{ type: 'text', content: '確認' }]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'テスト送信' }))
    await waitFor(() => expect(screen.getByText('テスト送信先を読み込めませんでした')).toBeTruthy())
    expect(screen.getByRole('button', { name: '再読み込み' })).toBeTruthy()
    expect(sendTest).not.toHaveBeenCalled()
  })
})
