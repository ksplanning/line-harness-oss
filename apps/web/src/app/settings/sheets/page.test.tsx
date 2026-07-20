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
  },
}))

import SheetsSettingsPage from './page'

const item = (id: string, account = 'acc-1') => ({
  id, lineAccountId: account, formId: `form-${id}`, spreadsheetId: `sheet_${id}`,
  sheetName: '回答', syncDirection: 'bidirectional' as const, conflictPolicy: 'last_write_wins' as const,
  isActive: true, createdAt: '2026-07-20', updatedAt: '2026-07-20',
})

beforeEach(() => {
  mocks.account.selectedAccountId = 'acc-1'
  mocks.account.loading = false
  mocks.list.mockReset().mockResolvedValue([item('one')])
  mocks.create.mockReset().mockResolvedValue(item('new'))
  mocks.update.mockReset().mockResolvedValue(item('one'))
  mocks.remove.mockReset().mockResolvedValue(undefined)
  mocks.testConnection.mockReset().mockResolvedValue(true)
})

afterEach(() => cleanup())

describe('Sheets settings page', () => {
  test('loads only the selected LINE account and creates in that account', async () => {
    render(<SheetsSettingsPage />)
    await waitFor(() => expect(mocks.list).toHaveBeenCalledWith('acc-1'))
    await screen.findByTestId('sheets-item-one')
    fireEvent.change(screen.getByTestId('sheets-form-id'), { target: { value: 'form-new' } })
    fireEvent.change(screen.getByTestId('sheets-spreadsheet-id'), { target: { value: 'sheet_new' } })
    fireEvent.click(screen.getByTestId('sheets-save'))
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({
      lineAccountId: 'acc-1', formId: 'form-new', spreadsheetId: 'sheet_new',
      sheetName: 'Sheet1', syncDirection: 'bidirectional',
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
})
