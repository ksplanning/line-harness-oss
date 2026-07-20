// @vitest-environment jsdom
/**
 * T-B3 (F6-2 / web データ画面) — 表示スコープ照合 (Codex B#3)。
 *   - form.lineAccountId != null かつ 選択アカウント不一致 → scope-blocked (コックピット非表示)。
 *   - NULL 共通 / 一致 form は表示。※API 直打ちは防げない旨 (N-17) を画面に明記。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'

const mockAccount: { selectedAccountId: string | null } = { selectedAccountId: 'acc_A' }
const getMock = vi.fn()
const getRenderBackendMock = vi.fn()
const rowsMock = vi.fn()
const rowMock = vi.fn()
const statsMock = vi.fn()
const listFiltersMock = vi.fn()
const fetchApiMock = vi.fn()
const cockpitProps: { current: { isOwner?: boolean; onOpenRow?: (id: string) => void } | null } = { current: null }

vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('@/components/layout/header', () => ({
  default: ({ description }: { description: string }) => <div data-testid="header-description">{description}</div>,
}))
vi.mock('@/components/forms-advanced/data-cockpit', () => ({
  default: (props: { isOwner: boolean; onOpenRow: (id: string) => void }) => {
    cockpitProps.current = props
    return (
      <div data-testid="data-cockpit">
        <button type="button" onClick={() => props.onOpenRow('row_internal')}>回答を開く</button>
      </div>
    )
  },
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => mockAccount }))
vi.mock('@/lib/download', () => ({ csvDateStamp: () => 'd', safeFilenamePart: (s: string) => s }))
vi.mock('@/lib/formaloo-advanced-api', () => ({
  formsAdvancedApi: {
    get: (...a: unknown[]) => getMock(...a),
    getRenderBackend: (...a: unknown[]) => getRenderBackendMock(...a),
  },
  formalooDataApi: {
    rows: (...a: unknown[]) => rowsMock(...a),
    row: (...a: unknown[]) => rowMock(...a),
    stats: (...a: unknown[]) => statsMock(...a),
    listFilters: (...a: unknown[]) => listFiltersMock(...a),
  },
}))
vi.mock('@/lib/api', () => ({ fetchApi: (...a: unknown[]) => fetchApiMock(...a) }))

import DataCockpitClient from './data-cockpit-client'

function form(lineAccountId: string | null) {
  return { id: 'fa1', title: 'F', lineAccountId }
}

beforeEach(() => {
  getMock.mockReset(); getRenderBackendMock.mockReset(); rowsMock.mockReset(); rowMock.mockReset(); statsMock.mockReset(); listFiltersMock.mockReset(); fetchApiMock.mockReset()
  cockpitProps.current = null
  mockAccount.selectedAccountId = 'acc_A'
  getRenderBackendMock.mockResolvedValue('formaloo')
  rowsMock.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 25 })
  statsMock.mockResolvedValue({ total: 0, verified: 0, daily: [], formaloo: null })
  listFiltersMock.mockResolvedValue([])
  fetchApiMock.mockResolvedValue({ data: { role: 'owner' } })
})
afterEach(() => cleanup())

describe('データ画面 scope 照合', () => {
  it('別アカウント form は scope-blocked (コックピット非表示)', async () => {
    getMock.mockResolvedValue(form('acc_B'))
    render(<DataCockpitClient id="fa1" />)
    await waitFor(() => expect(screen.getByTestId('scope-blocked')).toBeTruthy())
    expect(screen.queryByTestId('data-cockpit')).toBeNull()
  })

  it('NULL 共通 form は表示', async () => {
    getMock.mockResolvedValue(form(null))
    render(<DataCockpitClient id="fa1" />)
    await waitFor(() => expect(screen.getByTestId('data-cockpit')).toBeTruthy())
    expect(screen.queryByTestId('scope-blocked')).toBeNull()
  })

  it('一致アカウント form は表示', async () => {
    getMock.mockResolvedValue(form('acc_A'))
    render(<DataCockpitClient id="fa1" />)
    await waitFor(() => expect(screen.getByTestId('data-cockpit')).toBeTruthy())
    expect(screen.queryByTestId('scope-blocked')).toBeNull()
  })

  it('P2 fail-closed: account 未確定 (selectedAccountId=null) で account-scoped form は回答を描画せず hold', async () => {
    mockAccount.selectedAccountId = null
    getMock.mockResolvedValue(form('acc_B'))
    render(<DataCockpitClient id="fa1" />)
    await waitFor(() => expect(screen.getByTestId('scope-hold')).toBeTruthy())
    expect(screen.queryByTestId('data-cockpit')).toBeNull()
  })

  it('P2 fail-closed: form fetch 失敗 (formAccountId 未取得) は回答を描画せず hold', async () => {
    getMock.mockRejectedValue(new Error('boom'))
    render(<DataCockpitClient id="fa1" />)
    await waitFor(() => expect(screen.getByTestId('scope-hold')).toBeTruthy())
    expect(screen.queryByTestId('data-cockpit')).toBeNull()
  })

  it('P2: account 未確定でも NULL 共通 form は表示', async () => {
    mockAccount.selectedAccountId = null
    getMock.mockResolvedValue(form(null))
    render(<DataCockpitClient id="fa1" />)
    await waitFor(() => expect(screen.getByTestId('data-cockpit')).toBeTruthy())
    expect(screen.queryByTestId('scope-hold')).toBeNull()
  })
})

describe('自前配信の回答表示', () => {
  it('internal は自前回答と明示し、Formaloo 専用の owner 操作を隠す', async () => {
    getMock.mockResolvedValue(form('acc_A'))
    getRenderBackendMock.mockResolvedValue('internal')

    render(<DataCockpitClient id="fa1" />)

    await waitFor(() => expect(screen.getByTestId('data-cockpit')).toBeTruthy())
    expect(screen.getByTestId('header-description').textContent).toContain('自前回答')
    expect(cockpitProps.current?.isOwner).toBe(false)
    expect(getRenderBackendMock).toHaveBeenCalledWith('fa1')
    expect(rowsMock).toHaveBeenCalledWith('fa1', expect.objectContaining({ page: 1, pageSize: 25 }))
    expect(statsMock).toHaveBeenCalledWith('fa1')
  })

  it('internal の回答詳細では取得元を「自前配信」と表示する', async () => {
    getMock.mockResolvedValue(form('acc_A'))
    getRenderBackendMock.mockResolvedValue('internal')
    rowMock.mockResolvedValue({
      id: 'row_internal',
      answers: { name: '大学生' },
      submittedAt: '2026-07-21T00:00:00.000Z',
      source: 'internal',
      fields: [],
    })

    render(<DataCockpitClient id="fa1" />)

    fireEvent.click(await screen.findByRole('button', { name: '回答を開く' }))
    await waitFor(() => expect(screen.getByText('自前配信')).toBeTruthy())
    expect(rowMock).toHaveBeenCalledWith('fa1', 'row_internal')
  })

  it('backend 取得失敗は fail-closed にし、Formaloo 専用 owner 操作を出さない', async () => {
    getMock.mockResolvedValue(form(null))
    getRenderBackendMock.mockRejectedValue(new Error('backend unavailable'))

    render(<DataCockpitClient id="fa1" />)

    await waitFor(() => expect(screen.getByTestId('data-cockpit')).toBeTruthy())
    expect(screen.getByTestId('header-description').textContent).toContain('配信方式を確認できません')
    expect(cockpitProps.current?.isOwner).toBe(false)
  })

  it('backend の不正値も Formaloo と推測せず owner 操作を出さない', async () => {
    getMock.mockResolvedValue(form(null))
    getRenderBackendMock.mockResolvedValue('unexpected')

    render(<DataCockpitClient id="fa1" />)

    await waitFor(() => expect(screen.getByTestId('data-cockpit')).toBeTruthy())
    expect(cockpitProps.current?.isOwner).toBe(false)
  })
})
