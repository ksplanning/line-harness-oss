// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'

const apiMocks = vi.hoisted(() => ({
  list: vi.fn(),
  getQuota: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    lineAccounts: {
      list: apiMocks.list,
      getQuota: apiMocks.getQuota,
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
      stats: { friendCount: 10, activeScenarios: 1, messagesThisMonth: 50 },
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
