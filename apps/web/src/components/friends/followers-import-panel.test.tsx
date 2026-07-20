// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const m = vi.hoisted(() => ({
  latest: vi.fn(),
  start: vi.fn(),
  advance: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    followerImports: {
      latest: (...args: unknown[]) => m.latest(...args),
      start: (...args: unknown[]) => m.start(...args),
      advance: (...args: unknown[]) => m.advance(...args),
    },
  },
}))

import FollowersImportPanel from './followers-import-panel'

const NOT_VERIFIED = 'このアカウントは認証済みではないため利用できません (LINE の仕様)'

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'import-1',
    accountId: 'account-1',
    status: 'fetching',
    continuationToken: 'next-page',
    fetchedCount: 1000,
    newCount: 800,
    existingCount: 200,
    profileCompletedCount: 0,
    failedCount: 0,
    nextRunAt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: '2026-07-21T10:00:00.000+09:00',
    updatedAt: '2026-07-21T10:00:01.000+09:00',
    completedAt: null,
    ...overrides,
  }
}

beforeEach(() => {
  vi.useRealTimers()
  m.latest.mockReset().mockResolvedValue({ success: true, data: null })
  m.start.mockReset()
  m.advance.mockReset()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('FollowersImportPanel', () => {
  test('認証済み用アクションを開始し、完了実数を表示して一覧を再取得する', async () => {
    const onCompleted = vi.fn()
    m.start.mockResolvedValue({
      success: true,
      data: job({
        status: 'completed',
        continuationToken: null,
        newCount: 12,
        existingCount: 34,
        profileCompletedCount: 10,
        failedCount: 2,
        completedAt: '2026-07-21T10:01:00.000+09:00',
      }),
    })

    render(<FollowersImportPanel accountId="account-1" onCompleted={onCompleted} />)
    const button = screen.getByRole('button', {
      name: '既存友だちを取り込む (認証済みアカウント用)',
    })
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    expect(button.className).toContain('text-gray-950')
    expect(button.className).toContain('focus-visible:ring-2')
    fireEvent.click(button)

    expect(await screen.findByText('新規 12 名 / 既存 34 名 / 失敗 2 名')).toBeTruthy()
    expect(m.start).toHaveBeenCalledWith('account-1')
    await waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1))
  })

  test('初回は latest で復元し、running 中は重ならない advance tick で進める', async () => {
    vi.useFakeTimers()
    const running = job({ status: 'profiling', profileCompletedCount: 6 })
    let resolveAdvance!: (value: unknown) => void
    m.latest.mockResolvedValue({ success: true, data: running })
    m.advance.mockImplementation(() => new Promise((resolve) => { resolveAdvance = resolve }))

    render(
      <FollowersImportPanel accountId="account-1" onCompleted={vi.fn()} pollIntervalMs={1000} />,
    )
    await act(async () => { await Promise.resolve() })
    expect(m.latest).toHaveBeenCalledTimes(1)
    expect(screen.getByText('プロフィール取得中… 6 / 800 名')).toBeTruthy()
    expect(screen.getByText('既存 200 名 / 失敗 0 名')).toBeTruthy()

    await act(async () => { vi.advanceTimersByTime(1000) })
    expect(m.advance).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(5000) })
    expect(m.advance).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveAdvance({
        success: true,
        data: job({ status: 'completed', continuationToken: null, failedCount: 3 }),
      })
      await Promise.resolve()
    })
    expect(screen.getByText('新規 800 名 / 既存 200 名 / 失敗 3 名')).toBeTruthy()
  })

  test.each([403, 404])('%s 拒否は LINE 仕様の正直な文言を表示し、成功扱いしない', async (status) => {
    const failedJob = job({
      status: 'failed',
      continuationToken: null,
      fetchedCount: 0,
      newCount: 0,
      existingCount: 0,
      errorCode: 'account_not_verified',
      errorMessage: NOT_VERIFIED,
    })
    m.start.mockRejectedValue(Object.assign(new Error(`API error: ${status}`), {
      status,
      body: {
        success: false,
        error: NOT_VERIFIED,
        errorCode: 'account_not_verified',
        data: failedJob,
      },
    }))

    render(<FollowersImportPanel accountId="account-1" onCompleted={vi.fn()} />)
    const button = screen.getByRole('button', {
      name: '既存友だちを取り込む (認証済みアカウント用)',
    })
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(button)

    expect(await screen.findByText(NOT_VERIFIED)).toBeTruthy()
    expect(screen.queryByText(/新規 \d+ 名 \/ 既存 \d+ 名 \/ 失敗 \d+ 名/)).toBeNull()
  })

  test('advance 失敗を黙殺せず、保存済み進捗と再試行案内を表示する', async () => {
    m.latest.mockResolvedValue({ success: true, data: job() })
    m.advance.mockRejectedValue(Object.assign(new Error('API error: 502'), {
      status: 502,
      body: { success: false, error: 'LINE API への接続に失敗しました。' },
    }))

    render(
      <FollowersImportPanel accountId="account-1" onCompleted={vi.fn()} pollIntervalMs={1} />,
    )

    expect(await screen.findByText('LINE API への接続に失敗しました。')).toBeTruthy()
    expect(screen.getByText('1000 名まで確認済みです。進捗は保存されています。')).toBeTruthy()
    expect(screen.queryByText(/新規 \d+ 名 \/ 既存 \d+ 名 \/ 失敗 \d+ 名/)).toBeNull()
  })

  test('別workerが failed にした job を成功扱いせず理由を表示する', async () => {
    m.latest.mockResolvedValue({ success: true, data: job() })
    m.advance.mockResolvedValue({
      success: true,
      data: job({
        status: 'failed',
        errorCode: 'account_not_verified',
        errorMessage: NOT_VERIFIED,
      }),
    })

    render(
      <FollowersImportPanel accountId="account-1" onCompleted={vi.fn()} pollIntervalMs={1} />,
    )

    expect(await screen.findByText(NOT_VERIFIED)).toBeTruthy()
    expect(screen.queryByText(/新規 \d+ 名 \/ 既存 \d+ 名 \/ 失敗 \d+ 名/)).toBeNull()
  })

  test('開始中にアカウントを切り替えても古い結果を新アカウントへ混ぜない', async () => {
    let resolveStart!: (value: unknown) => void
    m.latest.mockResolvedValue({ success: true, data: null })
    m.start.mockImplementation(() => new Promise((resolve) => { resolveStart = resolve }))
    const view = render(
      <FollowersImportPanel accountId="account-1" onCompleted={vi.fn()} pollIntervalMs={1} />,
    )
    const button = screen.getByRole('button', {
      name: '既存友だちを取り込む (認証済みアカウント用)',
    })
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(button)

    view.rerender(
      <FollowersImportPanel accountId="account-2" onCompleted={vi.fn()} pollIntervalMs={1} />,
    )
    await act(async () => {
      resolveStart({ success: true, data: job({ accountId: 'account-1', status: 'profiling' }) })
      await Promise.resolve()
    })

    expect(screen.queryByText(/プロフィール取得中/)).toBeNull()
    expect(m.advance).not.toHaveBeenCalled()
    expect(m.latest).toHaveBeenLastCalledWith('account-2')
  })

  test('前回の完了表示を残したまま新しい開始失敗を成功のように見せない', async () => {
    m.latest.mockResolvedValue({
      success: true,
      data: job({ status: 'completed', newCount: 9, existingCount: 1, failedCount: 0 }),
    })
    m.start.mockRejectedValue(Object.assign(new Error('API error: 502'), {
      status: 502,
      body: { success: false, error: '一時的に開始できません。' },
    }))
    render(<FollowersImportPanel accountId="account-1" onCompleted={vi.fn()} />)
    const oldResult = await screen.findByText('新規 9 名 / 既存 1 名 / 失敗 0 名')
    fireEvent.click(screen.getByRole('button', {
      name: '既存友だちを取り込む (認証済みアカウント用)',
    }))

    expect(await screen.findByText('一時的に開始できません。')).toBeTruthy()
    expect(oldResult.isConnected).toBe(false)
  })

  test('A→B→A 切替でも最初のAの遅い開始結果を受理しない', async () => {
    let resolveStart!: (value: unknown) => void
    m.latest.mockResolvedValue({ success: true, data: null })
    m.start.mockImplementation(() => new Promise((resolve) => { resolveStart = resolve }))
    const view = render(<FollowersImportPanel accountId="account-1" onCompleted={vi.fn()} />)
    const button = screen.getByRole('button', {
      name: '既存友だちを取り込む (認証済みアカウント用)',
    })
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(button)

    view.rerender(<FollowersImportPanel accountId="account-2" onCompleted={vi.fn()} />)
    await act(async () => { await Promise.resolve() })
    view.rerender(<FollowersImportPanel accountId="account-1" onCompleted={vi.fn()} />)
    await act(async () => {
      resolveStart({ success: true, data: job({ accountId: 'account-1', status: 'profiling' }) })
      await Promise.resolve()
    })

    expect(screen.queryByText(/プロフィール取得中/)).toBeNull()
    expect(m.advance).not.toHaveBeenCalled()
  })

  test('アカウント未選択では開始できず、API を呼ばない', () => {
    render(<FollowersImportPanel accountId={null} onCompleted={vi.fn()} />)

    expect((screen.getByRole('button', {
      name: '既存友だちを取り込む (認証済みアカウント用)',
    }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('先に対象のLINE公式アカウントを選択してください。')).toBeTruthy()
    expect(m.latest).not.toHaveBeenCalled()
  })
})
