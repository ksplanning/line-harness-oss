// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import SheetsConnectionsPanel, { type SheetsConnectionsPanelProps } from './sheets-connections-panel'
import type { SheetsConnection } from '@/lib/sheets-connections-api'

afterEach(() => cleanup())

const connection: SheetsConnection = {
  id: 'gsc_1', lineAccountId: 'acc-1', formId: 'form-1', formName: '入会フォーム', spreadsheetId: 'sheet_1',
  sheetName: '友だち台帳', syncDirection: 'bidirectional', conflictPolicy: 'last_write_wins',
  friendFieldMappings: [{ fieldId: 'field-rank', header: '会員ランク' }],
  friendLedgerEnabled: true,
  formResultsEnabled: true,
  formResultsSheetName: '回答',
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

function durableSyncResult(overrides: {
  status: 'running' | 'success' | 'warning' | 'error'
  processedCount: number
  totalCount: number
  errorMessage: string | null
  warning: string | null
}): SheetsConnectionsPanelProps['syncResults'] {
  return { gsc_1: overrides } as unknown as SheetsConnectionsPanelProps['syncResults']
}

describe('SheetsConnectionsPanel', () => {
  test('shows form names and operational status without exposing internal IDs', () => {
    const p = props()
    render(<SheetsConnectionsPanel {...p} />)
    const item = screen.getByTestId('sheets-item-gsc_1')
    expect(item.textContent).toContain('入会フォーム')
    expect(item.textContent).toContain('友だち台帳: 同期する（友だち台帳）')
    expect(item.textContent).toContain('フォーム回答シート: 同期する（回答）')
    expect(item.textContent).toContain('双方向')
    expect(item.textContent).toContain('成功')
    expect(item.textContent).toContain('2026-07-21T10:00:00.000+09:00')
    expect(item.textContent).not.toContain('form-1')
    expect(item.textContent).not.toContain('gsc_1')
    expect(item.textContent).not.toContain('sheet_1')
    fireEvent.click(screen.getByTestId('sheets-test-gsc_1'))
    expect(p.onTest).toHaveBeenCalledWith('gsc_1')
  })

  test('台帳とフォーム回答をそれぞれ同期しない設定も日常語で表示する', () => {
    render(<SheetsConnectionsPanel {...props({
      connections: [{
        ...connection,
        friendLedgerEnabled: false,
        formResultsEnabled: false,
        formResultsSheetName: null,
      }],
    })} />)

    const item = screen.getByTestId('sheets-item-gsc_1')
    expect(item.textContent).toContain('友だち台帳: 同期しない')
    expect(item.textContent).toContain('フォーム回答シート: 同期しない')
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

  test('shows exact durable progress and disables manual sync while a job is running', () => {
    render(<SheetsConnectionsPanel {...props({
      syncResults: durableSyncResult({
        status: 'running',
        processedCount: 400,
        totalCount: 1450,
        errorMessage: null,
        warning: null,
      }),
    })} />)

    const button = screen.getByTestId('sheets-sync-gsc_1') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.textContent).toContain('同期中')
    expect(screen.getByTestId('sheets-item-gsc_1').textContent).toContain('処理済み 400 / 1450件')
    expect(screen.queryByText('手動同期が完了しました。')).toBeNull()
  })

  test('shows durable failure progress and its safe error, then offers continuation', () => {
    const p = props({
      syncResults: durableSyncResult({
        status: 'error',
        processedCount: 600,
        totalCount: 1450,
        errorMessage: 'Google Sheets への書き込みが時間内に完了しませんでした。',
        warning: null,
      }),
    })
    render(<SheetsConnectionsPanel {...p} />)

    const item = screen.getByTestId('sheets-item-gsc_1')
    expect(item.textContent).toContain('600 / 1450件まで処理しました')
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Google Sheets への書き込みが時間内に完了しませんでした。')
    expect(alert.textContent).not.toContain('共有設定を確認')

    const button = screen.getByTestId('sheets-sync-gsc_1') as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(button.textContent).toContain('続きから再開')
    fireEvent.click(button)
    expect(p.onSync).toHaveBeenCalledWith('gsc_1')
  })

  test('keeps the legacy success and warning copy for completed durable jobs', () => {
    const { rerender } = render(<SheetsConnectionsPanel {...props({
      syncResults: durableSyncResult({
        status: 'success',
        processedCount: 1450,
        totalCount: 1450,
        errorMessage: null,
        warning: null,
      }),
    })} />)

    expect(screen.getByTestId('sheets-sync-result-gsc_1').textContent).toContain('手動同期が完了しました。')

    rerender(<SheetsConnectionsPanel {...props({
      syncResults: durableSyncResult({
        status: 'warning',
        processedCount: 1450,
        totalCount: 1450,
        errorMessage: null,
        warning: '見出しが変わった1列は安全のため取り込みませんでした。',
      }),
    })} />)

    const warning = screen.getByTestId('sheets-sync-result-gsc_1')
    expect(warning.getAttribute('role')).toBe('alert')
    expect(warning.textContent).toContain('手動同期は警告つきで完了しました。')
    expect(warning.textContent).toContain('見出しが変わった1列は安全のため取り込みませんでした。')
  })

  test('labels polling completion honestly and does not repeat a legacy warning beside its durable result', () => {
    const legacyWarning = '前回の定期同期で見出しが変わりました。'
    const pollingJob = {
      status: 'warning' as const,
      source: 'polling' as const,
      processedCount: 1450,
      totalCount: 1450,
      errorMessage: null,
      warning: legacyWarning,
    }
    const { rerender } = render(<SheetsConnectionsPanel {...props({
      connections: [{
        ...connection,
        lastSyncStatus: 'warning',
        lastSyncWarning: legacyWarning,
        latestSyncJob: pollingJob as unknown as NonNullable<SheetsConnection['latestSyncJob']>,
      }],
    })} />)

    const warning = screen.getByTestId('sheets-sync-result-gsc_1')
    expect(warning.textContent).toContain('定期同期は警告つきで完了しました。')
    expect(warning.textContent).not.toContain('手動同期')
    expect(screen.getByTestId('sheets-item-gsc_1').textContent?.split(legacyWarning)).toHaveLength(2)

    rerender(<SheetsConnectionsPanel {...props({
      connections: [{
        ...connection,
        latestSyncJob: {
          ...pollingJob,
          status: 'success',
          warning: null,
        } as unknown as NonNullable<SheetsConnection['latestSyncJob']>,
      }],
    })} />)

    expect(screen.getByTestId('sheets-sync-result-gsc_1').textContent).toContain('定期同期が完了しました。')
  })

  test('does not repeat a legacy connection warning when the durable job has stopped with an error', () => {
    const legacyWarning = '古い接続エラーです。'
    render(<SheetsConnectionsPanel {...props({
      connections: [{
        ...connection,
        lastSyncStatus: 'error',
        lastSyncWarning: legacyWarning,
        latestSyncJob: {
          status: 'error',
          source: 'polling',
          processedCount: 600,
          totalCount: 1450,
          errorMessage: '定期同期を続きから再開してください。',
          warning: null,
        } as unknown as NonNullable<SheetsConnection['latestSyncJob']>,
      }],
    })} />)

    expect(screen.getByTestId('sheets-item-gsc_1').textContent).not.toContain(legacyWarning)
    expect(screen.getByRole('alert').textContent).toContain('定期同期を続きから再開してください。')
  })

  test('keeps an interrupted-worker recovery warning visible with its durable progress', () => {
    const recovery = '前回の同期が途中で止まりました。保存済みの続きから再開しました。'
    render(<SheetsConnectionsPanel {...props({
      syncResults: durableSyncResult({
        status: 'running',
        processedCount: 800,
        totalCount: 1450,
        errorMessage: null,
        warning: recovery,
      }),
    })} />)

    expect(screen.getByTestId('sheets-sync-result-gsc_1').textContent).toContain('処理済み 800 / 1450件')
    expect(screen.getByRole('alert').textContent).toContain(recovery)
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
