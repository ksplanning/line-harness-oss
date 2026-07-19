import { beforeEach, describe, expect, test, vi } from 'vitest'

const fetchApiMock = vi.hoisted(() => vi.fn())
vi.mock('./api', () => ({ fetchApi: (...args: unknown[]) => fetchApiMock(...args) }))

import { formalooInstantWebhookApi } from './formaloo-instant-webhook-api'

beforeEach(() => fetchApiMock.mockReset())

describe('formalooInstantWebhookApi', () => {
  test('GET は secret を要求せず form id の status endpoint を読む', async () => {
    fetchApiMock.mockResolvedValue({ success: true, data: { enabled: false, available: true } })
    await expect(formalooInstantWebhookApi.get('fa_1')).resolves.toEqual({ enabled: false, available: true })
    expect(fetchApiMock).toHaveBeenCalledWith('/api/forms-advanced/fa_1/instant-webhook')
  })

  test('set は boolean だけを PUT する', async () => {
    fetchApiMock.mockResolvedValue({ success: true, data: { enabled: true, available: true } })
    await expect(formalooInstantWebhookApi.set('fa_1', true)).resolves.toEqual({ enabled: true, available: true })
    expect(fetchApiMock).toHaveBeenCalledWith('/api/forms-advanced/fa_1/instant-webhook', {
      method: 'PUT',
      body: JSON.stringify({ enabled: true }),
    })
  })
})
