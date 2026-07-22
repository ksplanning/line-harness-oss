// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listUnanswered: vi.fn(),
  listLineAccounts: vi.fn(),
}))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}))

vi.mock('@/lib/api', () => ({
  api: {
    inbox: { unanswered: { list: (...args: unknown[]) => mocks.listUnanswered(...args) } },
    lineAccounts: { list: (...args: unknown[]) => mocks.listLineAccounts(...args) },
  },
}))

import InboxPage from './page'

const row = {
  friendId: 'friend-1',
  displayName: '返事待ちの田中さん',
  pictureUrl: null,
  accountId: 'account-1',
  accountName: 'メインアカウント',
  lastIncomingAt: '2026-07-22T00:00:00.000Z',
  lastManualAt: null,
  lastMachineAt: null,
  lastIncomingType: 'text',
  lastIncomingContent: '確認をお願いします',
}

const successResponse = {
  success: true,
  data: {
    total: 1,
    page: 1,
    pageSize: 2000,
    rows: [row],
  },
}

let intervalSpy: ReturnType<typeof vi.spyOn>
let consoleErrorSpy: ReturnType<typeof vi.spyOn>

function getInboxPoll(): () => Promise<void> {
  const call = intervalSpy.mock.calls.find(([, timeout]) => timeout === 30_000)
  expect(call).toBeTruthy()
  return call?.[0] as () => Promise<void>
}

beforeEach(() => {
  mocks.listUnanswered.mockReset()
  mocks.listLineAccounts.mockReset().mockResolvedValue({ success: true, data: [] })
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  intervalSpy = vi.spyOn(globalThis, 'setInterval')
})

afterEach(() => {
  cleanup()
  intervalSpy.mockRestore()
  consoleErrorSpy.mockRestore()
})

describe('未対応インボックスの取得エラー', () => {
  it('503 の初回失敗後に1回だけ即時再試行し、成功すればバナーを出さない', async () => {
    const err = Object.assign(new Error('service unavailable'), {
      status: 503,
      body: { error: 'temporarily unavailable' },
    })
    mocks.listUnanswered.mockRejectedValueOnce(err).mockResolvedValueOnce(successResponse)

    render(<InboxPage />)

    await screen.findByText('返事待ちの田中さん')
    expect(mocks.listUnanswered).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('一時的に取得できませんでした。自動で再取得します')).toBeNull()
    expect(intervalSpy.mock.calls.some(([, timeout]) => timeout === 30_000)).toBe(true)
  })

  it('401 が再試行後も続けば再ログイン導線を表示し、status/body を記録する', async () => {
    const err = Object.assign(new Error('unauthorized'), {
      status: 401,
      body: { error: 'session expired' },
    })
    mocks.listUnanswered.mockRejectedValue(err)

    render(<InboxPage />)

    await screen.findByText('ログインの有効期限が切れました。')
    expect(mocks.listUnanswered).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('link', { name: '再ログインしてください' }).getAttribute('href')).toBe('/login')
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '未対応インボックス取得エラー',
      expect.objectContaining({ status: 401, body: { error: 'session expired' } }),
    )
  })

  it('503 中も直前の一覧とバナーを保持し、次のポーリング成功時にだけバナーを消す', async () => {
    const err = Object.assign(new Error('service unavailable'), {
      status: 503,
      body: { error: 'temporarily unavailable' },
    })
    let resolveRecovery!: (value: typeof successResponse) => void
    const recovery = new Promise<typeof successResponse>((resolve) => {
      resolveRecovery = resolve
    })
    mocks.listUnanswered
      .mockResolvedValueOnce(successResponse)
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockImplementationOnce(() => recovery)

    render(<InboxPage />)
    await screen.findByText('返事待ちの田中さん')
    const poll = getInboxPoll()

    await act(async () => {
      await poll()
    })

    expect(mocks.listUnanswered).toHaveBeenCalledTimes(3)
    expect(screen.getByText('返事待ちの田中さん')).toBeTruthy()
    expect(screen.getByText('一時的に取得できませんでした。自動で再取得します')).toBeTruthy()

    let pendingRecovery!: Promise<void>
    await act(async () => {
      pendingRecovery = poll()
      await Promise.resolve()
    })
    expect(screen.getByText('一時的に取得できませんでした。自動で再取得します')).toBeTruthy()

    await act(async () => {
      resolveRecovery(successResponse)
      await pendingRecovery
    })
    await waitFor(() => {
      expect(screen.queryByText('一時的に取得できませんでした。自動で再取得します')).toBeNull()
    })
    expect(screen.getByText('返事待ちの田中さん')).toBeTruthy()
  })

  it('status のない network error も1回だけ再試行して一時エラーとして表示する', async () => {
    mocks.listUnanswered.mockRejectedValue(new TypeError('Failed to fetch'))

    render(<InboxPage />)

    await screen.findByText('一時的に取得できませんでした。自動で再取得します')
    expect(mocks.listUnanswered).toHaveBeenCalledTimes(2)
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '未対応インボックス取得エラー',
      expect.objectContaining({ status: undefined, body: undefined }),
    )
  })
})
