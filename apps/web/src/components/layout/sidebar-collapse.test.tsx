// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  pathname: '/broadcasts',
  staffMe: vi.fn(),
  legacyUsage: vi.fn(),
  unansweredCount: vi.fn(),
  unansweredTotal: 0,
}))

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => <a href={href}>{children}</a>,
}))
vi.mock('next/navigation', () => ({ usePathname: () => mocks.pathname }))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ accounts: [], selectedAccount: null, setSelectedAccountId: vi.fn(), loading: false }),
}))
vi.mock('@/lib/api', () => ({
  api: {
    staff: { me: (...args: unknown[]) => mocks.staffMe(...args) },
    forms: { legacyUsage: (...args: unknown[]) => mocks.legacyUsage(...args) },
    inbox: { unanswered: { count: (...args: unknown[]) => mocks.unansweredCount(...args) } },
  },
}))

import Sidebar from './sidebar'

const STORAGE_KEY = 'line-harness:sidebar-expanded-sections'
const SECTION_LABELS = ['配信', '分析', '自動化', '予約', '設定']

function sectionButtons(label: string): HTMLButtonElement[] {
  return screen.getAllByRole('button', { name: label }) as HTMLButtonElement[]
}

function expectSectionExpanded(label: string, expanded: boolean): void {
  const buttons = sectionButtons(label)
  expect(buttons).toHaveLength(2)
  for (const button of buttons) {
    expect(button.getAttribute('aria-expanded')).toBe(String(expanded))
    expect(button.className).toContain('min-h-[44px]')
  }
}

