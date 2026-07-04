// @vitest-environment jsdom
/**
 * T-C10 / A4-A5 (F2 batch4 G2) — 上限設定 UI の render + 進捗 + 接近警告 + ブロック表示 + 保存 payload。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const { getMock, updateMock } = vi.hoisted(() => ({ getMock: vi.fn(), updateMock: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: { lineAccounts: { getMonthlyCap: (...a: unknown[]) => getMock(...a), updateMonthlyCap: (...a: unknown[]) => updateMock(...a) } },
}))

import MonthlyCapSettings from './monthly-cap-settings'

beforeEach(() => { updateMock.mockResolvedValue({ success: true, data: { monthlyCap: 500 } }) })
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('MonthlyCapSettings (G2)', () => {
  it('shows progress 今月/上限 and the test-send-exempt note', async () => {
    getMock.mockResolvedValue({ success: true, data: { monthlyCap: 100, messagesThisMonth: 50, remaining: 50 } })
    render(<MonthlyCapSettings accountId="acc-1" />)
    await waitFor(() => expect(screen.getByText(/今月 50 \/ 上限 100 通/)).toBeTruthy())
    expect(screen.getByText(/テスト送信は上限の対象外/)).toBeTruthy()
  })

  it('shows approaching warning at >= 80%', async () => {
    getMock.mockResolvedValue({ success: true, data: { monthlyCap: 100, messagesThisMonth: 85, remaining: 15 } })
    render(<MonthlyCapSettings accountId="acc-1" />)
    await waitFor(() => expect(screen.getByText(/上限に近づいています/)).toBeTruthy())
  })

  it('shows blocked message when count >= cap', async () => {
    getMock.mockResolvedValue({ success: true, data: { monthlyCap: 100, messagesThisMonth: 100, remaining: 0 } })
    render(<MonthlyCapSettings accountId="acc-1" />)
    await waitFor(() => expect(screen.getByText(/今月の上限に達しています/)).toBeTruthy())
  })

  it('unlimited (cap null) shows 上限なし and no bar', async () => {
    getMock.mockResolvedValue({ success: true, data: { monthlyCap: null, messagesThisMonth: 999, remaining: null } })
    render(<MonthlyCapSettings accountId="acc-1" />)
    await waitFor(() => expect(screen.getByText(/上限なし/)).toBeTruthy())
    expect(screen.getByText(/未設定なら無制限/)).toBeTruthy()
  })

  it('saving with cap enabled sends the integer; disabling sends null', async () => {
    getMock.mockResolvedValue({ success: true, data: { monthlyCap: null, messagesThisMonth: 0, remaining: null } })
    render(<MonthlyCapSettings accountId="acc-1" />)
    await waitFor(() => screen.getByText('保存'))
    // enable + type 300 + save
    fireEvent.click(screen.getByLabelText('月の上限を設定する'))
    fireEvent.change(screen.getByLabelText('月の上限通数'), { target: { value: '300' } })
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(updateMock).toHaveBeenCalledWith('acc-1', 300))
  })
})
