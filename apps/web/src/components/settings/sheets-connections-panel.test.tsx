// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import SheetsConnectionsPanel, { type SheetsConnectionsPanelProps } from './sheets-connections-panel'
import type { SheetsConnection } from '@/lib/sheets-connections-api'

afterEach(() => cleanup())

const connection: SheetsConnection = {
  id: 'gsc_1', lineAccountId: 'acc-1', formId: 'form-1', spreadsheetId: 'sheet_1',
  sheetName: '回答', syncDirection: 'bidirectional', conflictPolicy: 'last_write_wins',
  isActive: true, createdAt: '2026-07-20', updatedAt: '2026-07-20',
}

function props(overrides: Partial<SheetsConnectionsPanelProps> = {}): SheetsConnectionsPanelProps {
  return {
    connections: [connection],
    onCreate: vi.fn(),
    onUpdate: vi.fn(),
    onRemove: vi.fn(),
    onTest: vi.fn(),
    testResults: {},
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

  test('requires form/spreadsheet/sheet and creates with the selected direction', () => {
    const p = props({ connections: [] })
    render(<SheetsConnectionsPanel {...p} />)
    const save = screen.getByTestId('sheets-save') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fill('sheets-form-id', ' form-2 ')
    fill('sheets-spreadsheet-id', ' sheet_2 ')
    fill('sheets-sheet-name', ' 集計 ')
    fireEvent.change(screen.getByTestId('sheets-direction'), { target: { value: 'from_sheets' } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    expect(p.onCreate).toHaveBeenCalledWith({
      formId: 'form-2', spreadsheetId: 'sheet_2', sheetName: '集計', syncDirection: 'from_sheets',
    })
  })

  test('edit loads the saved values, locks form ID, and updates mutable settings', () => {
    const p = props()
    render(<SheetsConnectionsPanel {...p} />)
    fireEvent.click(screen.getByTestId('sheets-edit-gsc_1'))
    expect((screen.getByTestId('sheets-form-id') as HTMLInputElement).value).toBe('form-1')
    expect((screen.getByTestId('sheets-form-id') as HTMLInputElement).disabled).toBe(true)
    fill('sheets-sheet-name', '集計')
    fireEvent.change(screen.getByTestId('sheets-direction'), { target: { value: 'to_sheets' } })
    fireEvent.click(screen.getByTestId('sheets-save'))
    expect(p.onUpdate).toHaveBeenCalledWith('gsc_1', {
      spreadsheetId: 'sheet_1', sheetName: '集計', syncDirection: 'to_sheets',
    })
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
