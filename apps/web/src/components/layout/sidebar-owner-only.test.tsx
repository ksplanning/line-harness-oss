// @vitest-environment jsdom
/**
 * M1 (F6-1 / reviewer Round1) — Sidebar の owner 専用導線隠し。
 *   forms_advanced を持つ custom-role 非 owner に「フォーム連携キー」(/settings/formaloo-workspaces) を
 *   出さない (owner 専用判定を custom-role 分岐より先に評価する / spec §2 導線隠し)。
 *   フォームビルダー (/forms-advanced) は forms_advanced 権限で見えるので、両者の差で回帰を固定する。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'

const staffMe = vi.fn()
const legacyUsage = vi.fn()
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
    forms: { legacyUsage: (...a: unknown[]) => legacyUsage(...a) },
    inbox: { unanswered: { count: vi.fn().mockResolvedValue({ success: true, data: { total: 0 } }) } },
  },
}))

import Sidebar from './sidebar'

beforeEach(() => {
  // 既存 owner-only tests は legacy 利用ありのテナントとして導線を維持する。
  legacyUsage.mockResolvedValue({ success: true, data: { formCount: 1, submissionCount: 0 } })
})

afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('M1 Sidebar owner 専用導線', () => {
  it('integration/forms_advanced 持ち custom-role 非 owner に owner 専用連携導線を出さない', async () => {
    staffMe.mockResolvedValue({
      success: true,
      data: { id: 's1', name: 'x', role: 'staff', email: null, roleId: 'r1', permissions: ['forms_advanced', 'integration', 'friend', 'chat'] },
    })
    render(<Sidebar />)
    // 権限解決を待つ (forms_advanced 導線が出るのを起点にする)
    await waitFor(() => expect(screen.getAllByText('フォームビルダー').length).toBeGreaterThan(0))
    expect(screen.queryByText('高機能フォーム')).toBeNull()
    expect(document.querySelectorAll('a[href="/forms-advanced"]').length).toBeGreaterThan(0)
    // owner 専用リンクは非 owner には出ない
    expect(screen.queryByText('フォーム連携キー')).toBeNull()
    expect(document.querySelector('a[href="/settings/sheets"]')).toBeNull()
  })

  it('built-in owner にはフォーム連携キーと Sheets 同期設定を出す', async () => {
    staffMe.mockResolvedValue({
      success: true,
      data: { id: 'o1', name: 'owner', email: null, role: 'owner', roleId: null, permissions: [] },
    })
    render(<Sidebar />)
    await waitFor(() => expect(screen.getAllByText('フォーム連携キー').length).toBeGreaterThan(0))
    expect(document.querySelectorAll('a[href="/settings/sheets"]').length).toBeGreaterThan(0)
  })

  it('built-in staff (非 owner) にも owner 専用連携導線を出さない', async () => {
    staffMe.mockResolvedValue({
      success: true,
      data: { id: 's2', name: 'staff', email: null, role: 'staff', roleId: null, permissions: [] },
    })
    render(<Sidebar />)
    await waitFor(() => expect(screen.getAllByText('友だち管理').length).toBeGreaterThan(0))
    expect(screen.queryByText('フォーム連携キー')).toBeNull()
    expect(document.querySelector('a[href="/settings/sheets"]')).toBeNull()
  })
})

describe('D-1 Sidebar legacy フォーム回答の fail-safe 表示', () => {
  beforeEach(() => {
    staffMe.mockResolvedValue({
      success: true,
      data: { id: 'o1', name: 'owner', email: null, role: 'owner', roleId: null, permissions: [] },
    })
  })

  it('forms と submissions が共に 0 件なら「フォーム回答」を隠す', async () => {
    legacyUsage.mockResolvedValue({ success: true, data: { formCount: 0, submissionCount: 0 } })

    render(<Sidebar />)

    await waitFor(() => expect(legacyUsage).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.queryByText('フォーム回答')).toBeNull())
  })

  it.each([
    { formCount: 1, submissionCount: 0 },
    { formCount: 0, submissionCount: 1 },
  ])('legacy データが残る場合は「フォーム回答」を維持する (%o)', async (counts) => {
    legacyUsage.mockResolvedValue({ success: true, data: counts })

    render(<Sidebar />)

    await waitFor(() => expect(legacyUsage).toHaveBeenCalledOnce())
    expect(screen.getAllByText('フォーム回答').length).toBeGreaterThan(0)
  })

  it('利用実態 API が失敗した場合は安全側で「フォーム回答」を維持する', async () => {
    legacyUsage.mockRejectedValue(new Error('network unavailable'))

    render(<Sidebar />)

    await waitFor(() => expect(legacyUsage).toHaveBeenCalledOnce())
    expect(screen.getAllByText('フォーム回答').length).toBeGreaterThan(0)
  })
})
