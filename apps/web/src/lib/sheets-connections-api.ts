import { fetchApi } from './api'

export type SheetsSyncDirection = 'to_sheets' | 'from_sheets' | 'bidirectional'

export interface SheetsConnection {
  id: string
  lineAccountId: string
  formId: string
  spreadsheetId: string
  sheetName: string
  syncDirection: SheetsSyncDirection
  conflictPolicy: 'last_write_wins'
  isActive: boolean
  createdAt: string
  updatedAt: string
}

export interface CreateSheetsConnectionInput {
  lineAccountId: string
  formId: string
  spreadsheetId: string
  sheetName: string
  syncDirection: SheetsSyncDirection
}

export type UpdateSheetsConnectionInput = Pick<
  CreateSheetsConnectionInput,
  'spreadsheetId' | 'sheetName' | 'syncDirection'
>

interface Envelope<T> {
  success: boolean
  data: T
  error?: string
}

const BASE_PATH = '/api/integrations/google-sheets/connections'

export const sheetsConnectionsApi = {
  async list(lineAccountId: string, formId?: string): Promise<SheetsConnection[]> {
    const query = `lineAccountId=${encodeURIComponent(lineAccountId)}`
      + (formId ? `&formId=${encodeURIComponent(formId)}` : '')
    return (await fetchApi<Envelope<SheetsConnection[]>>(`${BASE_PATH}?${query}`)).data
  },

  async create(input: CreateSheetsConnectionInput): Promise<SheetsConnection> {
    return (await fetchApi<Envelope<SheetsConnection>>(BASE_PATH, {
      method: 'POST',
      body: JSON.stringify(input),
    })).data
  },

  async update(id: string, input: UpdateSheetsConnectionInput): Promise<SheetsConnection> {
    return (await fetchApi<Envelope<SheetsConnection>>(`${BASE_PATH}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })).data
  },

  async remove(id: string): Promise<void> {
    await fetchApi<Envelope<null>>(`${BASE_PATH}/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },

  async test(id: string): Promise<boolean> {
    return (await fetchApi<Envelope<{ ok: boolean }>>(`${BASE_PATH}/${encodeURIComponent(id)}/test`, {
      method: 'POST',
    })).data.ok
  },
}
