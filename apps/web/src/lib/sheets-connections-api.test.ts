import { beforeEach, describe, expect, test, vi } from 'vitest'

const fetchApiMock = vi.hoisted(() => vi.fn())
vi.mock('./api', () => ({ fetchApi: (...args: unknown[]) => fetchApiMock(...args) }))

import { sheetsConnectionsApi } from './sheets-connections-api'

beforeEach(() => fetchApiMock.mockReset())

const created = {
  id: 'gsc_1', lineAccountId: 'acc/1', formId: 'form/1', spreadsheetId: 'sheet_1',
  sheetName: '回答', syncDirection: 'bidirectional', conflictPolicy: 'last_write_wins',
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
    }
    await sheetsConnectionsApi.create(createInput)
    expect(fetchApiMock).toHaveBeenNthCalledWith(1, '/api/integrations/google-sheets/connections', {
      method: 'POST', body: JSON.stringify(createInput),
    })

    const updateInput = { spreadsheetId: 'sheet_1', sheetName: '集計', syncDirection: 'from_sheets' as const }
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
})
