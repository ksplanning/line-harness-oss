/**
 * F1 batch2 — api client 拡張の request 契約テスト (T-M4 / T-A1)。
 *
 * worker を叩かず global.fetch を stub し「どの URL に / どの method で / どの body を投げるか」を assert。
 * worker route の serialize 形 (images.ts / ad-platforms.ts) と一致する URL/method/body を固定する。
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

beforeEach(() => {
  captured = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      captured.push({
        url,
        method: (init?.method ?? 'GET').toUpperCase(),
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      })
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: null }),
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

describe('T-M4: images namespace 新設 (メディアライブラリ)', () => {
  test('list() は GET /api/images (cursor なし)', async () => {
    const api = await loadApi()
    await api.images.list()
    expect(captured[0].url).toBe(`${BASE}/api/images`)
    expect(captured[0].method).toBe('GET')
  })

  test('list(cursor) は cursor を encodeURIComponent して query に付ける', async () => {
    const api = await loadApi()
    await api.images.list('media/abc.png')
    expect(captured[0].url).toBe(`${BASE}/api/images?cursor=media%2Fabc.png`)
    expect(captured[0].method).toBe('GET')
  })

  test('remove(key) は slash 含み key を encodeURIComponent して DELETE する', async () => {
    const api = await loadApi()
    await api.images.remove('media/xyz.png')
    expect(captured[0].url).toBe(`${BASE}/api/images/media%2Fxyz.png`)
    expect(captured[0].method).toBe('DELETE')
    expect(captured[0].body).toBeUndefined()
  })

  test('upload は既存 api.uploads.image を再利用する (新 upload client を作らない)', async () => {
    const api = await loadApi()
    // images 名前空間に upload は生やさない (R10: fetchApi JSON 強制と衝突しないよう既存 reuse)。
    expect('upload' in api.images).toBe(false)
    expect(typeof api.uploads.image).toBe('function')
  })
})

describe('T-A1: adPlatforms namespace 新設 (広告CV連携)', () => {
  test('list() は GET /api/ad-platforms', async () => {
    const api = await loadApi()
    await api.adPlatforms.list()
    expect(captured[0].url).toBe(`${BASE}/api/ad-platforms`)
    expect(captured[0].method).toBe('GET')
  })

  test('create は POST /api/ad-platforms に name/displayName/config を送る', async () => {
    const api = await loadApi()
    await api.adPlatforms.create({ name: 'meta', displayName: '本番', config: { pixel_id: '123', access_token: 'tok' } })
    expect(captured[0].url).toBe(`${BASE}/api/ad-platforms`)
    expect(captured[0].method).toBe('POST')
    expect(captured[0].body).toEqual({ name: 'meta', displayName: '本番', config: { pixel_id: '123', access_token: 'tok' } })
  })

  test('update は PUT /api/ad-platforms/:id に部分更新 (config 省略可)', async () => {
    const api = await loadApi()
    await api.adPlatforms.update('ap_1', { displayName: '改名', isActive: false })
    expect(captured[0].url).toBe(`${BASE}/api/ad-platforms/ap_1`)
    expect(captured[0].method).toBe('PUT')
    expect(captured[0].body).toEqual({ displayName: '改名', isActive: false })
  })

  test('remove は DELETE /api/ad-platforms/:id', async () => {
    const api = await loadApi()
    await api.adPlatforms.remove('ap_del')
    expect(captured[0].url).toBe(`${BASE}/api/ad-platforms/ap_del`)
    expect(captured[0].method).toBe('DELETE')
  })

  test('test は POST /api/ad-platforms/test に platform/eventName/friendId を送る', async () => {
    const api = await loadApi()
    await api.adPlatforms.test({ platform: 'meta', eventName: '友だち追加', friendId: 'fr_1' })
    expect(captured[0].url).toBe(`${BASE}/api/ad-platforms/test`)
    expect(captured[0].method).toBe('POST')
    expect(captured[0].body).toEqual({ platform: 'meta', eventName: '友だち追加', friendId: 'fr_1' })
  })

  test('logs は GET /api/ad-platforms/:id/logs?limit=', async () => {
    const api = await loadApi()
    await api.adPlatforms.logs('ap_1', 20)
    expect(captured[0].url).toBe(`${BASE}/api/ad-platforms/ap_1/logs?limit=20`)
    expect(captured[0].method).toBe('GET')
  })
})

describe('T-U1: trackedLinks.patch が originalUrl を送れる (C7 / silent-success 根治)', () => {
  test('patch は PATCH /api/tracked-links/:id に originalUrl を含めて送れる', async () => {
    const api = await loadApi()
    await api.trackedLinks.patch('lk_1', { name: '改名', originalUrl: 'https://new.example.com', tagId: null })
    expect(captured[0].url).toBe(`${BASE}/api/tracked-links/lk_1`)
    expect(captured[0].method).toBe('PATCH')
    expect(captured[0].body).toEqual({ name: '改名', originalUrl: 'https://new.example.com', tagId: null })
  })
})
