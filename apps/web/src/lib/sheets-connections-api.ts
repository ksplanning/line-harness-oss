import { fetchApi } from './api'

export type SheetsSyncDirection = 'to_sheets' | 'from_sheets' | 'bidirectional'
export type SheetsLastSyncStatus = 'idle' | 'running' | 'success' | 'warning' | 'error'

export interface SheetsFriendFieldMapping {
  fieldId: string
  header: string
}

export type SheetsSyncJobStatus = 'running' | 'success' | 'warning' | 'error'

export interface SheetsSyncJob {
  id: string
  connectionId: string
  lineAccountId: string
  configVersion: number
  source: 'manual' | 'polling'
  actor: string
  status: SheetsSyncJobStatus
  totalCount: number
  processedCount: number
  lastFriendCreatedAt: string | null
  lastFriendId: string | null
  appendedRows: number
  updatedRows: number
  importedFields: number
  ignoredIdentityEdits: number
  warning: string | null
  errorCode: string | null
  errorMessage: string | null
  createdAt: string
  updatedAt: string
  completedAt: string | null
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
  formName?: string
  spreadsheetId: string
  sheetName: string
  syncDirection: SheetsSyncDirection
  conflictPolicy: 'last_write_wins'
  friendFieldMappings: SheetsFriendFieldMapping[]
  friendLedgerEnabled: boolean
  formResultsEnabled: boolean
  formResultsSheetName: string | null
  selectedFormFieldIds?: string[] | null
  lastSyncAt: string | null
  lastSyncStatus: SheetsLastSyncStatus
  lastSyncWarning: string | null
  isActive: boolean
  createdAt: string
  updatedAt: string
  latestSyncJob?: SheetsSyncJob | null
}

export interface CreateSheetsConnectionInput {
  lineAccountId: string
  formId: string
  spreadsheetId: string
  sheetName: string
  syncDirection: SheetsSyncDirection
  selectedFieldIds: string[]
  selectedFormFieldIds?: string[]
  friendLedgerEnabled: boolean
  formResultsEnabled: boolean
  formResultsSheetName: string | null
}

export type UpdateSheetsConnectionInput = Pick<
  CreateSheetsConnectionInput,
  | 'spreadsheetId'
  | 'sheetName'
  | 'syncDirection'
  | 'selectedFieldIds'
  | 'selectedFormFieldIds'
  | 'friendLedgerEnabled'
  | 'formResultsEnabled'
  | 'formResultsSheetName'
>

interface Envelope<T> {
  success: boolean
  data: T
  error?: string
}

export interface InspectSheetsConnectionInput {
  lineAccountId: string
  formId: string
  spreadsheetUrl: string
}

export interface InspectedSheetsConnection {
  spreadsheetId: string
  sheetNames: string[]
}

const BASE_PATH = '/api/integrations/google-sheets/connections'

export const sheetsConnectionsApi = {
  async setup(): Promise<{ serviceAccountEmail: string }> {
    return (await fetchApi<Envelope<{ serviceAccountEmail: string }>>(`${BASE_PATH}/setup`)).data
  },

  async inspect(input: InspectSheetsConnectionInput): Promise<InspectedSheetsConnection> {
    const response = await fetchApi<Envelope<
      | ({ ok: true } & InspectedSheetsConnection)
      | { ok: false; category: string; message: string }
    >>(`${BASE_PATH}/inspect`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
    if (!response.data.ok) {
      const error = new Error(response.data.message) as Error & {
        body: { error: string; category: string }
      }
      error.body = { error: response.data.message, category: response.data.category }
      throw error
    }
    return {
      spreadsheetId: response.data.spreadsheetId,
      sheetNames: response.data.sheetNames,
    }
  },

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

  async webhookSecret(lineAccountId: string, id: string): Promise<string> {
    return (await fetchApi<Envelope<{ webhookSecret: string }>>(
      `${BASE_PATH}/${encodeURIComponent(id)}/webhook-secret?lineAccountId=${encodeURIComponent(lineAccountId)}`,
      { method: 'POST' },
    )).data.webhookSecret
  },

  async sync(lineAccountId: string, id: string): Promise<SheetsSyncJob> {
    return (await fetchApi<Envelope<SheetsSyncJob>>(
      `${BASE_PATH}/${encodeURIComponent(id)}/sync?lineAccountId=${encodeURIComponent(lineAccountId)}`,
      { method: 'POST' },
    )).data
  },

  async latestSyncJob(lineAccountId: string, id: string): Promise<SheetsSyncJob | null> {
    return (await fetchApi<Envelope<SheetsSyncJob | null>>(
      `${BASE_PATH}/${encodeURIComponent(id)}/sync/latest?lineAccountId=${encodeURIComponent(lineAccountId)}`,
    )).data
  },

  async audit(lineAccountId: string, id: string): Promise<SheetsAuditEntry[]> {
    return (await fetchApi<Envelope<SheetsAuditEntry[]>>(
      `${BASE_PATH}/${encodeURIComponent(id)}/audit?lineAccountId=${encodeURIComponent(lineAccountId)}`,
    )).data
  },
}
