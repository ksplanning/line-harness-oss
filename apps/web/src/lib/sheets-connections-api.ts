import { fetchApi } from './api'

export type SheetsSyncDirection = 'to_sheets' | 'from_sheets' | 'bidirectional'
export type SheetsLastSyncStatus = 'idle' | 'running' | 'success' | 'warning' | 'error'

export interface SheetsFriendFieldMapping {
  fieldId: string
  header: string
}

export interface SheetsSyncSummary {
  status: 'success' | 'warning' | 'failed'
  warning: string | null
}

export interface SheetsAuditEntry {
  actor: string
  fieldName: string
  oldValue: string | null
  newValue: string | null
  source: string
  changeKind: string
  outcome?: 'applied' | 'skipped' | 'failed'
  errorCode?: string | null
}

export interface SheetsConnection {
  id: string
  lineAccountId: string
  formId: string
  spreadsheetId: string
  sheetName: string
  syncDirection: SheetsSyncDirection
  conflictPolicy: 'last_write_wins'
  friendFieldMappings: SheetsFriendFieldMapping[]
  friendLedgerEnabled: boolean
  lastSyncAt: string | null
  lastSyncStatus: SheetsLastSyncStatus
  lastSyncWarning: string | null
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
  selectedFieldIds: string[]
}

export type UpdateSheetsConnectionInput = Pick<
  CreateSheetsConnectionInput,
  'spreadsheetId' | 'sheetName' | 'syncDirection' | 'selectedFieldIds'
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

  async update(lineAccountId: string, id: string, input: UpdateSheetsConnectionInput): Promise<SheetsConnection> {
    return (await fetchApi<Envelope<SheetsConnection>>(`${BASE_PATH}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ lineAccountId, ...input }),
    })).data
  },

  async remove(lineAccountId: string, id: string): Promise<void> {
    await fetchApi<Envelope<null>>(
      `${BASE_PATH}/${encodeURIComponent(id)}?lineAccountId=${encodeURIComponent(lineAccountId)}`,
      { method: 'DELETE' },
    )
  },

  async test(lineAccountId: string, id: string): Promise<boolean> {
    return (await fetchApi<Envelope<{ ok: boolean }>>(
      `${BASE_PATH}/${encodeURIComponent(id)}/test?lineAccountId=${encodeURIComponent(lineAccountId)}`,
      { method: 'POST' },
    )).data.ok
  },

  async sync(lineAccountId: string, id: string): Promise<SheetsSyncSummary> {
    return (await fetchApi<Envelope<SheetsSyncSummary>>(
      `${BASE_PATH}/${encodeURIComponent(id)}/sync?lineAccountId=${encodeURIComponent(lineAccountId)}`,
      { method: 'POST' },
    )).data
  },

  async audit(lineAccountId: string, id: string): Promise<SheetsAuditEntry[]> {
    return (await fetchApi<Envelope<SheetsAuditEntry[]>>(
      `${BASE_PATH}/${encodeURIComponent(id)}/audit?lineAccountId=${encodeURIComponent(lineAccountId)}`,
    )).data
  },
}
