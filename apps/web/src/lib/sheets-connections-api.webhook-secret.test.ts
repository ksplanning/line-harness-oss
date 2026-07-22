import { beforeEach, describe, expect, test, vi } from 'vitest'

const fetchApiMock = vi.hoisted(() => vi.fn())
vi.mock('./api', () => ({ fetchApi: (...args: unknown[]) => fetchApiMock(...args) }))

import { sheetsConnectionsApi } from './sheets-connections-api'

beforeEach(() => fetchApiMock.mockReset())

describe('sheetsConnectionsApi webhook secret', () => {
  test('requests only the selected connection secret on demand', async () => {
    const webhookSecret = 'a'.repeat(64)
    fetchApiMock.mockResolvedValue({ success: true, data: { webhookSecret } })

    await expect(sheetsConnectionsApi.webhookSecret('acc/1', 'gsc/1')).resolves.toBe(webhookSecret)
    expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/integrations/google-sheets/connections/gsc%2F1/webhook-secret?lineAccountId=acc%2F1',
      { method: 'POST' },
    )
  })
})
