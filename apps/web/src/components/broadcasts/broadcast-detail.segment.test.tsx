// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  update: vi.fn(),
  previewCount: vi.fn(),
  tagsList: vi.fn(),
  send: vi.fn(),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccount: { id: 'acc-1', name: 'Account 1', displayName: 'Account 1' },
    accounts: [],
  }),
}))
vi.mock('@/lib/api', () => ({
  api: {
    broadcasts: {
      get: (...args: unknown[]) => mocks.get(...args),
      update: (...args: unknown[]) => mocks.update(...args),
      previewCount: (...args: unknown[]) => mocks.previewCount(...args),
      getInsight: vi.fn(async () => ({ success: true, data: null })),
      getProgress: vi.fn(async () => ({ success: true, data: { status: 'draft' } })),
      perAccountStats: vi.fn(async () => ({ success: true, data: [] })),
      send: (...args: unknown[]) => mocks.send(...args),
    },
    tags: { list: (...args: unknown[]) => mocks.tagsList(...args) },
  },
}))
vi.mock('@/components/flex-preview', () => ({ default: () => null }))
vi.mock('./test-send-section', () => ({ default: () => null }))
vi.mock('./progress-bar', () => ({ default: () => null }))
vi.mock('@/components/layout/header', () => ({ default: () => null }))
vi.mock('./send-confirm-dialog', () => ({ default: () => null }))
vi.mock('./segment-builder', () => ({
  default: ({
    initialConditions,
    onApply,
  }: {
    initialConditions?: unknown
    onApply: (conditions: unknown) => void
  }) => (
    <div data-testid="segment-builder" data-initial={JSON.stringify(initialConditions)}>
      <button
        type="button"
        onClick={() => onApply({
          operator: 'AND',
          rules: [{ type: 'metadata_not_empty', value: { key: '会員ランク' } }],
        })}
      >
        __save_segment__
      </button>
    </div>
  ),
}))

import BroadcastDetail from './broadcast-detail'

const initialConditions = {
  operator: 'AND',
  rules: [
    { type: 'tag_not_exists', value: 'tag-vip' },
    { type: 'metadata_equals', value: { key: '会員ランク', value: 'gold' } },
  ],
}

const segmentBroadcast = {
  id: 'broadcast-1',
  title: '詳細条件の配信',
  messageType: 'text',
  messageContent: 'hello',
  lineAccountId: 'acc-1',
  messages: null,
  targetType: 'segment',
  targetTagId: null,
  segmentConditions: initialConditions,
  status: 'draft',
  scheduledAt: null,
  sentAt: null,
  totalCount: 0,
  successCount: 0,
  createdAt: '2026-07-23T00:00:00.000+09:00',
}

beforeEach(() => {
  mocks.get.mockResolvedValue({ success: true, data: segmentBroadcast })
  mocks.update.mockResolvedValue({ success: true, data: segmentBroadcast })
  mocks.previewCount.mockResolvedValue({ success: true, data: { count: 4 } })
  mocks.tagsList.mockResolvedValue({ success: true, data: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('BroadcastDetail segment target', () => {
  it('labels a segment target and restores its saved conditions into SegmentBuilder', async () => {
    render(<BroadcastDetail broadcastId="broadcast-1" />)
    await waitFor(() => expect(screen.getByText('詳細条件')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'セグメント条件を編集' }))
    const builder = screen.getByTestId('segment-builder')
    expect(JSON.parse(builder.getAttribute('data-initial') ?? 'null')).toEqual(initialConditions)
  })

  it('updates with a typed condition object instead of a JSON string', async () => {
    render(<BroadcastDetail broadcastId="broadcast-1" />)
    fireEvent.click(await screen.findByRole('button', { name: 'セグメント条件を編集' }))
    fireEvent.click(screen.getByRole('button', { name: '__save_segment__' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('broadcast-1', {
      segmentConditions: {
        operator: 'AND',
        rules: [{ type: 'metadata_not_empty', value: { key: '会員ランク' } }],
      },
    }))
  })

  it('blocks conditional sending until preview succeeds and offers a retry after failure', async () => {
    mocks.previewCount
      .mockRejectedValueOnce(new Error('preview unavailable'))
      .mockResolvedValueOnce({ success: true, data: { count: 4 } })

    render(<BroadcastDetail broadcastId="broadcast-1" />)

    const sendButton = await screen.findByRole('button', { name: 'この配信を送信する' })
    await waitFor(() => expect((sendButton as HTMLButtonElement).disabled).toBe(true))
    expect(screen.getByText(/誤配信防止のため送信を停止/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '再試行' }))
    await waitFor(() => expect((
      screen.getByRole('button', { name: 'この配信を送信する (4人)' }) as HTMLButtonElement
    ).disabled).toBe(false))
    expect(mocks.previewCount).toHaveBeenCalledTimes(2)
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it('refreshes a draft conditional preview instead of trusting a stale total from an earlier attempt', async () => {
    mocks.get.mockResolvedValue({
      success: true,
      data: { ...segmentBroadcast, totalCount: 99 },
    })
    mocks.previewCount.mockResolvedValue({ success: true, data: { count: 4 } })

    render(<BroadcastDetail broadcastId="broadcast-1" />)

    expect(await screen.findByRole(
      'button',
      { name: 'この配信を送信する (4人)' },
    )).toBeTruthy()
    expect(screen.queryByRole(
      'button',
      { name: 'この配信を送信する (99人)' },
    )).toBeNull()
  })
})
