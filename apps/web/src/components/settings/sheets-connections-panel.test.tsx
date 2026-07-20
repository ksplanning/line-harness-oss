// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import SheetsConnectionsPanel, { type SheetsConnectionsPanelProps } from './sheets-connections-panel'
import type { SheetsConnection } from '@/lib/sheets-connections-api'
import type { FriendFieldDefinition } from '@line-crm/shared'

afterEach(() => cleanup())

const connection: SheetsConnection = {
  id: 'gsc_1', lineAccountId: 'acc-1', formId: 'form-1', spreadsheetId: 'sheet_1',
  sheetName: '回答', syncDirection: 'bidirectional', conflictPolicy: 'last_write_wins',
  friendFieldMappings: [{ fieldId: 'field-rank', header: '会員ランク' }],
  lastSyncAt: '2026-07-21T10:00:00.000+09:00', lastSyncStatus: 'success', lastSyncWarning: null,
  isActive: true, createdAt: '2026-07-20', updatedAt: '2026-07-20',
}

const fieldDefinitions: FriendFieldDefinition[] = [
  {
    id: 'field-rank', name: '会員ランク', defaultValue: '', displayOrder: 1,
    isActive: true, createdAt: '2026-07-20', updatedAt: '2026-07-20',
  },
  {
    id: 'field-note', name: '担当者メモ', defaultValue: '', displayOrder: 2,
    isActive: true, createdAt: '2026-07-20', updatedAt: '2026-07-20',
  },
]

const auditEntry = {
  actor: 'オーナー',
  fieldName: '会員ランク',
  oldValue: '一般',
  newValue: 'VIP',
  source: 'sheet',
  changeKind: 'custom_field',
}

function props(overrides: Partial<SheetsConnectionsPanelProps> = {}): SheetsConnectionsPanelProps {
  return {
    connections: [connection],
    onCreate: vi.fn(),
    onUpdate: vi.fn(),
    onRemove: vi.fn(),
    onTest: vi.fn(),
    onSync: vi.fn(),
    fieldDefinitions,
    testResults: {},
    syncResults: {},
    auditEntries: {},
    ...overrides,
  }
}

function fill(testId: string, value: string): void {
  fireEvent.change(screen.getByTestId(testId), { target: { value } })
}

describe('SheetsConnectionsPanel', () => {
  test('shows saved settings and wires connection test/delete', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const p = props()
    render(<SheetsConnectionsPanel {...p} />)
    expect(screen.getByTestId('sheets-item-gsc_1').textContent).toContain('form-1')
    expect(screen.getByTestId('sheets-item-gsc_1').textContent).toContain('回答')
    expect(screen.getByTestId('sheets-item-gsc_1').textContent).toContain('双方向')
    expect(screen.getByTestId('sheets-item-gsc_1').textContent).toContain('接続ID: gsc_1')
    expect(screen.getByTestId('sheets-item-gsc_1').textContent).toContain('シートID: sheet_1')
    fireEvent.click(screen.getByTestId('sheets-test-gsc_1'))
    expect(p.onTest).toHaveBeenCalledWith('gsc_1')
    fireEvent.click(screen.getByTestId('sheets-remove-gsc_1'))
    expect(p.onRemove).toHaveBeenCalledWith('gsc_1')
  })

  test('requires confirmation before removing a connection', () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const p = props()
    render(<SheetsConnectionsPanel {...p} />)

    fireEvent.click(screen.getByTestId('sheets-remove-gsc_1'))

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(p.onRemove).not.toHaveBeenCalled()
  })

  test('blocks edit and remove while that connection test is running', () => {
    render(<SheetsConnectionsPanel {...props({ testResults: { gsc_1: 'testing' } })} />)

    expect((screen.getByTestId('sheets-edit-gsc_1') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('sheets-remove-gsc_1') as HTMLButtonElement).disabled).toBe(true)
  })

  test('requires form/spreadsheet/sheet and creates with selected active friend fields', () => {
    const p = props({ connections: [] })
    render(<SheetsConnectionsPanel {...p} />)
    const save = screen.getByTestId('sheets-save') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fill('sheets-form-id', ' form-2 ')
    fill('sheets-spreadsheet-id', ' sheet_2 ')
    fill('sheets-sheet-name', ' 集計 ')
    fireEvent.change(screen.getByTestId('sheets-direction'), { target: { value: 'from_sheets' } })
    fireEvent.click(screen.getByRole('checkbox', { name: '会員ランク' }))
    fireEvent.click(screen.getByRole('checkbox', { name: '担当者メモ' }))
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    expect(p.onCreate).toHaveBeenCalledWith({
      formId: 'form-2', spreadsheetId: 'sheet_2', sheetName: '集計', syncDirection: 'from_sheets',
      selectedFieldIds: ['field-rank', 'field-note'],
    })
  })

  test('uses friend-ledger wording for every sync direction instead of answer-sheet wording', () => {
    render(<SheetsConnectionsPanel {...props({ connections: [] })} />)

    expect(screen.getByRole('option', { name: '友だち情報 → シート' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'シート → 友だち情報' })).toBeTruthy()
    expect(screen.getByRole('option', { name: '双方向（友だち情報 ↔ シート）' })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /回答/ })).toBeNull()
  })

  test('uses readable small-text and primary-action contrast', () => {
    render(<SheetsConnectionsPanel {...props({ connections: [] })} />)

    expect(screen.getByTestId('sheets-empty').className).toContain('text-gray-600')
    expect(screen.getByTestId('sheets-save').className).toContain('bg-[#087A39]')
  })

  test('edit loads the saved values, locks form ID, and updates mutable settings', () => {
    const p = props()
    render(<SheetsConnectionsPanel {...p} />)
    fireEvent.click(screen.getByTestId('sheets-edit-gsc_1'))
    expect((screen.getByTestId('sheets-form-id') as HTMLInputElement).value).toBe('form-1')
    expect((screen.getByTestId('sheets-form-id') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('checkbox', { name: '会員ランク' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByRole('checkbox', { name: '担当者メモ' }))
    fill('sheets-sheet-name', '集計')
    fireEvent.change(screen.getByTestId('sheets-direction'), { target: { value: 'to_sheets' } })
    fireEvent.click(screen.getByTestId('sheets-save'))
    expect(p.onUpdate).toHaveBeenCalledWith('gsc_1', {
      spreadsheetId: 'sheet_1', sheetName: '集計', syncDirection: 'to_sheets',
      selectedFieldIds: ['field-rank', 'field-note'],
    })
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
