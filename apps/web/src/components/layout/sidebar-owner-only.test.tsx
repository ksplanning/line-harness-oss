// @vitest-environment jsdom
/**
 * M1 (F6-1 / reviewer Round1) — Sidebar の owner 専用導線隠し。
 *   forms_advanced を持つ custom-role 非 owner に「フォーム連携キー」(/settings/formaloo-workspaces) を
 *   出さない (owner 専用判定を custom-role 分岐より先に評価する / spec §2 導線隠し)。
 *   高機能フォーム (/forms-advanced) は forms_advanced 権限で見えるので、両者の差で回帰を固定する。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'

const staffMe = vi.fn()
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))
vi.mock('next/navigation', () => ({ usePathname: () => '/' }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ accounts: [], selectedAccount: null, setSelectedAccountId: vi.fn(), loading: false }),
}))
vi.mock('@/lib/api', () => ({
  api: {
    staff: { me: (...a: unknown[]) => staffMe(...a) },
    inbox: { unanswered: { count: vi.fn().mockResolvedValue({ success: true, data: { total: 0 } }) } },
  },
}))

import Sidebar from './sidebar'

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('M1 Sidebar owner 専用導線', () => {
  it('forms_advanced 持ち custom-role 非 owner に「フォーム連携キー」を出さない (高機能フォームは出る)', async () => {
    staffMe.mockResolvedValue({
      success: true,
      data: { id: 's1', name: 'x', role: 'staff', email: null, roleId: 'r1', permissions: ['forms_advanced', 'friend', 'chat'] },
    })
    render(<Sidebar />)
    // 権限解決を待つ (forms_advanced 導線が出るのを起点にする)
    await waitFor(() => expect(screen.getAllByText('高機能フォーム').length).toBeGreaterThan(0))
    // owner 専用リンクは非 owner には出ない
    expect(screen.queryByText('フォーム連携キー')).toBeNull()
  })

  it('built-in owner には「フォーム連携キー」を出す', async () => {
    staffMe.mockResolvedValue({
      success: true,
      data: { id: 'o1', name: 'owner', email: null, role: 'owner', roleId: null, permissions: [] },
    })
    render(<Sidebar />)
    await waitFor(() => expect(screen.getAllByText('フォーム連携キー').length).toBeGreaterThan(0))
  })

  it('built-in staff (非 owner) にも「フォーム連携キー」を出さない', async () => {
    staffMe.mockResolvedValue({
      success: true,
      data: { id: 's2', name: 'staff', email: null, role: 'staff', roleId: null, permissions: [] },
    })
    render(<Sidebar />)
    await waitFor(() => expect(screen.getAllByText('友だち管理').length).toBeGreaterThan(0))
    expect(screen.queryByText('フォーム連携キー')).toBeNull()
  })
})
