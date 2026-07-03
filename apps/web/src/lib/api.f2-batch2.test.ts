/**
 * F2 batch2 — api client 拡張の request 契約テスト (T-C6/C7/C8)。
 *
 * worker を叩かず global.fetch を stub し「どの URL に / どの method で / どの body を投げるか」を assert。
 * worker route (campaigns.ts / template-packs.ts / rich-menu-analytics.ts) と一致する URL/method/body を固定。
 * 送信ゼロの不変条件 (本 batch は send/push/multicast/reply/broadcasts/:id/send を一切叩かない) を request URL で担保。
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

const BASE = 'https://worker.example.test'

beforeAll(() => {
  process.env.NEXT_PUBLIC_API_URL = BASE
})

interface Captured { url: string; method: string; body: unknown }
let captured: Captured[] = []

beforeEach(() => {
  captured = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      captured.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body: init?.body ? JSON.parse(init.body as string) : undefined })
      return { ok: true, status: 200, json: async () => ({ success: true, data: null }) } as unknown as Response
    }),
  )
})

afterEach(() => { vi.unstubAllGlobals() })

async function loadApi() {
  const mod = await import('./api')
  return mod.api
}

const SEND_RE = /\/(send|push|multicast|reply|broadcasts\/[^/]+\/send)(\?|$|\/)/

describe('T-C6: campaigns (G3)', () => {
  test('list は GET /api/campaigns?accountId=', async () => {
    const api = await loadApi()
    await api.campaigns.list('acc-1')
    expect(captured[0].url).toBe(`${BASE}/api/campaigns?accountId=acc-1`)
    expect(captured[0].method).toBe('GET')
  })

  test('get は GET /api/campaigns/:id?accountId=', async () => {
    const api = await loadApi()
    await api.campaigns.get('c1', 'acc-1')
    expect(captured[0].url).toBe(`${BASE}/api/campaigns/c1?accountId=acc-1`)
  })

  test('create は POST /api/campaigns?accountId= に { name }', async () => {
    const api = await loadApi()
    await api.campaigns.create('acc-1', '春の販促')
    expect(captured[0].url).toBe(`${BASE}/api/campaigns?accountId=acc-1`)
    expect(captured[0].method).toBe('POST')
    expect(captured[0].body).toEqual({ name: '春の販促' })
  })

  test('rename は PATCH に { name }', async () => {
    const api = await loadApi()
    await api.campaigns.rename('c1', '新', 'acc-1')
    expect(captured[0].url).toBe(`${BASE}/api/campaigns/c1?accountId=acc-1`)
    expect(captured[0].method).toBe('PATCH')
    expect(captured[0].body).toEqual({ name: '新' })
  })

  test('remove は DELETE', async () => {
    const api = await loadApi()
    await api.campaigns.remove('c1', 'acc-1')
    expect(captured[0].method).toBe('DELETE')
    expect(captured[0].url).toBe(`${BASE}/api/campaigns/c1?accountId=acc-1`)
  })

  test('linkBroadcast は POST /:id/broadcasts に { broadcastId, linked }', async () => {
    const api = await loadApi()
    await api.campaigns.linkBroadcast('c1', 'b1', true, 'acc-1')
    expect(captured[0].url).toBe(`${BASE}/api/campaigns/c1/broadcasts?accountId=acc-1`)
    expect(captured[0].method).toBe('POST')
    expect(captured[0].body).toEqual({ broadcastId: 'b1', linked: true })
  })

  test('送信ゼロ: campaigns の全操作が send 系を叩かない', async () => {
    const api = await loadApi()
    await api.campaigns.list('acc-1')
    await api.campaigns.create('acc-1', 'x')
    await api.campaigns.linkBroadcast('c1', 'b1', true, 'acc-1')
    expect(captured.filter((c) => SEND_RE.test(c.url))).toHaveLength(0)
  })
})

describe('T-C7: templatePacks (G16)', () => {
  test('list は GET /api/template-packs?accountId=', async () => {
    const api = await loadApi()
    await api.templatePacks.list('acc-1')
    expect(captured[0].url).toBe(`${BASE}/api/template-packs?accountId=acc-1`)
  })

  test('create は POST に { name, items }', async () => {
    const api = await loadApi()
    await api.templatePacks.create('acc-1', { name: 'p', items: [{ messageType: 'text', messageContent: 'hi' }] })
    expect(captured[0].url).toBe(`${BASE}/api/template-packs?accountId=acc-1`)
    expect(captured[0].method).toBe('POST')
    expect(captured[0].body).toEqual({ name: 'p', items: [{ messageType: 'text', messageContent: 'hi' }] })
  })

  test('update は PATCH に部分 body', async () => {
    const api = await loadApi()
    await api.templatePacks.update('p1', { items: [{ messageType: 'flex', messageContent: '{}' }] }, 'acc-1')
    expect(captured[0].url).toBe(`${BASE}/api/template-packs/p1?accountId=acc-1`)
    expect(captured[0].method).toBe('PATCH')
    expect(captured[0].body).toEqual({ items: [{ messageType: 'flex', messageContent: '{}' }] })
  })

  test('remove は DELETE', async () => {
    const api = await loadApi()
    await api.templatePacks.remove('p1', 'acc-1')
    expect(captured[0].method).toBe('DELETE')
  })

  test('送信ゼロ: templatePacks の全操作が send 系を叩かない (挿入と送信の分離)', async () => {
    const api = await loadApi()
    await api.templatePacks.list('acc-1')
    await api.templatePacks.create('acc-1', { name: 'p', items: [] })
    await api.templatePacks.get('p1', 'acc-1')
    expect(captured.filter((c) => SEND_RE.test(c.url))).toHaveLength(0)
  })
})

describe('T-C8: richMenuTapAnalytics (G58)', () => {
  test('taps は GET /api/rich-menu-analytics/taps に 4 param', async () => {
    const api = await loadApi()
    await api.richMenuTapAnalytics.taps({ accountId: 'acc-1', groupId: 'g1', startDate: '2026-03-01', endDate: '2026-03-31' })
    const u = new URL(captured[0].url)
    expect(u.pathname).toBe('/api/rich-menu-analytics/taps')
    expect(u.searchParams.get('accountId')).toBe('acc-1')
    expect(u.searchParams.get('groupId')).toBe('g1')
    expect(u.searchParams.get('startDate')).toBe('2026-03-01')
    expect(u.searchParams.get('endDate')).toBe('2026-03-31')
    expect(captured[0].method).toBe('GET')
  })

  test('送信ゼロ: taps は read-only で send 系を叩かない', async () => {
    const api = await loadApi()
    await api.richMenuTapAnalytics.taps({ accountId: 'acc-1', groupId: 'g1', startDate: '2026-03-01', endDate: '2026-03-31' })
    expect(captured.filter((c) => SEND_RE.test(c.url))).toHaveLength(0)
  })
})
