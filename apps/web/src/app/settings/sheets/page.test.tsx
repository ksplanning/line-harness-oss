// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  account: { selectedAccountId: 'acc-1' as string | null, loading: false },
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  testConnection: vi.fn(),
  sync: vi.fn(),
  audit: vi.fn(),
  listFieldDefinitions: vi.fn(),
}))

vi.mock('@/contexts/account-context', () => ({ useAccount: () => mocks.account }))
vi.mock('@/components/layout/header', () => ({ default: () => null }))
vi.mock('@/lib/sheets-connections-api', () => ({
  sheetsConnectionsApi: {
    list: (...args: unknown[]) => mocks.list(...args),
    create: (...args: unknown[]) => mocks.create(...args),
    update: (...args: unknown[]) => mocks.update(...args),
    remove: (...args: unknown[]) => mocks.remove(...args),
    test: (...args: unknown[]) => mocks.testConnection(...args),
    sync: (...args: unknown[]) => mocks.sync(...args),
    audit: (...args: unknown[]) => mocks.audit(...args),
  },
}))
vi.mock('@/lib/api', () => ({
  api: {
    friendFieldDefinitions: {
      list: (...args: unknown[]) => mocks.listFieldDefinitions(...args),
    },
  },
}))

import SheetsSettingsPage from './page'

const item = (id: string, account = 'acc-1') => ({
  id, lineAccountId: account, formId: `form-${id}`, spreadsheetId: `sheet_${id}`,
  sheetName: '回答', syncDirection: 'bidirectional' as const, conflictPolicy: 'last_write_wins' as const,
  friendFieldMappings: [{ fieldId: 'field-rank', header: '会員ランク' }],
  friendLedgerEnabled: true,
  lastSyncAt: '2026-07-21T10:00:00.000+09:00', lastSyncStatus: 'success' as const, lastSyncWarning: null,
  isActive: true, createdAt: '2026-07-20', updatedAt: '2026-07-20',
})

const fieldDefinitions = [
  {
    id: 'field-rank', name: '会員ランク', defaultValue: '', displayOrder: 1,
    isActive: true, createdAt: '2026-07-20', updatedAt: '2026-07-20',
  },
  {
    id: 'field-inactive', name: '停止中の項目', defaultValue: '', displayOrder: 2,
    isActive: false, createdAt: '2026-07-20', updatedAt: '2026-07-20',
  },
]

const auditEntry = (actor: string) => ({
  actor,
  fieldName: '会員ランク',
  oldValue: '一般',
  newValue: 'VIP',
  source: 'sheet',
  changeKind: 'custom_field',
})

beforeEach(() => {
  mocks.account.selectedAccountId = 'acc-1'
  mocks.account.loading = false
  mocks.list.mockReset().mockResolvedValue([item('one')])
  mocks.create.mockReset().mockResolvedValue(item('new'))
  mocks.update.mockReset().mockResolvedValue(item('one'))
  mocks.remove.mockReset().mockResolvedValue(undefined)
  mocks.testConnection.mockReset().mockResolvedValue(true)
  mocks.sync.mockReset().mockResolvedValue({ status: 'success', warning: null })
  mocks.audit.mockReset().mockResolvedValue([])
  mocks.listFieldDefinitions.mockReset().mockResolvedValue({ success: true, data: fieldDefinitions })
})

afterEach(() => cleanup())

