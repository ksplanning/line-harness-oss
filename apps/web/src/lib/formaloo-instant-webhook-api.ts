import { fetchApi } from './api'

export interface FormalooInstantWebhookStatus {
  enabled: boolean
  available: boolean
}

type StatusResponse = {
  success: true
  data: FormalooInstantWebhookStatus
}

export const formalooInstantWebhookApi = {
  async get(formId: string): Promise<FormalooInstantWebhookStatus> {
    const response = await fetchApi<StatusResponse>(
      `/api/forms-advanced/${encodeURIComponent(formId)}/instant-webhook`,
    )
    return response.data
  },

  async set(formId: string, enabled: boolean): Promise<FormalooInstantWebhookStatus> {
    const response = await fetchApi<StatusResponse>(
      `/api/forms-advanced/${encodeURIComponent(formId)}/instant-webhook`,
      { method: 'PUT', body: JSON.stringify({ enabled }) },
    )
    return response.data
  },
}
