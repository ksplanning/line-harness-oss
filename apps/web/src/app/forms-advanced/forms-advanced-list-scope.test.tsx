// @vitest-environment jsdom
/**
 * T-B3 (F6-2 / web 一覧ページ) — 表示スコープ配線。
 *   ① account 文脈 loading 中 / selectedAccountId=null は list/create を実行しない (Codex M#8)。
 *   ② account 確定で list(selectedAccountId) を呼び絞り結果を表示・account 切替で re-fetch。
 *   ③ account 切替の stale 応答破棄 (A 取得中に B へ切替→遅延 A 応答で B 画面を上書きしない / Codex M#9)。
 *   ④ workspace セレクタは owner のみ表示 (非 owner は非表示 / §3.1)。
 *   ⑤ create は lineAccountId(=選択アカウント) + owner 選択 workspaceId を渡す。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, act, fireEvent } from '@testing-library/react'
import type { ReactNode } from 'react'

const mockAccount: { selectedAccountId: string | null; loading: boolean } = { selectedAccountId: null, loading: true }
const listMock = vi.fn()
const createMock = vi.fn()
const wsListMock = vi.fn()
const bindingsListMock = vi.fn()
const fetchApiMock = vi.fn()
const pushMock = vi.fn()

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('@/components/layout/header', () => ({ default: () => null }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => mockAccount }))
vi.mock('@/lib/formaloo-advanced-api', () => ({
  formsAdvancedApi: { list: (...a: unknown[]) => listMock(...a), create: (...a: unknown[]) => createMock(...a) },
}))
vi.mock('@/lib/formaloo-workspaces-api', () => ({ formalooWorkspacesApi: { list: (...a: unknown[]) => wsListMock(...a) } }))
vi.mock('@/lib/formaloo-account-bindings-api', () => ({ formalooAccountBindingsApi: { list: (...a: unknown[]) => bindingsListMock(...a) } }))
vi.mock('@/lib/api', () => ({ fetchApi: (...a: unknown[]) => fetchApiMock(...a) }))

import Page from './page'

function form(id: string, title: string, lineAccountId: string | null = null) {
  return { id, title, description: null, formalooSlug: null, builderStatus: 'draft', publishedAt: null, submitCount: 0, fields: [], logic: [], publicUrl: null, embedCode: null, syncStatus: 'idle', syncError: null, lineAccountId, updatedAt: '2026-07-11' }
}

beforeEach(() => {
  listMock.mockReset(); createMock.mockReset(); wsListMock.mockReset(); bindingsListMock.mockReset(); fetchApiMock.mockReset(); pushMock.mockReset()
  mockAccount.selectedAccountId = null; mockAccount.loading = true
  listMock.mockResolvedValue([])
  wsListMock.mockResolvedValue([])
  bindingsListMock.mockResolvedValue([])
  fetchApiMock.mockResolvedValue({ data: { role: 'staff' } }) // 既定 非 owner
})
afterEach(() => cleanup())

describe('① loading/null 中は list しない', () => {
  it('account loading 中は list を呼ばない', async () => {
    mockAccount.loading = true; mockAccount.selectedAccountId = null
    render(<Page />)
    await act(async () => { await Promise.resolve() })
    expect(listMock).not.toHaveBeenCalled()
  })
})

describe('② account 確定で list(selectedAccountId)', () => {
  it('選択アカウントで絞って表示', async () => {
    mockAccount.loading = false; mockAccount.selectedAccountId = 'acc_A'
    listMock.mockResolvedValue([form('fa1', 'A社フォーム', 'acc_A')])
    render(<Page />)
    await waitFor(() => expect(screen.getByTestId('form-card-fa1')).toBeTruthy())
    expect(listMock).toHaveBeenCalledWith('acc_A')
  })
})

describe('③ stale 応答破棄', () => {
  it('A 取得中に B へ切替→遅延 A 応答で B を上書きしない', async () => {
    const deferreds: Record<string, (v: unknown) => void> = {}
    listMock.mockImplementation((accountId: string) => new Promise((resolve) => { deferreds[accountId] = resolve }))
    mockAccount.loading = false; mockAccount.selectedAccountId = 'acc_A'
    const { rerender } = render(<Page />)
    await waitFor(() => expect(deferreds['acc_A']).toBeTruthy())
    // B へ切替
    mockAccount.selectedAccountId = 'acc_B'
    rerender(<Page />)
    await waitFor(() => expect(deferreds['acc_B']).toBeTruthy())
    // B を先に、A(stale) を後から解決
    await act(async () => { deferreds['acc_B']([form('fb', 'B社フォーム', 'acc_B')]) })
    await act(async () => { deferreds['acc_A']([form('fa', 'A社フォーム', 'acc_A')]) })
    await waitFor(() => expect(screen.getByTestId('form-card-fb')).toBeTruthy())
    expect(screen.queryByTestId('form-card-fa')).toBeNull() // stale A は反映されない
  })
})

describe('④ workspace セレクタは owner のみ', () => {
  it('owner はセレクタ表示', async () => {
    mockAccount.loading = false; mockAccount.selectedAccountId = 'acc_A'
    fetchApiMock.mockResolvedValue({ data: { role: 'owner' } })
    wsListMock.mockResolvedValue([{ id: 'fw_1', label: 'A社', businessSlug: null, isActive: true }])
    render(<Page />)
    await waitFor(() => expect(screen.getByTestId('workspace-select')).toBeTruthy())
  })

  it('非 owner はセレクタ非表示', async () => {
    mockAccount.loading = false; mockAccount.selectedAccountId = 'acc_A'
    fetchApiMock.mockResolvedValue({ data: { role: 'staff' } })
    render(<Page />)
    await waitFor(() => expect(screen.getByTestId('create-btn')).toBeTruthy())
    expect(screen.queryByTestId('workspace-select')).toBeNull()
  })
})

describe('⑤ create payload', () => {
  it('owner が workspace 選択 → create に lineAccountId + workspaceId', async () => {
    mockAccount.loading = false; mockAccount.selectedAccountId = 'acc_A'
    fetchApiMock.mockResolvedValue({ data: { role: 'owner' } })
    wsListMock.mockResolvedValue([{ id: 'fw_1', label: 'A社', businessSlug: null, isActive: true }])
    createMock.mockResolvedValue({ id: 'faNew' })
    render(<Page />)
    await waitFor(() => expect(screen.getByTestId('workspace-select')).toBeTruthy())
    fireEvent.change(screen.getByTestId('workspace-select'), { target: { value: 'fw_1' } })
    await act(async () => { fireEvent.click(screen.getByTestId('create-btn')) })
    expect(createMock).toHaveBeenCalledWith({ title: '新しいフォーム', lineAccountId: 'acc_A', workspaceId: 'fw_1' })
  })

  it('非 owner は workspaceId を送らない (server 解決) が lineAccountId は送る', async () => {
    mockAccount.loading = false; mockAccount.selectedAccountId = 'acc_A'
    fetchApiMock.mockResolvedValue({ data: { role: 'staff' } })
    createMock.mockResolvedValue({ id: 'faNew' })
    render(<Page />)
    await waitFor(() => expect(screen.getByTestId('create-btn')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId('create-btn')) })
    expect(createMock).toHaveBeenCalledWith({ title: '新しいフォーム', lineAccountId: 'acc_A', workspaceId: undefined })
  })
})
