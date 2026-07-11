// @vitest-environment jsdom
/**
 * T-C2 (F6-3 / web) — ハーネス側フォルダ UI: ツリー/絞り込み/CRUD/移動 + 正直表示 (静的 export 互換)。
 *   ① formaloo-folders-api list が ?lineAccountId= を付ける (account スコープ) = page が foldersApi.list(accountId)。
 *   ② 選択アカウントのフォルダ一覧が render・account 切替でフォルダ再取得 + stale 応答破棄 (Codex M#5)。
 *   ③ フォルダ CRUD UI (作成/リネーム/削除)・削除確認に「フォームは未分類に戻ります（消えません）」相当。
 *   ④ フォルダ絞り込み: 選択フォルダで list(accountId, folderId) / 「未分類」は list(accountId, 'none') (§3.3b)。
 *   ⑤ 正直表示 (芯 / Codex B#3): (a) 「Formaloo 側と自動連動しません」注記 render (positive) /
 *      (b) Formaloo への同期/反映/連携を "実行する" 肯定形 button/link が存在しない (negative affordance assert)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup, act, fireEvent, within } from '@testing-library/react'
import type { ReactNode } from 'react'

const mockAccount: { selectedAccountId: string | null; loading: boolean } = { selectedAccountId: null, loading: true }
const listMock = vi.fn()
const createMock = vi.fn()
const wsListMock = vi.fn()
const bindingsListMock = vi.fn()
const fetchApiMock = vi.fn()
const pushMock = vi.fn()
const foldersListMock = vi.fn()
const foldersCreateMock = vi.fn()
const foldersRenameMock = vi.fn()
const foldersDeleteMock = vi.fn()
const foldersAssignMock = vi.fn()

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }))
vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('@/components/layout/header', () => ({ default: () => null }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => mockAccount }))
vi.mock('@/lib/formaloo-advanced-api', () => ({
  formsAdvancedApi: { list: (...a: unknown[]) => listMock(...a), create: (...a: unknown[]) => createMock(...a) },
}))
vi.mock('@/lib/formaloo-workspaces-api', () => ({ formalooWorkspacesApi: { list: (...a: unknown[]) => wsListMock(...a) } }))
vi.mock('@/lib/formaloo-account-bindings-api', () => ({ formalooAccountBindingsApi: { list: (...a: unknown[]) => bindingsListMock(...a) } }))
vi.mock('@/lib/formaloo-folders-api', () => ({
  formalooFoldersApi: {
    list: (...a: unknown[]) => foldersListMock(...a),
    create: (...a: unknown[]) => foldersCreateMock(...a),
    rename: (...a: unknown[]) => foldersRenameMock(...a),
    remove: (...a: unknown[]) => foldersDeleteMock(...a),
    assign: (...a: unknown[]) => foldersAssignMock(...a),
  },
}))
vi.mock('@/lib/api', () => ({ fetchApi: (...a: unknown[]) => fetchApiMock(...a) }))

import Page from './page'

function form(id: string, title: string, lineAccountId: string | null = null, folderId: string | null = null) {
  return { id, title, description: null, formalooSlug: null, builderStatus: 'draft', publishedAt: null, submitCount: 0, fields: [], logic: [], publicUrl: null, embedCode: null, syncStatus: 'idle', syncError: null, lineAccountId, folderId, updatedAt: '2026-07-11' }
}
function folder(id: string, name: string, parentId: string | null = null) {
  return { id, lineAccountId: 'acc_A', name, parentId, position: 0 }
}

beforeEach(() => {
  listMock.mockReset(); createMock.mockReset(); wsListMock.mockReset(); bindingsListMock.mockReset(); fetchApiMock.mockReset(); pushMock.mockReset()
  foldersListMock.mockReset(); foldersCreateMock.mockReset(); foldersRenameMock.mockReset(); foldersDeleteMock.mockReset(); foldersAssignMock.mockReset()
  mockAccount.selectedAccountId = null; mockAccount.loading = true
  listMock.mockResolvedValue([])
  wsListMock.mockResolvedValue([])
  bindingsListMock.mockResolvedValue([])
  foldersListMock.mockResolvedValue([])
  foldersCreateMock.mockResolvedValue({ id: 'ff_new', name: '新規', lineAccountId: 'acc_A', parentId: null, position: 0 })
  foldersRenameMock.mockResolvedValue(undefined)
  foldersDeleteMock.mockResolvedValue(undefined)
  foldersAssignMock.mockResolvedValue(undefined)
  fetchApiMock.mockResolvedValue({ data: { role: 'staff' } })
})
afterEach(() => cleanup())

describe('① account スコープ folder fetch', () => {
  it('account 確定で foldersApi.list(selectedAccountId) を呼ぶ', async () => {
    mockAccount.loading = false; mockAccount.selectedAccountId = 'acc_A'
    foldersListMock.mockResolvedValue([folder('ff_1', '販促')])
    render(<Page />)
    await waitFor(() => expect(foldersListMock).toHaveBeenCalledWith('acc_A'))
  })

  it('account loading 中は folder を取得しない', async () => {
    mockAccount.loading = true; mockAccount.selectedAccountId = null
    render(<Page />)
    await act(async () => { await Promise.resolve() })
    expect(foldersListMock).not.toHaveBeenCalled()
  })
})

describe('② フォルダ一覧 render + account 切替 stale 破棄', () => {
  it('選択アカウントのフォルダが render される', async () => {
    mockAccount.loading = false; mockAccount.selectedAccountId = 'acc_A'
    foldersListMock.mockResolvedValue([folder('ff_1', '販促'), folder('ff_2', 'イベント')])
    render(<Page />)
    await waitFor(() => expect(screen.getByTestId('folder-item-ff_1')).toBeTruthy())
    expect(screen.getByTestId('folder-item-ff_2')).toBeTruthy()
  })

  it('A→B 切替で遅延 A の folder 応答が B 画面へ混入しない (M#5 stale 破棄)', async () => {
    const deferreds: Record<string, (v: unknown) => void> = {}
    foldersListMock.mockImplementation((accountId: string) => new Promise((resolve) => { deferreds[accountId] = resolve }))
    mockAccount.loading = false; mockAccount.selectedAccountId = 'acc_A'
    const { rerender } = render(<Page />)
    await waitFor(() => expect(deferreds['acc_A']).toBeTruthy())
    mockAccount.selectedAccountId = 'acc_B'
    rerender(<Page />)
    await waitFor(() => expect(deferreds['acc_B']).toBeTruthy())
    // B を先に解決、A(stale) を後から
    await act(async () => { deferreds['acc_B']([folder('ff_B', 'B社フォルダ')]) })
    await act(async () => { deferreds['acc_A']([folder('ff_A', 'A社フォルダ')]) })
    await waitFor(() => expect(screen.getByTestId('folder-item-ff_B')).toBeTruthy())
    expect(screen.queryByTestId('folder-item-ff_A')).toBeNull() // stale A は反映されない
  })
})

describe('④ フォルダ絞り込み (3 状態)', () => {
  it('フォルダ選択で list(accountId, folderId) / 未分類は list(accountId, "none")', async () => {
    mockAccount.loading = false; mockAccount.selectedAccountId = 'acc_A'
    foldersListMock.mockResolvedValue([folder('ff_1', '販促')])
    render(<Page />)
    await waitFor(() => expect(screen.getByTestId('folder-item-ff_1')).toBeTruthy())
    // 初期 (すべて) は 1 引数で呼ばれる (F6-2 test 互換維持)
    expect(listMock).toHaveBeenCalledWith('acc_A')
    // フォルダを選択
    await act(async () => { fireEvent.click(screen.getByTestId('folder-item-ff_1')) })
    await waitFor(() => expect(listMock).toHaveBeenCalledWith('acc_A', 'ff_1'))
    // 未分類
    await act(async () => { fireEvent.click(screen.getByTestId('folder-filter-none')) })
    await waitFor(() => expect(listMock).toHaveBeenCalledWith('acc_A', 'none'))
    // すべてへ戻す
    await act(async () => { fireEvent.click(screen.getByTestId('folder-filter-all')) })
    await waitFor(() => expect(listMock).toHaveBeenLastCalledWith('acc_A'))
  })
})

describe('③ フォルダ CRUD UI', () => {
  it('作成: 名前入力で foldersApi.create(accountId, name)', async () => {
    mockAccount.loading = false; mockAccount.selectedAccountId = 'acc_A'
    vi.spyOn(window, 'prompt').mockReturnValue('新キャンペーン')
    render(<Page />)
    await waitFor(() => expect(screen.getByTestId('folder-create-btn')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId('folder-create-btn')) })
    await waitFor(() => expect(foldersCreateMock).toHaveBeenCalledWith('acc_A', '新キャンペーン'))
  })

  it('削除: 確認文に「フォームは未分類に戻ります（消えません）」相当 + confirm で remove', async () => {
    mockAccount.loading = false; mockAccount.selectedAccountId = 'acc_A'
    foldersListMock.mockResolvedValue([folder('ff_1', '販促')])
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<Page />)
    await waitFor(() => expect(screen.getByTestId('folder-delete-ff_1')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId('folder-delete-ff_1')) })
    await waitFor(() => expect(foldersDeleteMock).toHaveBeenCalledWith('ff_1'))
    const confirmMsg = confirmSpy.mock.calls[0][0] as string
    expect(confirmMsg).toContain('未分類')
    expect(confirmMsg).toMatch(/消えません|フォームは/)
  })

  it('リネーム: 新名で foldersApi.rename(id, name)', async () => {
    mockAccount.loading = false; mockAccount.selectedAccountId = 'acc_A'
    foldersListMock.mockResolvedValue([folder('ff_1', '旧名')])
    vi.spyOn(window, 'prompt').mockReturnValue('新名')
    render(<Page />)
    await waitFor(() => expect(screen.getByTestId('folder-rename-ff_1')).toBeTruthy())
    await act(async () => { fireEvent.click(screen.getByTestId('folder-rename-ff_1')) })
    await waitFor(() => expect(foldersRenameMock).toHaveBeenCalledWith('ff_1', '新名'))
  })
})

describe('フォーム→フォルダ移動', () => {
  it('form card の移動セレクトで foldersApi.assign(formId, folderId)', async () => {
    mockAccount.loading = false; mockAccount.selectedAccountId = 'acc_A'
    foldersListMock.mockResolvedValue([folder('ff_1', '販促')])
    listMock.mockResolvedValue([form('fa_1', 'A社フォーム', 'acc_A', null)])
    render(<Page />)
    await waitFor(() => expect(screen.getByTestId('form-move-fa_1')).toBeTruthy())
    await act(async () => { fireEvent.change(screen.getByTestId('form-move-fa_1'), { target: { value: 'ff_1' } }) })
    await waitFor(() => expect(foldersAssignMock).toHaveBeenCalledWith('fa_1', 'ff_1'))
  })
})

describe('CRUD race (F6-3b) — CRUD 応答待ち中の account 切替で旧 account の reload が新画面を上書きしない', () => {
  it('フォルダ作成の応答待ち中に A→B 切替 → 遅延した A の create 応答後 loadFolders(A) が B 画面へ混入しない', async () => {
    // folder 一覧は account 別に即解決。
    foldersListMock.mockImplementation((accountId: string) =>
      Promise.resolve(accountId === 'acc_B' ? [folder('ff_B1', 'B社フォルダ')] : [folder('ff_A1', 'A社フォルダ')]))
    // foldersCreate を deferred 化して account 切替の窓を作る (create 応答待ちのまま切替)。
    let resolveCreate!: (v: unknown) => void
    foldersCreateMock.mockImplementation(() => new Promise((r) => { resolveCreate = r }))
    vi.spyOn(window, 'prompt').mockReturnValue('新フォルダ')

    mockAccount.loading = false; mockAccount.selectedAccountId = 'acc_A'
    const { rerender } = render(<Page />)
    await waitFor(() => expect(screen.getByTestId('folder-item-ff_A1')).toBeTruthy())

    // 作成開始 → foldersCreate(A) in-flight。
    await act(async () => { fireEvent.click(screen.getByTestId('folder-create-btn')) })
    await waitFor(() => expect(foldersCreateMock).toHaveBeenCalledWith('acc_A', '新フォルダ'))

    // B へ切替 (create 応答待ちのまま) → B のフォルダに更新。
    mockAccount.selectedAccountId = 'acc_B'
    rerender(<Page />)
    await waitFor(() => expect(screen.getByTestId('folder-item-ff_B1')).toBeTruthy())
    expect(screen.queryByTestId('folder-item-ff_A1')).toBeNull()

    // ここで A の create を解決。修正前は loadFolders(A) が走り ff_A1 が B 画面に復活してしまう。
    await act(async () => { resolveCreate({ id: 'ff_new', name: '新フォルダ', lineAccountId: 'acc_A', parentId: null, position: 0 }) })
    await act(async () => { await Promise.resolve() })

    // 修正後: B 画面のまま (ff_B1)、旧 account A の folder は混入しない。
    expect(screen.getByTestId('folder-item-ff_B1')).toBeTruthy()
    expect(screen.queryByTestId('folder-item-ff_A1')).toBeNull()
  })

  it('フォーム移動の応答待ち中に A→B 切替 → 遅延した A の assign 応答後 reloadForms(A) が B 画面へ混入しない', async () => {
    listMock.mockImplementation((accountId: string) =>
      Promise.resolve(accountId === 'acc_B' ? [form('fb_1', 'B社フォーム', 'acc_B')] : [form('fa_1', 'A社フォーム', 'acc_A')]))
    foldersListMock.mockResolvedValue([folder('ff_1', '販促')])
    // foldersAssign を deferred 化して切替窓を作る。
    let resolveAssign!: (v: unknown) => void
    foldersAssignMock.mockImplementation(() => new Promise((r) => { resolveAssign = r }))

    mockAccount.loading = false; mockAccount.selectedAccountId = 'acc_A'
    const { rerender } = render(<Page />)
    await waitFor(() => expect(screen.getByTestId('form-card-fa_1')).toBeTruthy())

    // 移動開始 → assign(fa_1, ff_1) in-flight。
    await act(async () => { fireEvent.change(screen.getByTestId('form-move-fa_1'), { target: { value: 'ff_1' } }) })
    await waitFor(() => expect(foldersAssignMock).toHaveBeenCalledWith('fa_1', 'ff_1'))

    // B へ切替 → B のフォームに更新。
    mockAccount.selectedAccountId = 'acc_B'
    rerender(<Page />)
    await waitFor(() => expect(screen.getByTestId('form-card-fb_1')).toBeTruthy())
    expect(screen.queryByTestId('form-card-fa_1')).toBeNull()

    // A の assign を解決。修正前は reloadForms(A) が走り fa_1 が B 画面に復活してしまう。
    await act(async () => { resolveAssign(undefined) })
    await act(async () => { await Promise.resolve() })

    // 修正後: B 画面のまま (fb_1)、旧 account A の form は混入しない。
    expect(screen.getByTestId('form-card-fb_1')).toBeTruthy()
    expect(screen.queryByTestId('form-card-fa_1')).toBeNull()
  })
})

describe('⑤ 正直表示 (芯 / Codex B#3)', () => {
  it('(a positive) 「Formaloo 側と自動連動しません」注記が render される', async () => {
    mockAccount.loading = false; mockAccount.selectedAccountId = 'acc_A'
    render(<Page />)
    await waitFor(() => expect(screen.getByTestId('formaloo-sync-note')).toBeTruthy())
    const note = screen.getByTestId('formaloo-sync-note').textContent ?? ''
    expect(note).toContain('自動連動しません')
    expect(note).toContain('Formaloo')
  })

  it('(b negative affordance) Formaloo への同期/反映/連携を実行する肯定形 button/link が存在しない', async () => {
    mockAccount.loading = false; mockAccount.selectedAccountId = 'acc_A'
    foldersListMock.mockResolvedValue([folder('ff_1', '販促')])
    listMock.mockResolvedValue([form('fa_1', 'A社フォーム', 'acc_A', null)])
    render(<Page />)
    await waitFor(() => expect(screen.getByTestId('formaloo-sync-note')).toBeTruthy())
    // clickable (button / a[href]) の accessible name/text で「Formaloo … 同期/反映/連携/送信/プッシュ を実行」を探す。
    const EXECUTE = /Formaloo.*(同期|反映|連携|送信|プッシュ)/
    const clickables = [
      ...Array.from(document.querySelectorAll('button')),
      ...Array.from(document.querySelectorAll('a[href]')),
    ]
    const offending = clickables
      .map((el) => (el.getAttribute('aria-label') || el.textContent || '').trim())
      .filter((name) => EXECUTE.test(name))
    expect(offending, `自動連動を実行する肯定形 affordance: ${offending.join(' / ')}`).toEqual([])
    // 注記 (<p>) 自身は clickable でないので誤検知しない = positive 注記は生かしたまま negative を満たす。
    const note = screen.getByTestId('formaloo-sync-note')
    expect(note.tagName.toLowerCase()).not.toBe('button')
    expect(note.tagName.toLowerCase()).not.toBe('a')
  })
})
