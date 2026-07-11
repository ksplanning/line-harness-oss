// @vitest-environment jsdom
/**
 * combo test-send UX (broadcast-combo-messages Batch 2) — combo 配信のテスト送信は worker が 400
 * で拒否する (Batch 1) ため、UI は silent 失敗させず「今後対応」を明示して送信ボタンを出さない。
 * single 配信は従来どおりテスト送信ボタンが出る。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'

const { getRecipients, testSend } = vi.hoisted(() => ({ getRecipients: vi.fn(), testSend: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: {
    accountSettings: { getTestRecipients: (...a: unknown[]) => getRecipients(...a) },
    broadcasts: { testSend: (...a: unknown[]) => testSend(...a) },
  },
}))

import TestSendSection from './test-send-section'

beforeEach(() => {
  getRecipients.mockReset(); testSend.mockReset()
  getRecipients.mockResolvedValue({ success: true, data: [{ id: 'u1', displayName: 'テスター', pictureUrl: null }] })
})
afterEach(() => cleanup())

describe('TestSendSection combo UX', () => {
  it('single 配信: テスト送信ボタンが出る', async () => {
    render(<TestSendSection broadcastId="b1" accountId="acc-1" disabled={false} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'テスト送信する' })).toBeTruthy())
  })

  it('combo 配信: 送信ボタンを出さず「今後対応」を明示 (silent 失敗にしない)', async () => {
    render(<TestSendSection broadcastId="b1" accountId="acc-1" disabled={false} isCombo />)
    await waitFor(() => expect(screen.getByText(/組み合わせ配信.*テスト送信は今後対応/)).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'テスト送信する' })).toBeNull()
  })
})
