// @vitest-environment jsdom
/**
 * ダッシュボードの権限出し分け (G64 fold-in ①) — browser-evaluator が検出した stat card /
 * クイックアクションの permission 参照漏れを固定。chat-only ロールでは配信/シナリオ/BAN 検知が
 * 消え、owner (built-in) では全て出る。enforcement は worker が正典 (ここは UX)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, within } from '@testing-library/react'

const staffMe = vi.fn()
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1', selectedAccount: { id: 'acc-1', name: 'A', displayName: 'A' } }),
}))
vi.mock('@/components/cc-prompt-button', () => ({ default: () => null }))
vi.mock('@/lib/api', () => ({
  api: {
    friends: { count: vi.fn().mockResolvedValue({ success: true, data: { count: 3 } }) },
    scenarios: { list: vi.fn().mockResolvedValue({ success: true, data: [] }) },
    broadcasts: { list: vi.fn().mockResolvedValue({ success: true, data: [] }) },
    templates: { list: vi.fn().mockResolvedValue({ success: true, data: [] }) },
    automations: { list: vi.fn().mockResolvedValue({ success: true, data: [] }) },
    scoring: { rules: vi.fn().mockResolvedValue({ success: true, data: [] }) },
    staff: { me: (...a: unknown[]) => staffMe(...a) },
  },
}))

import DashboardPage from './page'

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('ダッシュボード権限出し分け (fold-in ①)', () => {
  it('chat-only custom role: 配信/シナリオ/スコアリング/BAN 検知が消え、友だち/チャットは出る', async () => {
    staffMe.mockResolvedValue({
      success: true,
      data: { id: 's1', name: 'x', role: 'staff', email: null, roleId: 'r1', permissions: ['chat', 'friend'] },
    })
    render(<DashboardPage />)
    await waitFor(() => expect(screen.getByText('友だち数')).toBeTruthy())

    // 許可 feature の導線は出る
    expect(screen.getByText('友だち数')).toBeTruthy()
    expect(screen.getByText('チャット')).toBeTruthy()
    // 禁止 feature の stat card / クイックアクションは消える
    expect(screen.queryByText('配信数 (合計)')).toBeNull()
    expect(screen.queryByText('アクティブシナリオ数')).toBeNull()
    expect(screen.queryByText('スコアリングルール数')).toBeNull()
    expect(screen.queryByText('一斉配信')).toBeNull()
    expect(screen.queryByText('BAN検知')).toBeNull()
  })

  it('owner (built-in): 全 stat card / クイックアクションが出る', async () => {
    staffMe.mockResolvedValue({
      success: true,
      data: {
        id: 'o1', name: 'owner', role: 'owner', email: null, roleId: null,
        permissions: ['chat', 'broadcast', 'scenario', 'friend', 'analytics', 'template', 'system_update'],
      },
    })
    render(<DashboardPage />)
    await waitFor(() => expect(screen.getByText('友だち数')).toBeTruthy())
    expect(screen.getByText('配信数 (合計)')).toBeTruthy()
    expect(screen.getByText('アクティブシナリオ数')).toBeTruthy()
    expect(screen.getByText('スコアリングルール数')).toBeTruthy()
    expect(screen.getByText('一斉配信')).toBeTruthy()
    expect(screen.getByText('BAN検知')).toBeTruthy()
  })

  it('staff.me 失敗時は built-in フォールバックで全表示 (degrade しない)', async () => {
    staffMe.mockRejectedValue(new Error('network'))
    render(<DashboardPage />)
    await waitFor(() => expect(screen.getByText('友だち数')).toBeTruthy())
    expect(screen.getByText('配信数 (合計)')).toBeTruthy()
    expect(screen.getByText('一斉配信')).toBeTruthy()
  })
})
