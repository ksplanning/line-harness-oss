// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  tagsList: vi.fn(),
  selectedAccountId: 'acc-1',
}))

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: mocks.selectedAccountId }),
}))
vi.mock('@/lib/api', () => ({
  api: {
    broadcasts: {
      list: (...args: unknown[]) => mocks.list(...args),
      delete: vi.fn(),
      getInsight: vi.fn(async () => ({ success: true, data: null })),
      fetchInsight: vi.fn(),
    },
    tags: { list: (...args: unknown[]) => mocks.tagsList(...args) },
  },
}))
vi.mock('@/components/layout/header', () => ({ default: () => null }))
vi.mock('@/components/broadcasts/broadcast-form', () => ({ default: () => null }))
vi.mock('@/components/broadcasts/sender-preset-manager', () => ({ default: () => null }))
vi.mock('@/components/broadcasts/ab-test-panel', () => ({ default: () => null }))
vi.mock('@/components/broadcasts/segment-builder', () => ({ default: () => null }))
vi.mock('@/components/broadcasts/broadcast-detail', () => ({ default: () => null }))
vi.mock('@/components/broadcasts/broadcast-message-meta', () => ({ default: () => null }))
vi.mock('@/components/cc-prompt-button', () => ({ default: () => null }))

import BroadcastsPage from './page'

beforeEach(() => {
  mocks.selectedAccountId = 'acc-1'
  mocks.list.mockResolvedValue({
    success: true,
    data: [{
      id: 'broadcast-1',
      title: '詳細条件の配信',
      messageType: 'text',
      messageContent: 'hello',
      targetType: 'segment',
      targetTagId: null,
      segmentConditions: {
        operator: 'AND',
        rules: [{ type: 'tag_not_exists', value: 'tag-vip' }],
      },
      status: 'draft',
      scheduledAt: null,
      sentAt: null,
      totalCount: 0,
      successCount: 0,
      createdAt: '2026-07-23T00:00:00.000+09:00',
    }],
  })
  mocks.tagsList.mockResolvedValue({ success: true, data: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('broadcast list segment target', () => {
  it('shows 詳細条件 instead of a tag fallback', async () => {
    render(<BroadcastsPage />)
    await waitFor(() => expect(screen.getByText('詳細条件の配信')).toBeTruthy())
    expect(screen.getByText('詳細条件')).toBeTruthy()
    expect(screen.queryByText('タグ指定')).toBeNull()
  })

  it('P2の複数アカウント配信タブを出さず、左上アカウントの一覧だけを表示する', async () => {
    const view = render(<BroadcastsPage />)
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith({ accountId: 'acc-1' }))

    expect(screen.queryByRole('button', { name: /複アカ重複除外/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /単アカ配信/ })).toBeNull()

    mocks.selectedAccountId = 'acc-2'
    view.rerender(<BroadcastsPage />)
    await waitFor(() => expect(mocks.list).toHaveBeenLastCalledWith({
      accountId: 'acc-2',
    }))
  })
})
