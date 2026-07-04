// @vitest-environment jsdom
/**
 * T-C9 / A2 / A3 (F2 batch4 G1) — A/B UI: 作成 (名前+指標ラジオ) / 分割プレビュー (送信しない注記) /
 * 比較 (勝ちハイライト・同点・データ取得待ち) / 勝ち→残りへ下書き作成 (すぐ送らない)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const m = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), split: vi.fn(), compare: vi.fn(), winnerDraft: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { abTests: {
    list: (...a: unknown[]) => m.list(...a),
    create: (...a: unknown[]) => m.create(...a),
    splitPreview: (...a: unknown[]) => m.split(...a),
    compare: (...a: unknown[]) => m.compare(...a),
    winnerDraft: (...a: unknown[]) => m.winnerDraft(...a),
  } },
}))

import AbTestPanel from './ab-test-panel'

beforeEach(() => {
  m.list.mockResolvedValue({ success: true, data: [{ id: 't1', name: '春A/B', metric: 'open_rate', status: 'draft', winnerBroadcastId: null }] })
  m.create.mockResolvedValue({ success: true, data: { id: 't2' } })
  m.split.mockResolvedValue({ success: true, data: { total: 5, counts: { A: 3, B: 2 } }, note: 'x' })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('AbTestPanel (G1)', () => {
  it('creates a test with name + metric radio (no send)', async () => {
    render(<AbTestPanel accountId="acc-1" />)
    await waitFor(() => screen.getByText(/春A\/B/))
    fireEvent.change(screen.getByLabelText('A/Bテスト名'), { target: { value: '夏A/B' } })
    fireEvent.click(screen.getByLabelText('クリック率で比べる'))
    fireEvent.click(screen.getByText('作成'))
    await waitFor(() => expect(m.create).toHaveBeenCalledWith('acc-1', { name: '夏A/B', metric: 'click_rate' }))
  })

  it('split preview shows 案A/案B counts + "does not send" note', async () => {
    render(<AbTestPanel accountId="acc-1" conditions={{ operator: 'AND', rules: [] }} />)
    await waitFor(() => screen.getByText(/春A\/B/))
    fireEvent.click(screen.getByText('分割プレビュー'))
    await waitFor(() => expect(screen.getByText(/案A：3人/)).toBeTruthy())
    expect(screen.getByText(/案B：2人/)).toBeTruthy()
    expect(screen.getByText(/実際に送るのは owner 確認後/)).toBeTruthy()
  })

  it('compare highlights the winner and offers a winner-draft button (draft only)', async () => {
    m.compare.mockResolvedValue({ success: true, data: { metric: 'open_rate', variants: [{ variant: 'A', openRate: 0.4, clickRate: 0.1 }, { variant: 'B', openRate: 0.6, clickRate: 0.05 }], winner: 'B', tie: false, dataPending: false } })
    m.winnerDraft.mockResolvedValue({ success: true, data: { draftBroadcastId: 'd1' } })
    render(<AbTestPanel accountId="acc-1" />)
    await waitFor(() => screen.getByText(/春A\/B/))
    fireEvent.click(screen.getByText('比較'))
    await waitFor(() => expect(screen.getByText(/案B（勝ち）/)).toBeTruthy())
    const btn = screen.getByText(/残りに配信する下書きを作成（すぐには送りません）/)
    fireEvent.click(btn)
    await waitFor(() => expect(m.winnerDraft).toHaveBeenCalledWith('t1', 'acc-1', 'B'))
  })

  it('compare shows "データ取得待ち" when insight not populated (crons=[] dark)', async () => {
    m.compare.mockResolvedValue({ success: true, data: { metric: 'open_rate', variants: [], winner: null, tie: false, dataPending: true } })
    render(<AbTestPanel accountId="acc-1" />)
    await waitFor(() => screen.getByText(/春A\/B/))
    fireEvent.click(screen.getByText('比較'))
    await waitFor(() => expect(screen.getByText(/データ取得待ち/)).toBeTruthy())
  })

  it('compare shows 引き分け on a tie', async () => {
    m.compare.mockResolvedValue({ success: true, data: { metric: 'open_rate', variants: [{ variant: 'A', openRate: 0.5, clickRate: 0.1 }, { variant: 'B', openRate: 0.5, clickRate: 0.2 }], winner: null, tie: true, dataPending: false } })
    render(<AbTestPanel accountId="acc-1" />)
    await waitFor(() => screen.getByText(/春A\/B/))
    fireEvent.click(screen.getByText('比較'))
    await waitFor(() => expect(screen.getByText(/引き分け/)).toBeTruthy())
  })
})
