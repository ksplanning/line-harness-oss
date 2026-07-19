// @vitest-environment jsdom
/**
 * T-C11 (F2 batch4 G17) — rich-menus 一覧に「期間限定」バッジが出る (schedule_start/end 保有 group)。
 * バッジは edit 画面だけでなく一覧にも要る (closer 独立検証で一覧欠落を検出)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'

const m = vi.hoisted(() => ({ list: vi.fn(), external: vi.fn(), panelProps: vi.fn() }))
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccount: { id: 'acc-1', name: 'A' } }) }))
vi.mock('@/components/layout/header', () => ({ default: () => null }))
vi.mock('@/components/rich-menus/tap-analytics-panel', () => ({ default: () => null }))
vi.mock('@/components/rich-menus/apply-to-tag-modal', () => ({ ApplyToTagModal: () => null }))
vi.mock('@/components/rich-menus/display-rule-panel', () => ({
  DisplayRulePanel: (props: unknown) => {
    m.panelProps(props)
    return <div>条件ルール接続済み</div>
  },
}))
vi.mock('@/lib/api', () => ({ api: { richMenuGroups: {
  list: (...a: unknown[]) => m.list(...a),
  external: (...a: unknown[]) => m.external(...a),
  externalImageUrl: () => 'https://images.example.test/menu',
} } }))

import RichMenusListPage from './page'

const grp = (over: Partial<Record<string, unknown>>) => ({
  id: 'g', name: 'メニュー', chatBarText: 'bar', size: 'large', status: 'draft', isDefaultForAll: false,
  scheduleStart: null, scheduleEnd: null, thumbnailR2Key: null, updatedAt: '2026-07-05T00:00:00+09:00', ...over,
})

beforeEach(() => {
  m.external.mockResolvedValue({ success: true, data: { currentDefault: null, lineMenus: [] } })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('rich-menus list 期間限定 badge', () => {
  it('shows the badge for a group with a schedule and not for a plain group', async () => {
    m.list.mockResolvedValue({ success: true, data: [
      grp({ id: 'scheduled', name: '春キャンペーン', scheduleStart: '2026-07-10T00:00:00+09:00', scheduleEnd: '2026-07-20T00:00:00+09:00' }),
      grp({ id: 'plain', name: '通常メニュー' }),
    ] })
    render(<RichMenusListPage />)
    await waitFor(() => expect(screen.getByText('春キャンペーン')).toBeTruthy())
    // 一覧に「期間限定」バッジがちょうど 1 つ (scheduled group のみ)。
    const badges = screen.getAllByText('期間限定')
    expect(badges.length).toBe(1)
  })

  it('no badge when no group is scheduled', async () => {
    m.list.mockResolvedValue({ success: true, data: [grp({ id: 'plain', name: '通常メニュー' })] })
    render(<RichMenusListPage />)
    await waitFor(() => expect(screen.getByText('通常メニュー')).toBeTruthy())
    expect(screen.queryByText('期間限定')).toBeNull()
  })

  it('passes the selected account and LINE richMenuId choices to the display rule panel', async () => {
    m.list.mockResolvedValue({ success: true, data: [] })
    m.external.mockResolvedValue({
      success: true,
      data: {
        currentDefault: 'menu-vip',
        lineMenus: [{
          richMenuId: 'menu-vip', name: 'VIPメニュー', chatBarText: 'メニュー',
          size: { width: 2500, height: 1686 }, areasCount: 1, isCurrentDefault: true,
          adminManaged: false, adminInfo: null,
        }],
      },
    })

    render(<RichMenusListPage />)

    await waitFor(() => expect(screen.getByText('条件ルール接続済み')).toBeTruthy())
    expect(m.panelProps).toHaveBeenCalledWith({
      accountId: 'acc-1',
      menus: [{ richMenuId: 'menu-vip', name: 'VIPメニュー' }],
    })
  })
})
