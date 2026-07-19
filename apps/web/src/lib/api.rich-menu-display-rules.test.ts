import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

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
      json: async () => ({ success: true, data: [] }),
    } as unknown as Response
  }))
})

afterEach(() => vi.unstubAllGlobals())

async function loadApi() {
  return (await import('./api')).api
}

describe('richMenuDisplayRules API client', () => {
  test('uses account-scoped CRUD URLs and preserves condition payloads', async () => {
    const api = await loadApi()
    const input = {
      name: 'VIP向け',
      conditionType: 'metadata_equals' as const,
      conditionValue: JSON.stringify({ key: '会員ランク', value: 'VIP' }),
      richMenuId: 'menu/vip',
      priority: 100,
      isActive: true,
    }

    await api.richMenuDisplayRules.list('acc/1')
    await api.richMenuDisplayRules.create('acc/1', input)
    await api.richMenuDisplayRules.update('acc/1', 'rule/1', { priority: 200, isActive: false })
    await api.richMenuDisplayRules.delete('acc/1', 'rule/1')

    expect(captured).toEqual([
      { url: `${BASE}/api/rich-menu-display-rules?accountId=acc%2F1`, method: 'GET', body: undefined },
      { url: `${BASE}/api/rich-menu-display-rules?accountId=acc%2F1`, method: 'POST', body: input },
      {
        url: `${BASE}/api/rich-menu-display-rules/rule%2F1?accountId=acc%2F1`,
        method: 'PATCH',
        body: { priority: 200, isActive: false },
      },
      {
        url: `${BASE}/api/rich-menu-display-rules/rule%2F1?accountId=acc%2F1`,
        method: 'DELETE',
        body: undefined,
      },
    ])
  })

  test('gets progress and starts one account reapply job', async () => {
    const api = await loadApi()

    await api.richMenuDisplayRules.latestJob('acc/1')
    await api.richMenuDisplayRules.startReapply('acc/1')

    expect(captured).toEqual([
      {
        url: `${BASE}/api/rich-menu-display-rules/reapply/latest?accountId=acc%2F1`,
        method: 'GET',
        body: undefined,
      },
      {
        url: `${BASE}/api/rich-menu-display-rules/reapply?accountId=acc%2F1`,
        method: 'POST',
        body: undefined,
      },
    ])
  })
})
