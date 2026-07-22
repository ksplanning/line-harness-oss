import { beforeEach, describe, expect, test, vi } from 'vitest'

const fetchApiMock = vi.hoisted(() => vi.fn())
vi.mock('./api', () => ({ fetchApi: (...args: unknown[]) => fetchApiMock(...args) }))

import { sheetsConnectionsApi } from './sheets-connections-api'

beforeEach(() => fetchApiMock.mockReset())

const created = {
  id: 'gsc_1', lineAccountId: 'acc/1', formId: 'form/1', spreadsheetId: 'sheet_1',
  sheetName: '回答', syncDirection: 'bidirectional', conflictPolicy: 'last_write_wins',
  friendFieldMappings: [{ fieldId: 'field-rank', header: '会員ランク' }],
  friendLedgerEnabled: true,
  lastSyncAt: '2026-07-21T10:00:00.000+09:00', lastSyncStatus: 'success', lastSyncWarning: null,
  isActive: true, createdAt: '2026-07-20', updatedAt: '2026-07-20',
}

describe('sheetsConnectionsApi', () => {
  test('list scopes by LINE account and optional form', async () => {
    fetchApiMock.mockResolvedValue({ success: true, data: [created] })
    await expect(sheetsConnectionsApi.list('acc/1')).resolves.toEqual([created])
    expect(fetchApiMock).toHaveBeenNthCalledWith(
      1,
      '/api/integrations/google-sheets/connections?lineAccountId=acc%2F1',
    )
    await sheetsConnectionsApi.list('acc/1', 'form/1')
    expect(fetchApiMock).toHaveBeenNthCalledWith(
      2,
      '/api/integrations/google-sheets/connections?lineAccountId=acc%2F1&formId=form%2F1',
    )
  })

  test('create/update/delete send only the connection settings contract', async () => {
    fetchApiMock
      .mockResolvedValueOnce({ success: true, data: created })
      .mockResolvedValueOnce({ success: true, data: { ...created, sheetName: '集計' } })
      .mockResolvedValueOnce({ success: true, data: null })

    const createInput = {
      lineAccountId: 'acc/1', formId: 'form/1', spreadsheetId: 'sheet_1',
      sheetName: '回答', syncDirection: 'bidirectional' as const,
      selectedFieldIds: ['field-rank'],
    }
    await sheetsConnectionsApi.create(createInput)
    expect(fetchApiMock).toHaveBeenNthCalledWith(1, '/api/integrations/google-sheets/connections', {
      method: 'POST', body: JSON.stringify(createInput),
    })

    const updateInput = {
      spreadsheetId: 'sheet_1', sheetName: '集計', syncDirection: 'from_sheets' as const,
      selectedFieldIds: ['field-rank', 'field-note'],
    }
    await sheetsConnectionsApi.update('acc/1', 'gsc/1', updateInput)
    expect(fetchApiMock).toHaveBeenNthCalledWith(2, '/api/integrations/google-sheets/connections/gsc%2F1', {
      method: 'PATCH', body: JSON.stringify({ lineAccountId: 'acc/1', ...updateInput }),
    })

    await sheetsConnectionsApi.remove('acc/1', 'gsc/1')
    expect(fetchApiMock).toHaveBeenNthCalledWith(3, '/api/integrations/google-sheets/connections/gsc%2F1?lineAccountId=acc%2F1', {
      method: 'DELETE',
    })
  })

  test('connection test returns the boolean result', async () => {
    fetchApiMock.mockResolvedValue({ success: true, data: { ok: false } })
    await expect(sheetsConnectionsApi.test('acc/1', 'gsc/1')).resolves.toBe(false)
    expect(fetchApiMock).toHaveBeenCalledWith('/api/integrations/google-sheets/connections/gsc%2F1/test?lineAccountId=acc%2F1', {
      method: 'POST',
    })
  })

  test('loads the service-account guide and inspects a sharing URL before save', async () => {
    fetchApiMock
      .mockResolvedValueOnce({
        success: true,
        data: { serviceAccountEmail: 'sheets@example.iam.gserviceaccount.com' },
      })
      .mockResolvedValueOnce({
        success: true,
        data: { ok: true, spreadsheetId: 'sheet_1', sheetNames: ['回答', '集計'] },
      })

    await expect(sheetsConnectionsApi.setup()).resolves.toEqual({
      serviceAccountEmail: 'sheets@example.iam.gserviceaccount.com',
    })
    expect(fetchApiMock).toHaveBeenNthCalledWith(
      1,
      '/api/integrations/google-sheets/connections/setup',
    )

    const input = {
      lineAccountId: 'acc/1',
      formId: 'form/1',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet_1/edit',
    }
    await expect(sheetsConnectionsApi.inspect(input)).resolves.toEqual({
      spreadsheetId: 'sheet_1',
      sheetNames: ['回答', '集計'],
    })
    expect(fetchApiMock).toHaveBeenNthCalledWith(
      2,
      '/api/integrations/google-sheets/connections/inspect',
      { method: 'POST', body: JSON.stringify(input) },
    )
  })

  test('turns a structured inspection failure into the daily-language API error', async () => {
    fetchApiMock.mockResolvedValue({
      success: true,
      data: {
        ok: false,
        category: 'sheet_permission',
        message: 'スプレッドシートの共有設定に上のアドレスを追加してください。',
      },
    })

    await expect(sheetsConnectionsApi.inspect({
      lineAccountId: 'acc-1',
      formId: 'form-1',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet_1/edit',
    })).rejects.toMatchObject({
      body: {
        error: 'スプレッドシートの共有設定に上のアドレスを追加してください。',
        category: 'sheet_permission',
      },
    })
  })

  test('manual sync and recent audit use account-scoped endpoints and return their payloads', async () => {
    const summary = { status: 'success', warning: null }
    const audit = [{
      actor: 'オーナー',
      fieldName: '会員ランク',
      oldValue: '一般',
      newValue: 'VIP',
      source: 'sheet',
      changeKind: 'custom_field',
    }]
    fetchApiMock
      .mockResolvedValueOnce({ success: true, data: summary })
      .mockResolvedValueOnce({ success: true, data: audit })

    await expect(sheetsConnectionsApi.sync('acc/1', 'gsc/1')).resolves.toEqual(summary)
    expect(fetchApiMock).toHaveBeenNthCalledWith(
      1,
      '/api/integrations/google-sheets/connections/gsc%2F1/sync?lineAccountId=acc%2F1',
      { method: 'POST' },
    )

    await expect(sheetsConnectionsApi.audit('acc/1', 'gsc/1')).resolves.toEqual(audit)
    expect(fetchApiMock).toHaveBeenNthCalledWith(
      2,
      '/api/integrations/google-sheets/connections/gsc%2F1/audit?lineAccountId=acc%2F1',
    )
  })
})
