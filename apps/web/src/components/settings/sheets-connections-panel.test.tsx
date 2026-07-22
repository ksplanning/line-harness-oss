// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import SheetsConnectionsPanel, { type SheetsConnectionsPanelProps } from './sheets-connections-panel'
import type { SheetsConnection } from '@/lib/sheets-connections-api'

afterEach(() => cleanup())

const connection: SheetsConnection = {
  id: 'gsc_1', lineAccountId: 'acc-1', formId: 'form-1', formName: '入会フォーム', spreadsheetId: 'sheet_1',
  sheetName: '回答', syncDirection: 'bidirectional', conflictPolicy: 'last_write_wins',
  friendFieldMappings: [{ fieldId: 'field-rank', header: '会員ランク' }],
  friendLedgerEnabled: true,
  lastSyncAt: '2026-07-21T10:00:00.000+09:00', lastSyncStatus: 'success', lastSyncWarning: null,
  isActive: true, createdAt: '2026-07-20', updatedAt: '2026-07-20',
}

const auditEntry = {
  actor: 'オーナー',
  fieldName: '会員ランク',
  oldValue: '一般',
  newValue: 'VIP',
  source: 'sheet',
  changeKind: 'custom_field',
  outcome: 'skipped' as const,
  errorCode: 'stale_webhook_target',
}

function props(overrides: Partial<SheetsConnectionsPanelProps> = {}): SheetsConnectionsPanelProps {
  return {
    connections: [connection],
    onTest: vi.fn(),
    onSync: vi.fn(),
    testResults: {},
    syncResults: {},
    auditEntries: {},
    ...overrides,
  }
}

describe('SheetsConnectionsPanel', () => {
  test('shows form names and operational status without exposing internal IDs', () => {
    const p = props()
    render(<SheetsConnectionsPanel {...p} />)
    const item = screen.getByTestId('sheets-item-gsc_1')
    expect(item.textContent).toContain('入会フォーム')
    expect(item.textContent).toContain('回答')
    expect(item.textContent).toContain('双方向')
    expect(item.textContent).toContain('成功')
    expect(item.textContent).toContain('2026-07-21T10:00:00.000+09:00')
    expect(item.textContent).not.toContain('form-1')
    expect(item.textContent).not.toContain('gsc_1')
    expect(item.textContent).not.toContain('sheet_1')
    fireEvent.click(screen.getByTestId('sheets-test-gsc_1'))
    expect(p.onTest).toHaveBeenCalledWith('gsc_1')
  })

  test('is a monitoring page and directs setup to each form builder', () => {
    render(<SheetsConnectionsPanel {...props({ connections: [] })} />)

    expect(screen.getByTestId('sheets-empty').className).toContain('text-gray-600')
    expect(screen.getByText(/各フォームのビルダー/)).toBeTruthy()
    expect(screen.getByRole('link', { name: /フォーム一覧/ }).getAttribute('href')).toBe('/forms-advanced')
    expect(screen.queryByTestId('sheets-form-id')).toBeNull()
    expect(screen.queryByTestId('sheets-spreadsheet-id')).toBeNull()
    expect(screen.queryByText('接続を登録')).toBeNull()
    expect(screen.queryByText('編集')).toBeNull()
    expect(screen.queryByText('削除')).toBeNull()
  })

  test('links a named connection to its form builder response settings', () => {
    render(<SheetsConnectionsPanel {...props()} />)

    const link = screen.getByRole('link', { name: '入会フォームの「回答後の動き」を開く' })
    expect(link.getAttribute('href')).toBe('/forms-advanced/detail?id=form-1')
  })

  test('shows last sync status and warning, and wires the self-hosted manual sync button', () => {
    const p = props({
      connections: [{
        ...connection,
        lastSyncStatus: 'warning',
        lastSyncWarning: '見出し「会員ランク」が変更されたため取り込みませんでした',
      }],
    })
    render(<SheetsConnectionsPanel {...p} />)

    const item = screen.getByTestId('sheets-item-gsc_1')
    expect(item.textContent).toContain('最終同期')
    expect(item.textContent).toContain('警告')
    expect(screen.getByRole('alert').textContent).toContain('見出し「会員ランク」')

    fireEvent.click(screen.getByTestId('sheets-sync-gsc_1'))
    expect(p.onSync).toHaveBeenCalledWith('gsc_1')
  })

  test('disables manual sync while it is running', () => {
    render(<SheetsConnectionsPanel {...props({ syncResults: { gsc_1: { status: 'running' } } })} />)

    const button = screen.getByTestId('sheets-sync-gsc_1') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('同期中')
  })

  test('shows recent audit actor, field, before/after values, source, and change kind', () => {
    render(<SheetsConnectionsPanel {...props({ auditEntries: { gsc_1: [auditEntry] } })} />)

    const audit = screen.getByTestId('sheets-audit-gsc_1')
    expect(audit.textContent).toContain('オーナー')
    expect(audit.textContent).toContain('会員ランク')
    expect(audit.textContent).toContain('一般')
    expect(audit.textContent).toContain('VIP')
    expect(audit.textContent).toContain('シート')
    expect(audit.textContent).toContain('カスタムフィールド')
    expect(audit.textContent).toContain('安全のため取り込まず')
  })

  test('renders empty/error and per-connection test states in plain language', () => {
    const { rerender } = render(<SheetsConnectionsPanel {...props({ connections: [], error: '保存できませんでした' })} />)
    expect(screen.getByTestId('sheets-empty')).toBeTruthy()
    expect(screen.getByTestId('sheets-error').textContent).toContain('保存できませんでした')
    rerender(<SheetsConnectionsPanel {...props({ testResults: { gsc_1: 'ok' } })} />)
    expect(screen.getByTestId('sheets-test-result-gsc_1').textContent).toContain('接続できました')
    expect(screen.getByTestId('sheets-test-result-gsc_1').getAttribute('role')).toBe('status')
    rerender(<SheetsConnectionsPanel {...props({ testResults: { gsc_1: 'ng' } })} />)
    expect(screen.getByTestId('sheets-test-result-gsc_1').textContent).toContain('接続できませんでした')
    expect(screen.getByTestId('sheets-test-result-gsc_1').getAttribute('role')).toBe('alert')
  })
})
