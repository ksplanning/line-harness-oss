/**
 * F1 batch4 — api client request 契約テスト (G28 responseSchedules / G10 savedSearches)。
 *
 * worker を叩かず global.fetch を stub し「どの URL に / どの method で / どの body で」を assert。
 * client 配線 (dead-code でないこと) の最小ゲート。UI 押下の E2E は browser-evaluator が担当。
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

describe('G28: api.responseSchedules', () => {
  test('get(accountId) は GET /api/response-schedules?accountId=', async () => {
    const { api } = await loadMod()
    await api.responseSchedules.get('acc-1')
    expect(captured[0].url).toBe(`${BASE}/api/response-schedules?accountId=acc-1`)
    expect(captured[0].method).toBe('GET')
  })

  test('save(...) は PUT /api/response-schedules で payload をそのまま送る', async () => {
    const { api } = await loadMod()
    const payload = {
      accountId: 'acc-1',
      isEnabled: true,
      outsideHoursMode: 'away_message' as const,
      awayMessage: 'ただいま営業時間外です',
      weeklyHours: [{ day: 1, closed: false, open: '09:00', close: '18:00' }],
    }
    await api.responseSchedules.save(payload)
    expect(captured[0].url).toBe(`${BASE}/api/response-schedules`)
    expect(captured[0].method).toBe('PUT')
    expect(captured[0].body).toEqual(payload)
  })
})