describe('Sheets settings page', () => {
  test('loads only the selected LINE account and creates in that account', async () => {
    render(<SheetsSettingsPage />)
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith('acc-1'))
    await screen.findByTestId('sheets-item-one')
    const field = await screen.findByRole('checkbox', { name: '会員ランク' })
    expect(screen.queryByRole('checkbox', { name: '停止中の項目' })).toBeNull()
    fireEvent.change(screen.getByTestId('sheets-form-id'), { target: { value: 'form-new' } })
    fireEvent.change(screen.getByTestId('sheets-spreadsheet-id'), { target: { value: 'sheet_new' } })
    fireEvent.click(field)
    fireEvent.click(screen.getByTestId('sheets-save'))
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({
      lineAccountId: 'acc-1', formId: 'form-new', spreadsheetId: 'sheet_new',
      sheetName: 'Sheet1', syncDirection: 'bidirectional', selectedFieldIds: ['field-rank'],
    }))
  })

  test('does not call API without an account and shows a selection hint', () => {
    mocks.account.selectedAccountId = null
    render(<SheetsSettingsPage />)
    expect(mocks.list).not.toHaveBeenCalled()
    expect(screen.getByTestId('sheets-account-required').textContent).toContain('LINEアカウント')
  })

  test('discards a stale list response after account switch', async () => {
    let resolveOld!: (value: ReturnType<typeof item>[]) => void
    mocks.list.mockImplementation((accountId: string) => {
      if (accountId === 'acc-1') return new Promise((resolve) => { resolveOld = resolve })
      return Promise.resolve([item('new-account', 'acc-2')])
    })
    const view = render(<SheetsSettingsPage />)
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith('acc-1'))
    mocks.account.selectedAccountId = 'acc-2'
    view.rerender(<SheetsSettingsPage />)
    await screen.findByTestId('sheets-item-new-account')
    resolveOld([item('stale')])
    await Promise.resolve()
    expect(screen.queryByTestId('sheets-item-stale')).toBeNull()
    expect(screen.getByTestId('sheets-item-new-account')).toBeTruthy()
  })

  test('resets an account-scoped edit draft when the selected account changes', async () => {
    mocks.list.mockImplementation((accountId: string) => Promise.resolve([
      item(accountId === 'acc-1' ? 'one' : 'two', accountId),
    ]))
    const view = render(<SheetsSettingsPage />)
    await screen.findByTestId('sheets-item-one')
    fireEvent.click(screen.getByTestId('sheets-edit-one'))
    fireEvent.change(screen.getByTestId('sheets-spreadsheet-id'), { target: { value: 'account-a-draft' } })

    mocks.account.selectedAccountId = 'acc-2'
    view.rerender(<SheetsSettingsPage />)
    await screen.findByTestId('sheets-item-two')

    expect((screen.getByTestId('sheets-form-id') as HTMLInputElement).disabled).toBe(false)
    expect((screen.getByTestId('sheets-form-id') as HTMLInputElement).value).toBe('')
    expect((screen.getByTestId('sheets-spreadsheet-id') as HTMLInputElement).value).toBe('')
  })

  test('clears an old successful test result when settings are updated', async () => {
    render(<SheetsSettingsPage />)
    await screen.findByTestId('sheets-item-one')
    fireEvent.click(screen.getByTestId('sheets-test-one'))
    await screen.findByTestId('sheets-test-result-one')

    fireEvent.click(screen.getByTestId('sheets-edit-one'))
    fireEvent.change(screen.getByTestId('sheets-sheet-name'), { target: { value: '変更後' } })
    fireEvent.click(screen.getByTestId('sheets-save'))
    await waitFor(() => expect(mocks.update).toHaveBeenCalledTimes(1))

    expect(screen.queryByTestId('sheets-test-result-one')).toBeNull()
  })

  test('clears a previous setup error before a successful retry', async () => {
    mocks.testConnection.mockRejectedValueOnce({ body: { error: '秘密設定を確認してください' } }).mockResolvedValueOnce(true)
    render(<SheetsSettingsPage />)
    await screen.findByTestId('sheets-item-one')

    fireEvent.click(screen.getByTestId('sheets-test-one'))
    await screen.findByTestId('sheets-error')
    fireEvent.click(screen.getByTestId('sheets-test-one'))
    await waitFor(() => expect(screen.getByTestId('sheets-test-result-one').textContent).toContain('接続できました'))

    expect(screen.queryByTestId('sheets-error')).toBeNull()
  })

  test('runs self-hosted manual sync, shows its summary, and refreshes recent audit', async () => {
    mocks.audit
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([auditEntry('オーナー')])
    render(<SheetsSettingsPage />)
    await screen.findByTestId('sheets-item-one')

    fireEvent.click(screen.getByTestId('sheets-sync-one'))

    await waitFor(() => expect(mocks.sync).toHaveBeenCalledWith('acc-1', 'one'))
    const result = await screen.findByTestId('sheets-sync-result-one')
    expect(result.textContent).toContain('手動同期が完了しました')
    await waitFor(() => expect(mocks.audit).toHaveBeenLastCalledWith('acc-1', 'one'))
    expect((await screen.findByTestId('sheets-audit-one')).textContent).toContain('オーナー')
  })

  test('discards a stale manual-sync result after the selected account changes', async () => {
    let resolveOldSync!: (value: { status: string; warning: string | null }) => void
    mocks.list.mockImplementation((accountId: string) => Promise.resolve([
      item(accountId === 'acc-1' ? 'one' : 'two', accountId),
    ]))
    mocks.sync.mockImplementation((accountId: string) => {
      if (accountId === 'acc-1') return new Promise((resolve) => { resolveOldSync = resolve })
      return Promise.resolve({ status: 'success', warning: null })
    })
    const view = render(<SheetsSettingsPage />)
    await screen.findByTestId('sheets-item-one')
    fireEvent.click(screen.getByTestId('sheets-sync-one'))
    await waitFor(() => expect(mocks.sync).toHaveBeenCalledWith('acc-1', 'one'))

    mocks.account.selectedAccountId = 'acc-2'
    view.rerender(<SheetsSettingsPage />)
    await screen.findByTestId('sheets-item-two')
    resolveOldSync({ status: 'warning', warning: '古いアカウントの警告' })
    await Promise.resolve()
    await Promise.resolve()

    expect(screen.queryByText('古いアカウントの警告')).toBeNull()
    expect(screen.queryByTestId('sheets-sync-result-one')).toBeNull()
    expect(screen.getByTestId('sheets-item-two')).toBeTruthy()
  })

  test('discards stale audit rows and keeps the new account audit visible', async () => {
    let resolveOldAudit!: (value: ReturnType<typeof auditEntry>[]) => void
    mocks.list.mockImplementation((accountId: string) => Promise.resolve([
      item(accountId === 'acc-1' ? 'one' : 'two', accountId),
    ]))
    mocks.audit.mockImplementation((accountId: string) => {
      if (accountId === 'acc-1') return new Promise((resolve) => { resolveOldAudit = resolve })
      return Promise.resolve([auditEntry('アカウントB担当')])
    })
    const view = render(<SheetsSettingsPage />)
    await screen.findByTestId('sheets-item-one')
    await waitFor(() => expect(mocks.audit).toHaveBeenCalledWith('acc-1', 'one'))

    mocks.account.selectedAccountId = 'acc-2'
    view.rerender(<SheetsSettingsPage />)
    await screen.findByTestId('sheets-item-two')
    await screen.findByText('アカウントB担当')
    resolveOldAudit([auditEntry('古いアカウントA担当')])
    await Promise.resolve()
    await Promise.resolve()

    expect(screen.queryByText('古いアカウントA担当')).toBeNull()
    expect(screen.getByText('アカウントB担当')).toBeTruthy()
  })
})
