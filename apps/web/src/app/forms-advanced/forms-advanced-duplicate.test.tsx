// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockAccount: { selectedAccountId: string | null; loading: boolean } = {
  selectedAccountId: 'account-a',
  loading: false,
}
const listMock = vi.fn()
const createMock = vi.fn()
const duplicateMock = vi.fn()
const workspacesListMock = vi.fn()
const bindingsListMock = vi.fn()
const fetchApiMock = vi.fn()
const foldersListMock = vi.fn()

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}))
vi.mock('@/components/layout/header', () => ({ default: () => null }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => mockAccount }))
vi.mock('@/lib/formaloo-advanced-api', () => ({
  formsAdvancedApi: {
    list: (...args: unknown[]) => listMock(...args),
    create: (...args: unknown[]) => createMock(...args),
    duplicate: (...args: unknown[]) => duplicateMock(...args),
  },
}))
vi.mock('@/lib/formaloo-workspaces-api', () => ({
  formalooWorkspacesApi: { list: (...args: unknown[]) => workspacesListMock(...args) },
}))
vi.mock('@/lib/formaloo-account-bindings-api', () => ({
  formalooAccountBindingsApi: { list: (...args: unknown[]) => bindingsListMock(...args) },
}))
vi.mock('@/lib/formaloo-folders-api', () => ({
  formalooFoldersApi: {
    list: (...args: unknown[]) => foldersListMock(...args),
    create: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
    assign: vi.fn(),
  },
}))
vi.mock('@/lib/api', () => ({ fetchApi: (...args: unknown[]) => fetchApiMock(...args) }))

import Page from './page'

function form(
  id: string,
  title: string,
  lineAccountId = 'account-a',
  folderId: string | null = null,
) {
  return {
    id,
    title,
    description: null,
    formalooSlug: null,
    renderBackend: 'formaloo',
    builderStatus: 'draft',
    publishedAt: null,
    submitCount: 0,
    fields: [],
    logic: [],
    publicUrl: null,
    embedCode: null,
    syncStatus: 'idle',
    syncError: null,
    lineAccountId,
    folderId,
    updatedAt: '2026-07-24T12:00:00+09:00',
  }
}

function folder(id: string, name: string) {
  return {
    id,
    lineAccountId: 'account-a',
    name,
    parentId: null,
    position: 0,
  }
}

beforeEach(() => {
  mockAccount.selectedAccountId = 'account-a'
  mockAccount.loading = false
  listMock.mockReset()
  createMock.mockReset()
  duplicateMock.mockReset()
  workspacesListMock.mockReset()
  bindingsListMock.mockReset()
  fetchApiMock.mockReset()
  foldersListMock.mockReset()
  listMock.mockResolvedValue([form('source-a', '夢花火2026申し込み')])
  workspacesListMock.mockResolvedValue([])
  bindingsListMock.mockResolvedValue([])
  fetchApiMock.mockResolvedValue({ data: { role: 'staff' } })
  foldersListMock.mockResolvedValue([])
})

afterEach(() => cleanup())

