// @vitest-environment jsdom
/**
 * U6 (broadcast-combo-messages Batch 2) — 詳細で combo の 2-5 通目の存在を認識できる。
 *  - プレビューが全 N 通を順序どおり列挙 (先頭ミラーだけの「1通」表示にしない)
 *  - 配信設定に「組み合わせ N通」を表示
 *  - TestSendSection に全メッセージと送信対象アカウントを渡す
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'

const m = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn(), previewCount: vi.fn(), getInsight: vi.fn(), getProgress: vi.fn(), tagsList: vi.fn() }))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), refresh: vi.fn() }) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccount: { id: 'acc-1', name: 'A', displayName: 'A' }, accounts: [] }) }))
vi.mock('@/lib/api', () => ({
  api: {
    broadcasts: {
      get: (...a: unknown[]) => m.get(...a),
      send: (...a: unknown[]) => m.send(...a),
      previewCount: (...a: unknown[]) => m.previewCount(...a),
      getInsight: (...a: unknown[]) => m.getInsight(...a),
      getProgress: (...a: unknown[]) => m.getProgress(...a),
      perAccountStats: vi.fn(async () => ({ success: true, data: [] })),
      update: vi.fn(async () => ({ success: true })),
    },
    tags: { list: (...a: unknown[]) => m.tagsList(...a) },
  },
}))
vi.mock('@/components/flex-preview', () => ({ default: () => null }))
vi.mock('@/components/broadcasts/test-send-section', () => ({
  default: ({ accountIds, messages, senderPresetId }: { accountIds: string[]; messages: Array<{ type: string; content: string }>; senderPresetId?: string | null }) => (
    <div data-testid="test-send-props" data-account-ids={accountIds.join(',')} data-messages={JSON.stringify(messages)} data-sender-preset-id={senderPresetId ?? ''} />
  ),
}))
vi.mock('@/components/broadcasts/progress-bar', () => ({ default: () => null }))
vi.mock('@/components/broadcasts/segment-builder', () => ({ default: () => null }))
vi.mock('@/components/layout/header', () => ({ default: () => null }))
vi.mock('@/components/broadcasts/send-confirm-dialog', () => ({ default: () => null }))

import BroadcastDetail from './broadcast-detail'

const combo = {
  id: 'b1', title: 'combo', messageType: 'text', messageContent: '一通目', lineAccountId: 'acc-1',
  messages: [
    { type: 'text', content: '一通目' },
    { type: 'image', content: '{"originalContentUrl":"https://img/x.png","previewImageUrl":"https://img/x.png"}' },
  ],
  targetType: 'all', targetTagId: null, status: 'draft', scheduledAt: null, sentAt: null,
  totalCount: 0, successCount: 0, createdAt: '2026-07-11T00:00:00.000+09:00',
}

beforeEach(() => {
  m.get.mockResolvedValue({ success: true, data: combo })
  m.tagsList.mockResolvedValue({ success: true, data: [] })
  m.previewCount.mockResolvedValue({ success: true, count: 2 })
  m.getInsight.mockResolvedValue({ success: true, data: null })
  m.getProgress.mockResolvedValue({ success: true, data: { status: 'draft' } })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('broadcast-detail combo (U6)', () => {
  it('プレビューが全2通を列挙し、テスト送信にも全メッセージを順番どおり渡す', async () => {
    render(<BroadcastDetail broadcastId="b1" />)
    await waitFor(() => expect(screen.getByText(/全2通/)).toBeTruthy())
    expect(screen.getByText(/1通目・テキスト/)).toBeTruthy()
    expect(screen.getByText(/2通目・画像/)).toBeTruthy()
    expect(screen.getByText('一通目')).toBeTruthy()
    expect(screen.getByText(/組み合わせ 2通/)).toBeTruthy()
    const testSend = screen.getByTestId('test-send-props')
    expect(testSend.getAttribute('data-account-ids')).toBe('acc-1')
    expect(JSON.parse(testSend.getAttribute('data-messages') ?? '[]')).toEqual(combo.messages)
  })

  it('従来singleの altText とaccount-scoped送信者presetをテスト送信へ保つ', async () => {
    m.get.mockResolvedValue({
      success: true,
      data: {
        ...combo,
        messageType: 'flex',
        messageContent: '{"type":"bubble","body":{"type":"box","layout":"vertical","contents":[]}}',
        messages: null,
        altText: '通知テキスト',
        senderPresetId: 'preset-1',
      },
    })
    render(<BroadcastDetail broadcastId="b1" />)
    const testSend = await screen.findByTestId('test-send-props')
    expect(JSON.parse(testSend.getAttribute('data-messages') ?? '[]')).toEqual([{
      type: 'flex',
      content: '{"type":"bubble","body":{"type":"box","layout":"vertical","contents":[]}}',
      altText: '通知テキスト',
    }])
    expect(testSend.getAttribute('data-sender-preset-id')).toBe('preset-1')
  })
})
