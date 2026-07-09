import { fetchApi, downloadCsv } from './api'
import type { HarnessField, HarnessLogicRule } from '@line-crm/shared'

// =============================================================================
// 高機能フォーム (Formaloo-backed) API クライアント (F-2 / T-B1)。fetchApi 経由 (cookie 認証 + CSRF)。
// =============================================================================

export type BuilderStatus = 'draft' | 'in_review' | 'published'

export interface AdvancedForm {
  id: string
  title: string
  description: string | null
  formalooSlug: string | null
  builderStatus: BuilderStatus
  publishedAt: string | null
  submitCount: number
  fields: HarnessField[]
  logic: HarnessLogicRule[]
  publicUrl: string | null
  embedCode: string | null
  syncStatus: string
  syncError: string | null
  updatedAt: string
}

interface Envelope<T> {
  success: boolean
  data: T
  error?: string
}

export const formsAdvancedApi = {
  async list(): Promise<AdvancedForm[]> {
    return (await fetchApi<Envelope<AdvancedForm[]>>('/api/forms-advanced')).data
  },
  async get(id: string): Promise<AdvancedForm> {
    return (await fetchApi<Envelope<AdvancedForm>>(`/api/forms-advanced/${id}`)).data
  },
  async create(input: { title: string; description?: string | null }): Promise<AdvancedForm> {
    return (
      await fetchApi<Envelope<AdvancedForm>>('/api/forms-advanced', {
        method: 'POST',
        body: JSON.stringify(input),
      })
    ).data
  },
  async saveDefinition(id: string, def: { fields: HarnessField[]; logic: HarnessLogicRule[] }): Promise<AdvancedForm> {
    return (
      await fetchApi<Envelope<AdvancedForm>>(`/api/forms-advanced/${id}`, {
        method: 'PUT',
        body: JSON.stringify(def),
      })
    ).data
  },
  async submitForReview(id: string): Promise<AdvancedForm> {
    return (await fetchApi<Envelope<AdvancedForm>>(`/api/forms-advanced/${id}/submit-for-review`, { method: 'POST' })).data
  },
  async publish(id: string): Promise<AdvancedForm> {
    return (await fetchApi<Envelope<AdvancedForm>>(`/api/forms-advanced/${id}/publish`, { method: 'POST' })).data
  },
  async unpublish(id: string): Promise<AdvancedForm> {
    return (await fetchApi<Envelope<AdvancedForm>>(`/api/forms-advanced/${id}/unpublish`, { method: 'POST' })).data
  },
  async remove(id: string): Promise<void> {
    await fetchApi<Envelope<null>>(`/api/forms-advanced/${id}`, { method: 'DELETE' })
  },
}

// =============================================================================
// F-4 データコックピット API (T-D1/T-D2)。回答は TRINA 顧客 PII を含み得る (N-9) — 外部送信しない。
// =============================================================================

export interface SubmissionRow {
  id: string
  friendId: string | null
  answers: Record<string, unknown>
  submittedAt: string
  verified: boolean
}
export interface RowsPage {
  rows: SubmissionRow[]
  total: number
  page: number
  pageSize: number
}
export interface FormStats {
  total: number
  verified: number
  daily: { day: string; count: number }[]
  formaloo: unknown
}
export interface SavedFilter {
  id: string
  name: string
  filter: Record<string, unknown>
}
export interface RowsQuery {
  q?: string
  from?: string
  to?: string
  sort?: 'asc' | 'desc'
  page?: number
  pageSize?: number
}

function toQueryString(q: RowsQuery): string {
  const p = new URLSearchParams()
  if (q.q) p.set('q', q.q)
  if (q.from) p.set('from', q.from)
  if (q.to) p.set('to', q.to)
  if (q.sort) p.set('sort', q.sort)
  if (q.page) p.set('page', String(q.page))
  if (q.pageSize) p.set('pageSize', String(q.pageSize))
  const s = p.toString()
  return s ? `?${s}` : ''
}

export const formalooDataApi = {
  async rows(id: string, q: RowsQuery = {}): Promise<RowsPage> {
    return (await fetchApi<Envelope<RowsPage>>(`/api/forms-advanced/${id}/rows${toQueryString(q)}`)).data
  },
  async row(id: string, rowId: string): Promise<{ id: string; answers: Record<string, unknown>; submittedAt: string; source: string }> {
    return (await fetchApi<Envelope<{ id: string; answers: Record<string, unknown>; submittedAt: string; source: string }>>(`/api/forms-advanced/${id}/rows/${rowId}`)).data
  },
  async stats(id: string): Promise<FormStats> {
    return (await fetchApi<Envelope<FormStats>>(`/api/forms-advanced/${id}/stats`)).data
  },
  async listFilters(id: string): Promise<SavedFilter[]> {
    return (await fetchApi<Envelope<SavedFilter[]>>(`/api/forms-advanced/${id}/filters`)).data
  },
  async saveFilter(id: string, name: string, filter: Record<string, unknown>): Promise<SavedFilter> {
    return (await fetchApi<Envelope<SavedFilter>>(`/api/forms-advanced/${id}/filters`, { method: 'POST', body: JSON.stringify({ name, filter }) })).data
  },
  async deleteFilter(id: string, filterId: string): Promise<void> {
    await fetchApi<Envelope<null>>(`/api/forms-advanced/${id}/filters/${filterId}`, { method: 'DELETE' })
  },
  /** CSV 書き出し (owner gated)。fetchApi は blob 不可のため downloadCsv の専用 fetch 経路。 */
  async exportCsv(id: string, filename: string): Promise<void> {
    await downloadCsv(`/api/forms-advanced/${id}/export.csv`, filename)
  },
  async importCsv(id: string, csv: string): Promise<{ parsed: number; pushed: boolean; note: string }> {
    return (await fetchApi<Envelope<{ parsed: number; pushed: boolean; note: string }>>(`/api/forms-advanced/${id}/import`, { method: 'POST', body: JSON.stringify({ csv }) })).data
  },
  async bulkDelete(id: string, ids: string[]): Promise<{ deleted: number }> {
    return (await fetchApi<Envelope<{ deleted: number }>>(`/api/forms-advanced/${id}/rows/bulk-delete`, { method: 'POST', body: JSON.stringify({ ids }) })).data
  },
}
