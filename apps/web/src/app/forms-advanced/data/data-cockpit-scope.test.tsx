// @vitest-environment jsdom
/**
 * T-B3 (F6-2 / web データ画面) — 表示スコープ照合 (Codex B#3)。
 *   - form.lineAccountId != null かつ 選択アカウント不一致 → scope-blocked (コックピット非表示)。
 *   - NULL 共通 / 一致 form は表示。※API 直打ちは防げない旨 (N-17) を画面に明記。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import type { ReactNode } from 'react'

const mockAccount: { selectedAccountId: string | null } = { selectedAccountId: 'acc_A' }
const getMock = vi.fn()
const rowsMock = vi.fn()
const statsMock = vi.fn()
const listFiltersMock = vi.fn()
const fetchApiMock = vi.fn()

vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('@/components/layout/header', () => ({ default: () => null }))
vi.mock('@/components/forms-advanced/data-cockpit', () => ({ default: () => <div data-testid="data-cockpit" /> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => mockAccount }))
vi.mock('@/lib/download', () => ({ csvDateStamp: () => 'd', safeFilenamePart: (s: string) => s }))
vi.mock('@/lib/formaloo-advanced-api', () => ({
  formsAdvancedApi: { get: (...a: unknown[]) => getMock(...a) },
  formalooDataApi: {
    rows: (...a: unknown[]) => rowsMock(...a),
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
  getMock.mockReset(); rowsMock.mockReset(); statsMock.mockReset(); listFiltersMock.mockReset(); fetchApiMock.mockReset()
  mockAccount.selectedAccountId = 'acc_A'
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
