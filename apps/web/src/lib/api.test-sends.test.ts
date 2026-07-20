import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const BASE = 'https://worker.example.test'
const captured: Array<{ url: string; method: string; body: unknown }> = []

beforeAll(() => {
  process.env.NEXT_PUBLIC_API_URL = BASE
})

beforeEach(() => {
  captured.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    captured.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, sent: 1, failed: 0 }),
    } as unknown as Response
  }))
})

afterEach(() => vi.unstubAllGlobals())

async function loadApi() {
  return (await import('./api')).api
}

describe('test send API client', () => {
  it('encodes the account id used to load server-controlled recipients', async () => {
    const api = await loadApi()
    await api.accountSettings.getTestRecipients('acc/1 ?')
    expect(captured[0]).toEqual({
      url: `${BASE}/api/account-settings/test-recipients?accountId=acc%2F1%20%3F`,
      method: 'GET',
      body: undefined,
    })
  })

  it('loads recipients through the same source-scoped permission route as the composer', async () => {
    const api = await loadApi()
    await api.testSends.getRecipients('template_pack', 'acc/1 ?')
    expect(captured[0]).toEqual({
      url: `${BASE}/api/test-sends/template_pack/recipients?accountId=acc%2F1%20%3F`,
      method: 'GET',
      body: undefined,
    })
  })

  it('uses the source-specific permission route and never sends friendIds', async () => {
    const api = await loadApi()
    await api.testSends.send({
      accountId: 'acc-1',
      source: 'scenario',
      messages: [{ type: 'text', content: 'こんにちは' }],
      idempotencyKey: 'request-12345678',
    })

    expect(captured[0]).toEqual({
      url: `${BASE}/api/test-sends/scenario`,
      method: 'POST',
      body: {
        accountId: 'acc-1',
        source: 'scenario',
        messages: [{ type: 'text', content: 'こんにちは' }],
        idempotencyKey: 'request-12345678',
      },
    })
    expect(captured[0].body).not.toHaveProperty('friendIds')
  })
})
