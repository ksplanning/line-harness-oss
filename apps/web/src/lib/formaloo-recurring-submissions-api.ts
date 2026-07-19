import { fetchApi } from './api'

export type FormalooRecurringStatus = 'resumed' | 'paused' | 'cancelled'
export type FormalooRecurringSyncState = 'pending' | 'synced' | 'failed'

export interface FormalooRecurringSchedule {
  interval: Record<string, string>
  start_time: string
  end_time?: string | null
}

export interface FormalooRecurringSubmission {
  id: string
  formId: string
  idempotencyKey: string
  remoteSlug: string | null
  schedule: FormalooRecurringSchedule
  submissionData: Record<string, unknown>
  status: FormalooRecurringStatus
  syncState: FormalooRecurringSyncState
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export interface RecurringScheduleInput {
  interval: Record<string, string>
  startTime: string
  endTime?: string | null
}

export interface CreateRecurringSubmissionInput {
  idempotencyKey: string
  schedule: RecurringScheduleInput
  submissionData: Record<string, unknown>
}

export interface UpdateRecurringSubmissionInput {
  schedule: RecurringScheduleInput
  submissionData: Record<string, unknown>
  status: FormalooRecurringStatus
}

interface Envelope<T> {
  success: boolean
  data: T
}

function collectionPath(formId: string): string {
  return `/api/forms-advanced/${encodeURIComponent(formId)}/recurring-submissions`
}

function detailPath(formId: string, slug: string): string {
  return `${collectionPath(formId)}/${encodeURIComponent(slug)}`
}

export const formalooRecurringSubmissionsApi = {
  async list(formId: string): Promise<{ items: FormalooRecurringSubmission[]; available: boolean }> {
    return (await fetchApi<Envelope<{ items: FormalooRecurringSubmission[]; available: boolean }>>(
      collectionPath(formId),
    )).data
  },

  async create(
    formId: string,
    input: CreateRecurringSubmissionInput,
  ): Promise<FormalooRecurringSubmission> {
    return (await fetchApi<Envelope<FormalooRecurringSubmission>>(collectionPath(formId), {
      method: 'POST',
      body: JSON.stringify(input),
    })).data
  },

  async update(
    formId: string,
    slug: string,
    input: UpdateRecurringSubmissionInput,
  ): Promise<FormalooRecurringSubmission> {
    return (await fetchApi<Envelope<FormalooRecurringSubmission>>(detailPath(formId, slug), {
      method: 'PUT',
      body: JSON.stringify(input),
    })).data
  },

  async setStatus(
    formId: string,
    slug: string,
    status: FormalooRecurringStatus,
  ): Promise<FormalooRecurringSubmission> {
    return (await fetchApi<Envelope<FormalooRecurringSubmission>>(detailPath(formId, slug), {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    })).data
  },

  async cancel(formId: string, slug: string): Promise<FormalooRecurringSubmission> {
    return (await fetchApi<Envelope<FormalooRecurringSubmission>>(detailPath(formId, slug), {
      method: 'DELETE',
    })).data
  },
}
