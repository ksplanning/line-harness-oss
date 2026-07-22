// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { HarnessField, HarnessFieldConfig, HarnessFieldType } from '@line-crm/shared'
import InternalSheetsSetupPanel, { type InternalSheetsSetupPanelProps } from './internal-sheets-setup-panel'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function field(
  id: string,
  type: HarnessFieldType,
  label: string,
  config: HarnessFieldConfig = {},
): HarnessField {
  return { id, type, label, required: false, position: 0, config }
}

const SYNC_FIELDS: HarnessField[] = [
  field('name', 'text', 'お名前'),
  field('intro', 'section', 'ご案内', { text: '説明です' }),
  field('calc', 'variable', '合計', { variableSubType: 'formula', formula: '{name}' }),
  field('temporary', 'variable', '一時変数', { variableSubType: 'int' }),
  field('line-item', 'text', '明細テンプレート'),
  field('lines', 'repeating_section', '明細', {
    repeatingColumns: [{ columnField: 'line-item', title: '品名' }],
  }),
]

function props(overrides: Partial<InternalSheetsSetupPanelProps> = {}): InternalSheetsSetupPanelProps {
  return {
    serviceAccountEmail: 'sheets-sync@example.iam.gserviceaccount.com',
    fields: SYNC_FIELDS,
    onInspect: vi.fn().mockResolvedValue({
      spreadsheetId: 'spreadsheet_1234567890',
      sheetNames: ['回答', '集計'],
    }),
    onSave: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('InternalSheetsSetupPanel', () => {
  test('shows the service-account sharing guide and copies only its email address', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    render(<InternalSheetsSetupPanel {...props()} />)

    expect(screen.getByText('sheets-sync@example.iam.gserviceaccount.com')).toBeTruthy()
    expect(screen.getByText('先にこのアドレスへ閲覧/編集共有してから貼り付け')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'サービスアカウントのメールアドレスをコピー' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('sheets-sync@example.iam.gserviceaccount.com'))
    expect(screen.getByRole('status').textContent).toContain('コピーしました')
  })

  test('validates the sharing URL, loads real tabs, defaults syncable fields on, and saves the selection', async () => {
    const p = props()
    render(<InternalSheetsSetupPanel {...p} />)

    const save = screen.getByRole('button', { name: 'シート連携を保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(screen.queryByLabelText('友だち台帳のシート（タブ）')).toBeNull()
    expect(screen.queryByLabelText('フォーム回答を記録するシート（タブ）')).toBeNull()
    expect((screen.getByRole('checkbox', { name: '友だち台帳も同期する' }) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('checkbox', { name: 'フォーム回答シート（別タブ）' }) as HTMLInputElement).checked).toBe(true)

    const answerFields = ['お名前', '合計', '明細']
    for (const label of answerFields) {
      expect((screen.getByRole('checkbox', { name: label }) as HTMLInputElement).checked).toBe(true)
    }
    expect(screen.queryByRole('checkbox', { name: 'ご案内' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: '一時変数' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: '明細テンプレート' })).toBeNull()

    const url = screen.getByLabelText('スプレッドシートの共有URL')
    fireEvent.change(url, { target: { value: 'https://example.com/not-a-sheet' } })
    fireEvent.click(screen.getByRole('button', { name: '接続を確認' }))
    expect(p.onInspect).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('Google スプレッドシートの共有URLを貼り付けてください')

    const sharingUrl = 'https://docs.google.com/spreadsheets/d/spreadsheet_1234567890/edit?gid=0'
    fireEvent.change(url, { target: { value: sharingUrl } })
    fireEvent.click(screen.getByRole('button', { name: '接続を確認' }))

    await waitFor(() => expect(p.onInspect).toHaveBeenCalledWith(sharingUrl))
    const ledgerTabs = await screen.findByLabelText('友だち台帳のシート（タブ）') as HTMLSelectElement
    const resultTabs = screen.getByLabelText('フォーム回答を記録するシート（タブ）') as HTMLSelectElement
    expect(Array.from(ledgerTabs.options).map((option) => option.textContent)).toEqual(['回答', '集計'])
    expect(Array.from(resultTabs.options).map((option) => option.textContent)).toEqual(['回答', '集計'])
    expect(ledgerTabs.value).toBe('集計')
    expect(resultTabs.value).toBe('回答')
    expect(save.disabled).toBe(false)

    fireEvent.change(resultTabs, { target: { value: '集計' } })
    expect(save.disabled).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('友だち台帳とフォーム回答は別のタブ')
    fireEvent.change(resultTabs, { target: { value: '回答' } })
    expect(save.disabled).toBe(false)

    fireEvent.click(screen.getByRole('checkbox', { name: '合計' }))
    expect((screen.getByRole('checkbox', { name: '同期する項目をすべて選択' }) as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByRole('checkbox', { name: '同期する項目をすべて選択' }))
    for (const label of answerFields) {
      expect((screen.getByRole('checkbox', { name: label }) as HTMLInputElement).checked).toBe(true)
    }
    fireEvent.click(screen.getByRole('checkbox', { name: '明細' }))
    fireEvent.click(save)

    await waitFor(() => expect(p.onSave).toHaveBeenCalledWith({
      spreadsheetId: 'spreadsheet_1234567890',
      sheetName: '集計',
      syncDirection: 'bidirectional',
      selectedFormFieldIds: ['name', 'calc'],
      friendLedgerEnabled: false,
      formResultsEnabled: true,
      formResultsSheetName: '回答',
    }))
    expect(screen.getByRole('status').textContent).toContain('保存しました')
  })

  test('turns a permission failure into daily Japanese without exposing the raw error', async () => {
    const p = props({
      onInspect: vi.fn().mockRejectedValue({
        body: { category: 'sheet_permission', error: 'PERMISSION_DENIED: caller has no permission' },
      }),
    })
    render(<InternalSheetsSetupPanel {...p} />)

    fireEvent.change(screen.getByLabelText('スプレッドシートの共有URL'), {
      target: { value: 'https://docs.google.com/spreadsheets/d/spreadsheet_1234567890/edit' },
    })
    fireEvent.click(screen.getByRole('button', { name: '接続を確認' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('スプレッドシートの共有設定に上のアドレスを追加してください')
    expect(alert.textContent).not.toContain('PERMISSION_DENIED')
    expect(screen.queryByLabelText('友だち台帳のシート（タブ）')).toBeNull()
    expect(screen.queryByLabelText('フォーム回答を記録するシート（タブ）')).toBeNull()
  })

  test('starts an existing connection as inspected with its current tab and saved field subset', async () => {
    const onInspect = vi.fn()
    const onSave = vi.fn().mockResolvedValue(undefined)
    render(<InternalSheetsSetupPanel {...props({
      connection: {
        spreadsheetId: 'existing_spreadsheet_123',
        sheetName: '既存回答',
        syncDirection: 'to_sheets',
        selectedFormFieldIds: ['calc'],
        friendLedgerEnabled: true,
        formResultsEnabled: false,
        formResultsSheetName: null,
      },
      onInspect,
      onSave,
    })} />)

    expect((screen.getByLabelText('友だち台帳のシート（タブ）') as HTMLSelectElement).value).toBe('既存回答')
    expect((screen.getByLabelText('フォーム回答を記録するシート（タブ）') as HTMLSelectElement).value).toBe('')
    expect((screen.getByRole('checkbox', { name: '友だち台帳も同期する' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: 'フォーム回答シート（別タブ）' }) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('checkbox', { name: 'お名前' }) as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('checkbox', { name: '合計' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('同期方向') as HTMLSelectElement).value).toBe('to_sheets')

    fireEvent.click(screen.getByRole('button', { name: 'シート連携を保存' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      spreadsheetId: 'existing_spreadsheet_123',
      sheetName: '既存回答',
      syncDirection: 'to_sheets',
      selectedFormFieldIds: ['calc'],
      friendLedgerEnabled: true,
      formResultsEnabled: false,
      formResultsSheetName: null,
    }))
    expect(onInspect).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('formId')
  })
})
