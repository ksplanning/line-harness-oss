import { fetchApi } from './api'
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
