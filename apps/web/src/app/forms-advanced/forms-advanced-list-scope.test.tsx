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
  const btnEnabled = () => expect((screen.getByTestId('create-btn') as HTMLButtonElement).disabled).toBe(false)

  it('owner が workspace 選択 → create に lineAccountId + workspaceId', async () => {
    mockAccount.loading = false; mockAccount.selectedAccountId = 'acc_A'
    fetchApiMock.mockResolvedValue({ data: { role: 'owner' } })
    wsListMock.mockResolvedValue([{ id: 'fw_1', label: 'A社', businessSlug: null, isActive: true }])
    createMock.mockResolvedValue({ id: 'faNew' })
    render(<Page />)
    await waitFor(() => expect(screen.getByTestId('workspace-select')).toBeTruthy())
    await waitFor(btnEnabled) // settingsReady 完了まで待つ
    fireEvent.change(screen.getByTestId('workspace-select'), { target: { value: 'fw_1' } })
    await act(async () => { fireEvent.click(screen.getByTestId('create-btn')) })
    expect(createMock).toHaveBeenCalledWith({ title: '新しいフォーム', lineAccountId: 'acc_A', workspaceId: 'fw_1' })
  })

  it('非 owner は workspaceId を送らない (server 解決) が lineAccountId は送る', async () => {
    mockAccount.loading = false; mockAccount.selectedAccountId = 'acc_A'
    fetchApiMock.mockResolvedValue({ data: { role: 'staff' } })
    createMock.mockResolvedValue({ id: 'faNew' })
    render(<Page />)
    await waitFor(btnEnabled)
    await act(async () => { fireEvent.click(screen.getByTestId('create-btn')) })
    expect(createMock).toHaveBeenCalledWith({ title: '新しいフォーム', lineAccountId: 'acc_A', workspaceId: undefined })
  })
})

describe('P1 (reviewer R1) — account 切替 race で旧 workspace 鍵が新 form に載らない', () => {
  it('A→B 切替直後は Create 無効 + selectedWorkspaceId リセット、B 解決後は B の値で作成', async () => {
    mockAccount.loading = false; mockAccount.selectedAccountId = 'acc_A'
    fetchApiMock.mockResolvedValue({ data: { role: 'owner' } })
    wsListMock.mockResolvedValue([
      { id: 'fw_A', label: 'A社', businessSlug: null, isActive: true },
      { id: 'fw_B', label: 'B社', businessSlug: null, isActive: true },
    ])
    createMock.mockResolvedValue({ id: 'faNew' })
    // binding 応答を deferred 化して切替窓を作る。
    const bindingResolvers: Array<(v: unknown) => void> = []
    bindingsListMock.mockImplementation(() => new Promise((resolve) => { bindingResolvers.push(resolve) }))

    const { rerender } = render(<Page />)
    // A の binding を解決 → 既定 fw_A / settingsReady=true。
    await waitFor(() => expect(bindingResolvers.length).toBe(1))
    await act(async () => { bindingResolvers[0]([{ lineAccountId: 'acc_A', defaultWorkspaceId: 'fw_A' }, { lineAccountId: 'acc_B', defaultWorkspaceId: 'fw_B' }]) })
    await waitFor(() => expect((screen.getByTestId('create-btn') as HTMLButtonElement).disabled).toBe(false))
    expect((screen.getByTestId('workspace-select') as HTMLSelectElement).value).toBe('fw_A')

    // B へ切替 (B の binding は未解決 = 切替窓)。
    mockAccount.selectedAccountId = 'acc_B'
    rerender(<Page />)
    await waitFor(() => expect(bindingResolvers.length).toBe(2))
    // 窓の間: Create は無効 + selectedWorkspaceId は '' にリセット (旧 fw_A を持ち越さない)。
    expect((screen.getByTestId('create-btn') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('workspace-select') as HTMLSelectElement).value).toBe('')
    // 窓の間にクリックしても disabled ゆえ create は呼ばれない。
    fireEvent.click(screen.getByTestId('create-btn'))
    expect(createMock).not.toHaveBeenCalled()

    // B の binding を解決 → 既定 fw_B / Create 有効化。
    await act(async () => { bindingResolvers[1]([{ lineAccountId: 'acc_A', defaultWorkspaceId: 'fw_A' }, { lineAccountId: 'acc_B', defaultWorkspaceId: 'fw_B' }]) })
    await waitFor(() => expect((screen.getByTestId('create-btn') as HTMLButtonElement).disabled).toBe(false))
    await act(async () => { fireEvent.click(screen.getByTestId('create-btn')) })
    // 旧 fw_A ではなく B の fw_B で作成 (stale 鍵混入なし)。
    expect(createMock).toHaveBeenCalledWith({ title: '新しいフォーム', lineAccountId: 'acc_B', workspaceId: 'fw_B' })
  })
})

describe('P3 (reviewer R1) — zero-account / 選択解除', () => {
  it('accountLoading=false + selectedAccountId=null は no-account 表示・list 非呼出・Create 無効', async () => {
    mockAccount.loading = false; mockAccount.selectedAccountId = null
    render(<Page />)
    await waitFor(() => expect(screen.getByTestId('no-account')).toBeTruthy())
    expect(listMock).not.toHaveBeenCalled()
    expect((screen.getByTestId('create-btn') as HTMLButtonElement).disabled).toBe(true)
    // 「読み込み中...」の無限ループにならない。
    expect(screen.queryByText('読み込み中...')).toBeNull()
  })
})