beforeEach(() => {
  mocks.pathname = '/broadcasts'
  window.localStorage.clear()
  mocks.staffMe.mockResolvedValue({
    success: true,
    data: { id: 'owner-1', name: 'owner', email: null, role: 'owner', roleId: null, permissions: [] },
  })
  mocks.legacyUsage.mockResolvedValue({ success: true, data: { formCount: 1, submissionCount: 0 } })
  mocks.unansweredCount.mockReset()
  mocks.unansweredTotal = 0
  mocks.unansweredCount.mockImplementation(async () => ({
    success: true,
    data: { total: mocks.unansweredTotal },
  }))
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Sidebar セクション折りたたみ', () => {
  it('保存値がなければ現用ルートを含むラベル付きセクションだけを展開する', () => {
    render(<Sidebar />)

    expectSectionExpanded('配信', true)
    for (const label of SECTION_LABELS.filter((label) => label !== '配信')) {
      expectSectionExpanded(label, false)
    }
    expect(screen.getAllByText('一斉配信')).toHaveLength(2)
    expect(screen.queryByRole('link', { name: 'CV計測' })).toBeNull()
  })

  it('保存値がなければ内部遷移後も現用セクションだけへ追従する', async () => {
    const { rerender } = render(<Sidebar />)

    expectSectionExpanded('配信', true)
    expectSectionExpanded('分析', false)

    mocks.pathname = '/conversions'
    rerender(<Sidebar />)

    await waitFor(() => expectSectionExpanded('配信', false))
    expectSectionExpanded('分析', true)
    expect(screen.queryByRole('link', { name: '一斉配信' })).toBeNull()
    expect(screen.getAllByRole('link', { name: 'CV計測' })).toHaveLength(2)
  })

  it('主要3ルートではラベル付き5セクションを全て閉じ、主要リンクは常時表示する', () => {
    mocks.pathname = '/friends'

    render(<Sidebar />)

    for (const label of SECTION_LABELS) expectSectionExpanded(label, false)
    expect(screen.getAllByText('ダッシュボード')).toHaveLength(2)
    expect(screen.getAllByText('友だち管理')).toHaveLength(2)
    expect(screen.getAllByText('個別チャット')).toHaveLength(2)
    expect(screen.queryByRole('link', { name: '一斉配信' })).toBeNull()
  })

  it('未対応を個別チャット直下に置き、自動化から外して旧URLを維持する', () => {
    mocks.pathname = '/notifications'

    render(<Sidebar />)

    const navs = screen.getAllByRole('navigation')
    expect(navs).toHaveLength(2)
    for (const nav of navs) {
      const hrefs = [...nav.querySelectorAll('a')].map((link) => link.getAttribute('href'))
      const chatsIndex = hrefs.indexOf('/chats')
      expect(chatsIndex).toBeGreaterThanOrEqual(0)
      expect(hrefs[chatsIndex + 1]).toBe('/notifications')
    }

    const automationButtons = screen.getAllByRole('button', { name: '自動化' })
    fireEvent.click(automationButtons[0])
    for (const button of automationButtons) {
      expect(button.parentElement?.querySelector('a[href="/notifications"]')).toBeNull()
    }

    const legacyLinks = screen.getAllByRole('link', { name: '未対応' })
    expect(legacyLinks).toHaveLength(2)
    for (const link of legacyLinks) expect(link.getAttribute('href')).toBe('/notifications')
  })

  it('画面遷移時に正本 count を再取得し、自動応答後の古い数字を残さない', async () => {
    mocks.unansweredTotal = 1

    const { rerender } = render(<Sidebar />)
    await waitFor(() => expect(screen.getAllByText('1')).toHaveLength(2))

    mocks.unansweredTotal = 0
    mocks.pathname = '/chats'
    rerender(<Sidebar />)

    await waitFor(() => expect(mocks.unansweredCount).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText('1')).toBeNull())
  })

  it('windowへfocusを戻した時も正本 count を再取得する', async () => {
    mocks.unansweredTotal = 1

    render(<Sidebar />)
    await waitFor(() => expect(screen.getAllByText('1')).toHaveLength(2))

    mocks.unansweredTotal = 0
    window.dispatchEvent(new Event('focus'))

    await waitFor(() => expect(mocks.unansweredCount).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText('1')).toBeNull())
  })

  it('見出しごとに独立して開閉し、既知のセクションid配列を保存する', () => {
    render(<Sidebar />)

    fireEvent.click(sectionButtons('分析')[0])
    expectSectionExpanded('配信', true)
    expectSectionExpanded('分析', true)
    expect(screen.getAllByRole('link', { name: 'CV計測' })).toHaveLength(2)
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual(['delivery', 'analytics'])

    fireEvent.click(sectionButtons('配信')[0])
    expectSectionExpanded('配信', false)
    expectSectionExpanded('分析', true)
    expect(screen.queryByRole('link', { name: '一斉配信' })).toBeNull()
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual(['analytics'])
  })

  it('保存済みの開閉状態を初期状態で上書きせず復元する', async () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['analytics', 'settings']))

    render(<Sidebar />)

    await waitFor(() => expectSectionExpanded('配信', false))
    expectSectionExpanded('分析', true)
    expectSectionExpanded('設定', true)
    expect(screen.queryByRole('link', { name: '一斉配信' })).toBeNull()
    expect(screen.getAllByRole('link', { name: 'CV計測' })).toHaveLength(2)
    expect(screen.getAllByRole('link', { name: 'BAN検知' })).toHaveLength(2)
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual(['analytics', 'settings'])
  })

  it.each([
    '{broken json',
    JSON.stringify(['analytics', 'unknown-section']),
    JSON.stringify({ analytics: true }),
  ])('不正な保存値は現用セクションだけの初期状態へ戻す: %s', async (stored) => {
    window.localStorage.setItem(STORAGE_KEY, stored)

    render(<Sidebar />)

    await waitFor(() => expectSectionExpanded('配信', true))
    expectSectionExpanded('分析', false)
    expect(screen.getAllByText('一斉配信')).toHaveLength(2)
    expect(screen.queryByRole('link', { name: 'CV計測' })).toBeNull()
  })
})
