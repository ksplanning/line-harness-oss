/**
 * F1 batch5 — api client request 契約テスト (G23 cannedResponses チャット定型文)。
 *
 * worker を叩かず global.fetch を stub し「どの URL に / どの method で / どの body で」を assert。
 * client 配線 (dead-code でないこと) の最小ゲート。UI 押下の E2E は browser-evaluator が担当。
 * account スコープ (PATCH/DELETE の ?accountId=) を明示検証 (batch4 R1 教訓)。
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

const BASE = 'https://worker.example.test'

beforeAll(() => {
  process.env.NEXT_PUBLIC_API_URL = BASE
})

interface Captured {
  url: string
  method: string
  body: unknown
}

let captured: Captured[] = []

function stubFetch(response: Partial<Response> & { ok: boolean; status: number }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      captured.push({
        url,
        method: (init?.method ?? 'GET').toUpperCase(),
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      })
      return response as unknown as Response
    }),
  )
}

beforeEach(() => {
  captured = []
  stubFetch({ ok: true, status: 200, json: async () => ({ success: true, data: null }) })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function loadMod() {
  return import('./api')
}

describe('G23: api.cannedResponses', () => {
  test('list(accountId) は GET /api/canned-responses?accountId=', async () => {
    const { api } = await loadMod()
    await api.cannedResponses.list('acc-1')
    expect(captured[0].url).toBe(`${BASE}/api/canned-responses?accountId=acc-1`)
    expect(captured[0].method).toBe('GET')
  })

  test('list() 未指定なら query を載せない', async () => {
    const { api } = await loadMod()
    await api.cannedResponses.list()
    expect(captured[0].url).toBe(`${BASE}/api/canned-responses`)
  })

  test('create(...) は POST /api/canned-responses で title/content/accountId を送る', async () => {
    const { api } = await loadMod()
    await api.cannedResponses.create({ title: '営業案内', content: '本日はご案内します', accountId: 'acc-1' })
    expect(captured[0].url).toBe(`${BASE}/api/canned-responses`)
    expect(captured[0].method).toBe('POST')
    expect(captured[0].body).toEqual({ title: '営業案内', content: '本日はご案内します', accountId: 'acc-1' })
  })

  test('update(id, {title,content}, accountId) は PATCH /api/canned-responses/:id?accountId= (account scope)', async () => {
    const { api } = await loadMod()
    await api.cannedResponses.update('cr-1', { title: 'new', content: 'body' }, 'acc-1')
    expect(captured[0].url).toBe(`${BASE}/api/canned-responses/cr-1?accountId=acc-1`)
    expect(captured[0].method).toBe('PATCH')
    expect(captured[0].body).toEqual({ title: 'new', content: 'body' })
  })

  test('remove(id, accountId) は DELETE /api/canned-responses/:id?accountId= (account scope)', async () => {
    const { api } = await loadMod()
    await api.cannedResponses.remove('cr-1', 'acc-1')
    expect(captured[0].url).toBe(`${BASE}/api/canned-responses/cr-1?accountId=acc-1`)
    expect(captured[0].method).toBe('DELETE')
  })

  test('update/remove without accountId omit the query (global canned response)', async () => {
    const { api } = await loadMod()
    await api.cannedResponses.update('cr-1', { title: 'new' })
    expect(captured[0].url).toBe(`${BASE}/api/canned-responses/cr-1`)
    await api.cannedResponses.remove('cr-1')
    expect(captured[1].url).toBe(`${BASE}/api/canned-responses/cr-1`)
  })
})
