// @vitest-environment jsdom
/**
 * U6 (broadcast-combo-messages Batch 2) — 詳細で combo の 2-5 通目の存在を認識できる。
 *  - プレビューが全 N 通を順序どおり列挙 (先頭ミラーだけの「1通」表示にしない)
 *  - 配信設定に「組み合わせ N通」を表示
 *  - TestSendSection に isCombo=true を渡す (combo テスト送信の silent 失敗回避)
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
// TestSendSection は isCombo プロップを echo するスタブに (詳細が isCombo を渡すことを検証)。
vi.mock('@/components/broadcasts/test-send-section', () => ({ default: ({ isCombo }: { isCombo?: boolean }) => <div>combo:{String(!!isCombo)}</div> }))
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
  it('プレビューが全2通を順序どおり列挙し、設定に組み合わせ表示、test-send に isCombo=true を渡す', async () => {
    render(<BroadcastDetail broadcastId="b1" />)
    await waitFor(() => expect(screen.getByText(/全2通/)).toBeTruthy())
    expect(screen.getByText(/1通目・テキスト/)).toBeTruthy()
    expect(screen.getByText(/2通目・画像/)).toBeTruthy()
    expect(screen.getByText('一通目')).toBeTruthy()
    expect(screen.getByText(/組み合わせ 2通/)).toBeTruthy()
    expect(screen.getByText('combo:true')).toBeTruthy()
  })
})
