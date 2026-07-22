// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  account: { selectedAccountId: 'acc-1' as string | null, loading: false },
  list: vi.fn(),
  testConnection: vi.fn(),
  sync: vi.fn(),
  audit: vi.fn(),
}))

vi.mock('@/contexts/account-context', () => ({ useAccount: () => mocks.account }))
vi.mock('@/components/layout/header', () => ({ default: () => null }))
vi.mock('@/lib/sheets-connections-api', () => ({
  sheetsConnectionsApi: {
    list: (...args: unknown[]) => mocks.list(...args),
    test: (...args: unknown[]) => mocks.testConnection(...args),
    sync: (...args: unknown[]) => mocks.sync(...args),
    audit: (...args: unknown[]) => mocks.audit(...args),
  },
}))
import SheetsSettingsPage from './page'

const item = (id: string, account = 'acc-1') => ({
  id, lineAccountId: account, formId: `form-${id}`, formName: `${id} の申込フォーム`, spreadsheetId: `sheet_${id}`,
  sheetName: '回答', syncDirection: 'bidirectional' as const, conflictPolicy: 'last_write_wins' as const,
  friendFieldMappings: [{ fieldId: 'field-rank', header: '会員ランク' }],
  friendLedgerEnabled: true,
  lastSyncAt: '2026-07-21T10:00:00.000+09:00', lastSyncStatus: 'success' as const, lastSyncWarning: null,
  isActive: true, createdAt: '2026-07-20', updatedAt: '2026-07-20',
})

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
  mocks.testConnection.mockReset().mockResolvedValue(true)
  mocks.sync.mockReset().mockResolvedValue({ status: 'success', warning: null })
  mocks.audit.mockReset().mockResolvedValue([])
})

afterEach(() => cleanup())

describe('Sheets settings page', () => {
  test('loads only the selected LINE account as a read-only monitoring page', async () => {
    render(<SheetsSettingsPage />)
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith('acc-1'))
    const row = await screen.findByTestId('sheets-item-one')
    expect(row.textContent).toContain('one の申込フォーム')
    expect(row.textContent).not.toContain('form-one')
    expect(row.textContent).not.toContain('sheet_one')
    expect(screen.queryByTestId('sheets-form-id')).toBeNull()
    expect(screen.queryByTestId('sheets-spreadsheet-id')).toBeNull()
    expect(screen.getByRole('link', { name: 'one の申込フォームの「回答後の動き」を開く' })).toBeTruthy()
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
