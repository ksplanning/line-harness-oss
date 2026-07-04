// @vitest-environment jsdom
/**
 * visual-qa blocker 2 fix (F2 batch4 G2) — 送信が 429 通数上限でブロックされたら、汎用「送信に失敗しました」
 * ではなく送信ボタン付近に理由 + 対処 (今月◯通/上限△通・上限を変えるか来月まで) を行内表示する。
 * 純関数 test では表示層を検知できない教訓 (batch3 T-C8) ゆえ実レンダリングで assert。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

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
// 重い子コンポーネントは stub。SendConfirmDialog は onConfirm を即呼べる confirm ボタンに置換。
vi.mock('@/components/flex-preview', () => ({ default: () => null }))
vi.mock('@/components/broadcasts/test-send-section', () => ({ default: () => null }))
vi.mock('@/components/broadcasts/progress-bar', () => ({ default: () => null }))
vi.mock('@/components/broadcasts/segment-builder', () => ({ default: () => null }))
vi.mock('@/components/layout/header', () => ({ default: () => null }))
vi.mock('@/components/broadcasts/send-confirm-dialog', () => ({
  default: ({ onConfirm }: { onConfirm: () => void }) => <button onClick={onConfirm}>__confirm_send__</button>,
}))

import BroadcastDetail from './broadcast-detail'

const draft = { id: 'b1', title: 'E2E', messageType: 'text', messageContent: 'hi', targetType: 'all', targetTagId: null, status: 'draft', scheduledAt: null, sentAt: null, totalCount: 0, successCount: 0, createdAt: '2026-07-05T00:00:00.000+09:00' }

beforeEach(() => {
  m.get.mockResolvedValue({ success: true, data: draft })
  m.tagsList.mockResolvedValue({ success: true, data: [] })
  m.previewCount.mockResolvedValue({ success: true, count: 2 })
  m.getInsight.mockResolvedValue({ success: true, data: null })
  m.getProgress.mockResolvedValue({ success: true, data: { status: 'draft' } })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('broadcast-detail G2 cap-block inline message', () => {
  it('shows the inline cap message (reason + remedy) when send is blocked with 429', async () => {
    // send は fetchApi 相当で body 付き Error を throw する (429 通数上限)。
    const err = new Error('API error: 429') as Error & { status: number; body: unknown }
    err.status = 429
    err.body = { success: false, capBlocked: true, cap: { count: 0, cap: 0, pending: 2 } }
    m.send.mockRejectedValue(err)

    render(<BroadcastDetail broadcastId="b1" />)
    // まず実際の送信ボタンを押して確認ダイアログ (stub) を出す。
    await waitFor(() => expect(screen.getByText(/この配信を送信する/)).toBeTruthy())
    fireEvent.click(screen.getByText(/この配信を送信する/))
    await waitFor(() => expect(screen.getByText('__confirm_send__')).toBeTruthy())
    fireEvent.click(screen.getByText('__confirm_send__'))

    // 行内に理由 + 対処が出る (汎用「送信に失敗しました」ではない)。
    await waitFor(() => expect(screen.getByText(/今月の上限に達しています/)).toBeTruthy())
    expect(screen.getByText(/上限を変えるか来月まで/)).toBeTruthy()
    expect(screen.getByText(/テスト送信は上限の対象外/)).toBeTruthy()
    expect(screen.queryByText('送信に失敗しました')).toBeNull()
  })

  it('falls back to generic error for non-cap failures', async () => {
    const err = new Error('API error: 500') as Error & { status: number; body: unknown }
    err.status = 500
    err.body = { success: false, error: 'Internal server error' }
    m.send.mockRejectedValue(err)

    render(<BroadcastDetail broadcastId="b1" />)
    await waitFor(() => expect(screen.getByText(/この配信を送信する/)).toBeTruthy())
    fireEvent.click(screen.getByText(/この配信を送信する/))
    await waitFor(() => expect(screen.getByText('__confirm_send__')).toBeTruthy())
    fireEvent.click(screen.getByText('__confirm_send__'))
    await waitFor(() => expect(screen.getByText('送信に失敗しました')).toBeTruthy())
    expect(screen.queryByText(/今月の上限に達しています/)).toBeNull()
  })
})
