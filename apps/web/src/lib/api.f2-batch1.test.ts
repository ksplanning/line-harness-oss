/**
 * F2 batch1 — api client 拡張の request 契約テスト (T-A1 / T-A4)。
 *
 * worker を叩かず global.fetch を stub し「どの URL に / どの method で / どの body を投げるか」を assert。
 * worker route (scenarios.ts:753 enroll / friends.ts:507 metadata merge) と一致する URL/method/body を固定する。
 * 送信ゼロの不変条件 (本 batch は broadcast/push/multicast/reply を一切叩かない) も request URL で担保する。
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
// 409 を返したいテスト用にステータスを差し替えられるようにする。
let nextResponse: { ok: boolean; status: number; data: unknown; error?: string } = {
  ok: true,
  status: 200,
  data: null,
}

beforeEach(() => {
  captured = []
  nextResponse = { ok: true, status: 200, data: null }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      captured.push({
        url,
        method: (init?.method ?? 'GET').toUpperCase(),
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      })
      return {
        ok: nextResponse.ok,
        status: nextResponse.status,
        json: async () =>
          nextResponse.ok
            ? { success: true, data: nextResponse.data }
            : { success: false, error: nextResponse.error ?? 'error' },
      } as unknown as Response
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function loadApi() {
  const mod = await import('./api')
  return mod.api
}

describe('T-A1: scenarios.enroll (手動シナリオ登録 / G7)', () => {
  test('enroll は POST /api/scenarios/:id/enroll/:friendId を body なしで叩く', async () => {
    const api = await loadApi()
    await api.scenarios.enroll('sc_1', 'fr_1')
    expect(captured[0].url).toBe(`${BASE}/api/scenarios/sc_1/enroll/fr_1`)
    expect(captured[0].method).toBe('POST')
    expect(captured[0].body).toBeUndefined()
  })

  test('scenarioId / friendId は encodeURIComponent される', async () => {
    const api = await loadApi()
    await api.scenarios.enroll('sc/1', 'fr 2')
    expect(captured[0].url).toBe(`${BASE}/api/scenarios/sc%2F1/enroll/fr%202`)
  })

  test('409 (already enrolled) は fetchApi が Error("API error: 409") を throw する (握り潰さない)', async () => {
    const api = await loadApi()
    nextResponse = { ok: false, status: 409, data: null, error: 'Already enrolled in this scenario' }
    // fetchApi は !res.ok で throw する契約 (api.ts:106)。呼び側 (enroll-dialog) は
    // catch して message から 409 を判別し「すでに登録されています」に切替える。
    await expect(api.scenarios.enroll('sc_1', 'fr_dup')).rejects.toThrow('API error: 409')
  })

  test('送信ゼロ: enroll は send 系 endpoint (/send /push /multicast /reply) を叩かない', async () => {
    const api = await loadApi()
    await api.scenarios.enroll('sc_1', 'fr_1')
    const sendish = captured.filter((c) =>
      /\/(send|push|multicast|reply|broadcasts\/[^/]+\/send)/.test(c.url),
    )
    expect(sendish).toHaveLength(0)
  })
})

describe('T-A1 / T-A4: friends.updateMetadata (カスタム項目 / G9・merge 保証)', () => {
  test('updateMetadata は PUT /api/friends/:id/metadata に patch を送る', async () => {
    const api = await loadApi()
    await api.friends.updateMetadata('fr_1', { 会社名: '株式会社〇〇' })
    expect(captured[0].url).toBe(`${BASE}/api/friends/fr_1/metadata`)
    expect(captured[0].method).toBe('PUT')
    expect(captured[0].body).toEqual({ 会社名: '株式会社〇〇' })
  })

  test('friendId は encodeURIComponent される', async () => {
    const api = await loadApi()
    await api.friends.updateMetadata('fr/9', { plan: 'std' })
    expect(captured[0].url).toBe(`${BASE}/api/friends/fr%2F9/metadata`)
  })

  test('T-A4 merge 保証: 変更キーのみを送り、UI 非表示の他キーを body に含めない', async () => {
    const api = await loadApi()
    // 既存 metadata が {a:1, b:2} でも UI で a だけ編集したなら {a:...} だけを送る。
    // worker PUT は {...existing, ...body} の pure merge なので b は worker 側に残る。
    await api.friends.updateMetadata('fr_1', { a: '10' })
    expect(captured[0].body).toEqual({ a: '10' })
    expect(Object.keys(captured[0].body as object)).not.toContain('b')
  })

  test('送信ゼロ: updateMetadata は send 系 endpoint を叩かない', async () => {
    const api = await loadApi()
    await api.friends.updateMetadata('fr_1', { a: '1' })
    const sendish = captured.filter((c) =>
      /\/(send|push|multicast|reply|broadcasts\/[^/]+\/send)/.test(c.url),
    )
    expect(sendish).toHaveLength(0)
  })
})