describe('フォーム一覧の複製操作', () => {
  it('D-3: 操作中 account で API を呼び、成功後に一覧を再取得してコピーを表示する', async () => {
    let resolveDuplicate!: (value: unknown) => void
    duplicateMock.mockImplementation(() => new Promise((resolve) => {
      resolveDuplicate = resolve
    }))
    listMock
      .mockResolvedValueOnce([form('source-a', '夢花火2026申し込み')])
      .mockResolvedValueOnce([
        form('copy-a', '夢花火2026申し込み のコピー'),
        form('source-a', '夢花火2026申し込み'),
      ])
    render(<Page />)
    await screen.findByTestId('form-card-source-a')

    fireEvent.click(screen.getByTestId('duplicate-source-a'))

    expect(duplicateMock).toHaveBeenCalledWith('source-a', 'account-a')
    await waitFor(() => {
      expect(screen.getByTestId('duplicate-source-a').textContent).toBe('複製中...')
      expect((screen.getByTestId('duplicate-source-a') as HTMLButtonElement).disabled).toBe(true)
    })

    await act(async () => {
      resolveDuplicate(form('copy-a', '夢花火2026申し込み のコピー'))
    })

    await waitFor(() => expect(screen.getByTestId('form-card-copy-a')).toBeTruthy())
    expect(listMock).toHaveBeenLastCalledWith('account-a')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('D-3: 失敗時は日本語エラーを表示し、元カードと通常の編集操作を残す', async () => {
    duplicateMock.mockRejectedValue(new Error('network failed'))
    render(<Page />)
    await screen.findByTestId('form-card-source-a')

    fireEvent.click(screen.getByTestId('duplicate-source-a'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('フォームの複製に失敗しました')
    expect(screen.getByTestId('form-card-source-a')).toBeTruthy()
    expect(screen.getByRole('link', { name: '編集' }).getAttribute('href'))
      .toBe('/forms-advanced/detail?id=source-a')
    expect((screen.getByTestId('duplicate-source-a') as HTMLButtonElement).disabled).toBe(false)
  })

  it('account A の複製完了が、切替後の account B 一覧へ混入しない', async () => {
    let resolveDuplicate!: (value: unknown) => void
    duplicateMock.mockImplementation(() => new Promise((resolve) => {
      resolveDuplicate = resolve
    }))
    listMock.mockImplementation((accountId: string) => Promise.resolve(
      accountId === 'account-a'
        ? [form('source-a', 'A社フォーム', 'account-a')]
        : [form('source-b', 'B社フォーム', 'account-b')],
    ))
    const { rerender } = render(<Page />)
    await screen.findByTestId('form-card-source-a')
    fireEvent.click(screen.getByTestId('duplicate-source-a'))

    mockAccount.selectedAccountId = 'account-b'
    rerender(<Page />)
    await screen.findByTestId('form-card-source-b')

    await act(async () => {
      resolveDuplicate(form('copy-a', 'A社フォーム のコピー', 'account-a'))
    })

    await act(async () => { await Promise.resolve() })
    expect(screen.queryByTestId('form-card-copy-a')).toBeNull()
    expect(screen.getByTestId('form-card-source-b')).toBeTruthy()
    expect(listMock.mock.calls.filter(([accountId]) => accountId === 'account-a')).toHaveLength(1)
  })

  it('特定フォルダで複製すると同じフォルダを再取得してコピーを表示する', async () => {
    let duplicated = false
    foldersListMock.mockResolvedValue([folder('folder-a', 'イベント')])
    duplicateMock.mockImplementation(async () => {
      duplicated = true
      return form('copy-a', '夢花火2026申し込み のコピー', 'account-a', 'folder-a')
    })
    listMock.mockImplementation((_accountId: string, folderId?: string) => Promise.resolve(
      folderId === 'folder-a'
        ? duplicated
          ? [
              form('copy-a', '夢花火2026申し込み のコピー', 'account-a', 'folder-a'),
              form('source-a', '夢花火2026申し込み', 'account-a', 'folder-a'),
            ]
          : [form('source-a', '夢花火2026申し込み', 'account-a', 'folder-a')]
        : [form('source-a', '夢花火2026申し込み', 'account-a', 'folder-a')],
    ))
    render(<Page />)
    await screen.findByTestId('folder-item-folder-a')
    fireEvent.click(screen.getByTestId('folder-item-folder-a'))
    await screen.findByTestId('form-card-source-a')

    fireEvent.click(screen.getByTestId('duplicate-source-a'))

    await screen.findByTestId('form-card-copy-a')
    expect(listMock).toHaveBeenLastCalledWith('account-a', 'folder-a')
  })

  it('複製待ち中にフォルダを変えても、古い絞り結果で現在の一覧を上書きしない', async () => {
    let resolveDuplicate!: (value: unknown) => void
    duplicateMock.mockImplementation(() => new Promise((resolve) => {
      resolveDuplicate = resolve
    }))
    foldersListMock.mockResolvedValue([
      folder('folder-source', '申込'),
      folder('folder-other', 'アンケート'),
    ])
    listMock.mockImplementation((_accountId: string, folderId?: string) => Promise.resolve(
      folderId === 'folder-other'
        ? [form('other-a', '別フォーム', 'account-a', 'folder-other')]
        : [form('source-a', '申込フォーム', 'account-a', 'folder-source')],
    ))
    render(<Page />)
    await screen.findByTestId('folder-item-folder-source')
    fireEvent.click(screen.getByTestId('folder-item-folder-source'))
    await screen.findByTestId('form-card-source-a')
    fireEvent.click(screen.getByTestId('duplicate-source-a'))

    fireEvent.click(screen.getByTestId('folder-item-folder-other'))
    await screen.findByTestId('form-card-other-a')
    await act(async () => {
      resolveDuplicate(form('copy-a', '申込フォーム のコピー', 'account-a', 'folder-source'))
    })

    await waitFor(() => {
      expect(listMock).toHaveBeenLastCalledWith('account-a', 'folder-other')
      expect(screen.getByTestId('form-card-other-a')).toBeTruthy()
      expect(screen.queryByTestId('form-card-source-a')).toBeNull()
    })
  })

  it('A→B→A の往復中も最初の A 複製を二重実行せず、古い完了で再取得しない', async () => {
    let resolveDuplicate!: (value: unknown) => void
    duplicateMock.mockImplementation(() => new Promise((resolve) => {
      resolveDuplicate = resolve
    }))
    listMock.mockImplementation((accountId: string) => Promise.resolve(
      accountId === 'account-a'
        ? [form('source-a', 'A社フォーム', 'account-a')]
        : [form('source-b', 'B社フォーム', 'account-b')],
    ))
    const { rerender } = render(<Page />)
    await screen.findByTestId('form-card-source-a')
    fireEvent.click(screen.getByTestId('duplicate-source-a'))

    mockAccount.selectedAccountId = 'account-b'
    rerender(<Page />)
    await screen.findByTestId('form-card-source-b')
    mockAccount.selectedAccountId = 'account-a'
    rerender(<Page />)
    await screen.findByTestId('form-card-source-a')

    expect((screen.getByTestId('duplicate-source-a') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('duplicate-source-a'))
    expect(duplicateMock).toHaveBeenCalledTimes(1)
    const accountACallsBeforeOldCompletion = listMock.mock.calls
      .filter(([accountId]) => accountId === 'account-a').length

    await act(async () => {
      resolveDuplicate(form('copy-a', 'A社フォーム のコピー', 'account-a'))
    })
    await act(async () => { await Promise.resolve() })

    expect(listMock.mock.calls.filter(([accountId]) => accountId === 'account-a'))
      .toHaveLength(accountACallsBeforeOldCompletion)
    expect(screen.getByTestId('form-card-source-a')).toBeTruthy()
  })

  it('複製成功後の一覧再取得に失敗しても元一覧を保ち、日本語で再取得失敗を表示する', async () => {
    listMock
      .mockResolvedValueOnce([form('source-a', '夢花火2026申し込み')])
      .mockRejectedValueOnce(new Error('list failed'))
    duplicateMock.mockResolvedValue(form('copy-a', '夢花火2026申し込み のコピー'))
    render(<Page />)
    await screen.findByTestId('form-card-source-a')

    fireEvent.click(screen.getByTestId('duplicate-source-a'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('一覧の再取得に失敗しました')
    expect(screen.getByTestId('form-card-source-a')).toBeTruthy()
    expect((screen.getByTestId('duplicate-source-a') as HTMLButtonElement).disabled).toBe(false)
  })
})
