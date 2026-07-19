import { beforeEach, describe, expect, test, vi } from 'vitest'

const fetchApiMock = vi.hoisted(() => vi.fn())
vi.mock('./api', () => ({ fetchApi: (...args: unknown[]) => fetchApiMock(...args) }))

import { formalooRecurringSubmissionsApi } from './formaloo-recurring-submissions-api'

beforeEach(() => fetchApiMock.mockReset())

const mirror = {
  id: 'frs_1', formId: 'fa/1', idempotencyKey: 'attempt-1', remoteSlug: 'rs/1',
  schedule: { interval: { providerKey: 'providerValue' }, start_time: '2026-07-20T00:00:00Z', end_time: null },
  submissionData: { stock: 8 }, status: 'resumed' as const, syncState: 'synced' as const,
  lastError: null, createdAt: '2026-07-19', updatedAt: '2026-07-19',
}

describe('formalooRecurringSubmissionsApi', () => {
  test('list unwraps the form-scoped ledger', async () => {
    fetchApiMock.mockResolvedValue({ success: true, data: { items: [mirror], available: true } })
    await expect(formalooRecurringSubmissionsApi.list('fa/1')).resolves.toEqual({ items: [mirror], available: true })
    expect(fetchApiMock).toHaveBeenCalledWith('/api/forms-advanced/fa%2F1/recurring-submissions')
  })

  test('create sends the stable idempotency key, schedule, and submission data', async () => {
    fetchApiMock.mockResolvedValue({ success: true, data: mirror })
    const input = {
      idempotencyKey: 'attempt-1',
      schedule: { interval: { providerKey: 'providerValue' }, startTime: '2026-07-20T00:00:00Z', endTime: null },
      submissionData: { stock: 8 },
    }
    await expect(formalooRecurringSubmissionsApi.create('fa/1', input)).resolves.toEqual(mirror)
    expect(fetchApiMock).toHaveBeenCalledWith('/api/forms-advanced/fa%2F1/recurring-submissions', {
      method: 'POST', body: JSON.stringify(input),
    })
  })

  test('update, status, and cancel encode both form id and provider slug', async () => {
    fetchApiMock.mockResolvedValue({ success: true, data: mirror })
    const update = {
      schedule: { interval: {}, startTime: '2026-07-20T00:00:00Z', endTime: null },
      submissionData: {}, status: 'paused' as const,
    }
    await formalooRecurringSubmissionsApi.update('fa/1', 'rs/1', update)
    expect(fetchApiMock).toHaveBeenNthCalledWith(1, '/api/forms-advanced/fa%2F1/recurring-submissions/rs%2F1', {
      method: 'PUT', body: JSON.stringify(update),
    })
    await formalooRecurringSubmissionsApi.setStatus('fa/1', 'rs/1', 'paused')
    expect(fetchApiMock).toHaveBeenNthCalledWith(2, '/api/forms-advanced/fa%2F1/recurring-submissions/rs%2F1', {
      method: 'PATCH', body: JSON.stringify({ status: 'paused' }),
    })
    await formalooRecurringSubmissionsApi.cancel('fa/1', 'rs/1')
    expect(fetchApiMock).toHaveBeenNthCalledWith(3, '/api/forms-advanced/fa%2F1/recurring-submissions/rs%2F1', {
      method: 'DELETE',
    })
  })
})
