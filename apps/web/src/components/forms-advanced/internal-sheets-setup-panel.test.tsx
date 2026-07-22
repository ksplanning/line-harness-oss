// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

const APPS_SCRIPT_FIXTURE = [
  'var FRIEND_LEDGER_PROPERTY_NAMES = [];',
  'function installFriendLedgerSync() {}',
  'function friendLedgerOnEdit(event) {}',
].join('\n')

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
        id: 'gsc_existing',
        lineAccountId: 'acc_existing',
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

  test('shows a five-step copy-and-paste guide while an unsaved connection keeps every value unavailable', async () => {
    const loadAppsScript = vi.fn().mockResolvedValue(APPS_SCRIPT_FIXTURE)
    const onRequestWebhookSecret = vi.fn()
    render(<InternalSheetsSetupPanel {...props({
      loadAppsScript,
      onRequestWebhookSecret,
    })} />)

    fireEvent.click(screen.getByRole('button', { name: '即時反映の設定を見る' }))

    const dialog = await screen.findByRole('dialog', { name: '即時反映の設定' })
    const guide = within(dialog).getByRole('list', { name: '設定手順' })
    expect(within(guide).getAllByRole('listitem')).toHaveLength(5)
    expect(within(dialog).getByText(
      '全体の流れは「Apps Scriptを開く」→「5つの値を入れる」→「コードを貼る」→「1回実行」→「セルで確認」です。',
    )).toBeTruthy()
    expect(within(dialog).getByRole('heading', { name: '全体の流れ（5ステップ）' })).toBeTruthy()
    expect(within(dialog).getByText('下のコードを Apps Script に貼り付けます')).toBeTruthy()
    expect(within(dialog).getAllByText('接続保存後に表示')).toHaveLength(5)
    expect(within(dialog).queryByRole('button', { name: '署名キーを取得' })).toBeNull()
    expect((within(dialog).getByRole('button', {
      name: 'SHEETS_CONNECTION_ID の値をコピー',
    }) as HTMLButtonElement).disabled).toBe(true)
    const propertyRow = within(dialog).getByText('SHEETS_CONNECTION_ID').closest('tr')
    if (!propertyRow) throw new Error('property row missing')
    expect(propertyRow?.className).toContain('block')
    expect(propertyRow?.className).toContain('sm:table-row')
    expect(within(propertyRow).getByText('名前をコピー')).toBeTruthy()
    expect(within(propertyRow).getByText('値をコピー')).toBeTruthy()
    expect(within(dialog).getByRole('heading', { name: '手順3：Apps Script をコピーして貼ります' })).toBeTruthy()
    expect(within(dialog).getByText(
      '貼り付けて保存したら、手順4で installFriendLedgerSync を1回実行します。最後に手順5でセルを1つ直し、すぐ反映されることを確認します。',
    )).toBeTruthy()
    expect(onRequestWebhookSecret).not.toHaveBeenCalled()

    await waitFor(() => expect(loadAppsScript).toHaveBeenCalledTimes(1))
    expect(await within(dialog).findByText('function installFriendLedgerSync() {}', { exact: false })).toBeTruthy()
    const closeButton = within(dialog).getByRole('button', { name: '閉じる' })
    expect(document.activeElement).toBe(closeButton)
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: 'Apps Script 全文をコピー' }))
  })

  test('keeps instant-sync values unavailable until friend-ledger sync is enabled and saved', async () => {
    const onRequestWebhookSecret = vi.fn()
    render(<InternalSheetsSetupPanel {...props({
      connection: {
        id: 'gsc_saved_but_disabled',
        lineAccountId: 'acc_owner',
        spreadsheetId: 'spreadsheet_saved_123',
        sheetName: '友だち台帳',
        syncDirection: 'bidirectional',
        selectedFormFieldIds: ['name'],
        friendLedgerEnabled: false,
        formResultsEnabled: true,
        formResultsSheetName: 'フォーム回答',
      },
      loadAppsScript: vi.fn().mockResolvedValue(APPS_SCRIPT_FIXTURE),
      onRequestWebhookSecret,
    })} />)

    fireEvent.click(screen.getByRole('button', { name: '即時反映の設定を見る' }))
    const dialog = await screen.findByRole('dialog', { name: '即時反映の設定' })
    expect(within(dialog).getAllByText('友だち台帳の同期をオンにして保存後に表示')).toHaveLength(5)
    expect(within(dialog).getByText(/「友だち台帳も同期する」をオン/)).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: '署名キーを取得' })).toBeNull()
    expect((within(dialog).getByRole('button', {
      name: 'SHEETS_CONNECTION_ID の値をコピー',
    }) as HTMLButtonElement).disabled).toBe(true)
    expect((within(dialog).getByRole('button', {
      name: 'SHEETS_CONNECTION_ID の名前をコピー',
    }) as HTMLButtonElement).disabled).toBe(false)
    expect(onRequestWebhookSecret).not.toHaveBeenCalled()
  })

  test('copies saved values and the canonical script, and fetches a hidden secret only after a click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const webhookSecret = 'a'.repeat(64)
    const loadAppsScript = vi.fn().mockResolvedValue(APPS_SCRIPT_FIXTURE)
    const onRequestWebhookSecret = vi.fn().mockResolvedValue(webhookSecret)
    render(<InternalSheetsSetupPanel {...props({
      connection: {
        id: 'gsc/instant-1',
        lineAccountId: 'acc/owner-1',
        spreadsheetId: 'spreadsheet_saved_123',
        sheetName: '友だち台帳',
        syncDirection: 'bidirectional',
        selectedFormFieldIds: ['name'],
        friendLedgerEnabled: true,
        formResultsEnabled: true,
        formResultsSheetName: 'フォーム回答',
      },
      loadAppsScript,
      onRequestWebhookSecret,
    })} />)

    const trigger = screen.getByRole('button', { name: '即時反映の設定を見る' })
    fireEvent.click(trigger)
    const dialog = await screen.findByRole('dialog', { name: '即時反映の設定' })

    expect(within(dialog).getByText('gsc/instant-1')).toBeTruthy()
    expect(within(dialog).getByText('spreadsheet_saved_123')).toBeTruthy()
    expect(within(dialog).getByText('友だち台帳')).toBeTruthy()
    expect(within(dialog).getByText(/\/api\/integrations\/google-sheets\/friend-ledger\/webhook$/)).toBeTruthy()
    expect(onRequestWebhookSecret).not.toHaveBeenCalled()
    expect(within(dialog).queryByText(webhookSecret)).toBeNull()

    fireEvent.click(within(dialog).getByRole('button', { name: 'SHEETS_CONNECTION_ID の値をコピー' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('gsc/instant-1'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'SHEETS_CONNECTION_ID の名前をコピー' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('SHEETS_CONNECTION_ID'))
    const copyStatus = within(dialog).getByRole('status')
    expect(copyStatus.textContent).toContain('スクリプト プロパティの名前へ')
    expect(copyStatus.className).toContain('fixed')
    expect(copyStatus.className).toContain('pointer-events-none')

    fireEvent.click(within(dialog).getByRole('button', { name: '署名キーを取得' }))
    await waitFor(() => expect(onRequestWebhookSecret).toHaveBeenCalledWith(
      'acc/owner-1',
      'gsc/instant-1',
    ))
    await waitFor(() => expect(document.activeElement).toBe(
      within(dialog).getByRole('button', { name: '署名キーを表示' }),
    ))
    expect(within(dialog).queryByText(webhookSecret)).toBeNull()
    expect(within(dialog).getByText('●●●●●●●●●●●●')).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: '署名キーを表示' }))
    expect(within(dialog).getByText(webhookSecret)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'SHEETS_WEBHOOK_SECRET の値をコピー' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(webhookSecret))
    fireEvent.click(within(dialog).getByRole('button', { name: '署名キーを隠す' }))
    expect(within(dialog).queryByText(webhookSecret)).toBeNull()

    await waitFor(() => expect(loadAppsScript).toHaveBeenCalledTimes(1))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Apps Script 全文をコピー' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(APPS_SCRIPT_FIXTURE))
    expect(within(dialog).getByRole('status').textContent).toContain('手順3のコード欄へ')

    const expectedPropertyValues = new Map([
      ['SHEETS_WEBHOOK_URL', new URL('/api/integrations/google-sheets/friend-ledger/webhook', window.location.origin).href],
      ['SHEETS_WEBHOOK_SECRET', webhookSecret],
      ['SHEETS_CONNECTION_ID', 'gsc/instant-1'],
      ['SHEETS_SPREADSHEET_ID', 'spreadsheet_saved_123'],
      ['SHEETS_SHEET_NAME', '友だち台帳'],
    ])
    for (const [propertyName, propertyValue] of expectedPropertyValues) {
      fireEvent.click(within(dialog).getByRole('button', { name: `${propertyName} の名前をコピー` }))
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(propertyName))
      expect((within(dialog).getByRole('button', {
        name: `${propertyName} の値をコピー`,
      }) as HTMLButtonElement).disabled).toBe(false)
      fireEvent.click(within(dialog).getByRole('button', { name: `${propertyName} の値をコピー` }))
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(propertyValue))
    }

    fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }))
    expect(screen.queryByRole('dialog', { name: '即時反映の設定' })).toBeNull()
    expect(screen.queryByText(webhookSecret)).toBeNull()

    fireEvent.click(trigger)
    const reopened = await screen.findByRole('dialog', { name: '即時反映の設定' })
    expect(within(reopened).queryByText(webhookSecret)).toBeNull()
    expect(within(reopened).getByRole('button', { name: '署名キーを取得' })).toBeTruthy()
    expect(onRequestWebhookSecret).toHaveBeenCalledTimes(1)
    expect(loadAppsScript).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: '即時反映の設定' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })
})
