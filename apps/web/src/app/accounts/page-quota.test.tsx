// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  getQuota: vi.fn(),
  getFriendTrend: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    lineAccounts: {
      list: apiMocks.list,
      getQuota: apiMocks.getQuota,
      getFriendTrend: apiMocks.getFriendTrend,
    },
  },
}))
vi.mock('@/components/layout/header', () => ({ default: ({ title }: { title: string }) => <h1>{title}</h1> }))
vi.mock('@/components/cc-prompt-button', () => ({ default: () => null }))
vi.mock('@/components/accounts/test-recipients-setting', () => ({ default: () => null }))
vi.mock('@/components/accounts/monthly-cap-settings', () => ({ default: () => null }))
vi.mock('@/components/accounts/account-settings-section', () => ({ default: () => null }))
vi.mock('@/components/accounts/reorder-mode', () => ({ default: () => null }))
vi.mock('@/components/accounts/account-setup-urls', () => ({ default: () => null }))
vi.mock('@/components/accounts/account-edit-modal', () => ({ default: () => null }))
vi.mock('@/components/accounts/response-schedule-modal', () => ({ default: () => null }))
vi.mock('@/components/settings/email-sender-settings-dialog', () => ({
  default: ({ accountId }: { accountId: string }) => (
    <div
      data-testid="email-sender-settings-dialog"
      data-account-id={accountId}
    />
  ),
}))
vi.mock('@/components/accounts/account-form-fields', () => ({
  AccountFormSections: () => null,
  emptyAccountFormState: {},
}))

import AccountsPage from './page'

beforeEach(() => {
  apiMocks.list.mockResolvedValue({
    success: true,
    data: [{
      id: 'acc-1',
      channelId: 'channel-1',
      name: 'メイン',
      displayName: 'メインアカウント',
      pictureUrl: null,
      basicId: '@main',
      isActive: true,
      loginChannelId: null,
      liffId: null,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      stats: {
        friendCount: 10,
        totalFriendCount: 12,
        blockedFriendCount: 2,
        sendableFriendCount: 10,
        activeScenarios: 1,
        messagesThisMonth: 50,
      },
    }],
  })
  apiMocks.getQuota.mockResolvedValue({
    success: true,
    data: {
      plan_label: 'コミュニケーションプラン相当（推定）',
      limit: 200,
      used: 50,
      remaining: 150,
      type: 'limited',
    },
  })
  apiMocks.getFriendTrend.mockImplementation(async (_id: string, days: 30 | 90) => ({
    success: true,
    data: {
      lineAccountId: 'acc-1',
      periodDays: days,
      points: [
        { date: '2026-07-22', registrations: 1 },
        { date: '2026-07-23', registrations: 3 },
      ],
    },
  }))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('LINEアカウント管理の公式送信数', () => {
  it('プラン（推定）・最大・使用・残りを送信数欄へまとめて表示する', async () => {
    render(<AccountsPage />)

    const summary = await screen.findByRole('region', { name: 'LINE公式の送信数' })
    expect(await within(summary).findByText('コミュニケーションプラン相当（推定）')).toBeTruthy()
    expect(within(summary).getByText('最大 200通')).toBeTruthy()
    expect(within(summary).getByText('使用 50通')).toBeTruthy()
    expect(within(summary).getByText('残り 150通')).toBeTruthy()
  })
})

describe('LINEアカウント管理の友だち統計', () => {
  it('総数・ブロック数・一斉送信可能数と定義、日次登録数を表示する', async () => {
    render(<AccountsPage />)

    const summary = await screen.findByRole('region', { name: '友だちの状況' })
    expect(within(summary).getByText('友だち総数')).toBeTruthy()
    expect(within(summary).getByText('12人')).toBeTruthy()
    expect(within(summary).getByText('ブロック数')).toBeTruthy()
    expect(within(summary).getByText('2人')).toBeTruthy()
    expect(within(summary).getByText('一斉送信可能数')).toBeTruthy()
    expect(within(summary).getByText('10人')).toBeTruthy()
    expect(within(summary).getByText(/ブロック数は、現在フォローしていない友だち/)).toBeTruthy()

    const trend = await screen.findByRole('region', { name: '友だち登録推移' })
    expect(apiMocks.getFriendTrend).toHaveBeenCalledWith('acc-1', 30)
    expect(within(trend).getByRole('figure', { name: '30日間の友だち登録推移' })).toBeTruthy()
    expect(within(trend).getByTitle('2026-07-22: 1人登録')).toBeTruthy()
    expect(within(trend).getByTitle('2026-07-23: 3人登録')).toBeTruthy()
    expect(within(trend).getByText(/管理画面に初めて登録された日ごとの人数/)).toBeTruthy()
  })

  it('90日表示へ切り替えて再取得する', async () => {
    render(<AccountsPage />)

    const trend = await screen.findByRole('region', { name: '友だち登録推移' })
    fireEvent.click(within(trend).getByRole('button', { name: '90日' }))

    await waitFor(() => {
      expect(apiMocks.getFriendTrend).toHaveBeenLastCalledWith('acc-1', 90)
    })
    expect(within(trend).getByRole('button', { name: '90日' }).getAttribute('aria-pressed')).toBe('true')
    expect(within(trend).getByRole('figure', { name: '90日間の友だち登録推移' })).toBeTruthy()
  })
})

describe('LINEアカウント管理の設定導線', () => {
  it('誤配線のスタッフ通知ボタンを出さず、既存メール差出人導線は維持する', async () => {
    render(<AccountsPage />)

    const emailButton = await screen.findByRole('button', {
      name: 'メール差出人',
    })
    expect(screen.queryByRole('button', {
      name: 'スタッフ通知(Chatwork/LINE)',
    })).toBeNull()

    fireEvent.click(emailButton)

    expect(
      screen.getByTestId('email-sender-settings-dialog').getAttribute('data-account-id'),
    ).toBe('acc-1')
  })
})
