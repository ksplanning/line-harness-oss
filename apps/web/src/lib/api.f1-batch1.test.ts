/**
 * F1 batch1 — api client 拡張の request 契約テスト (T-A1)。
 *
 * worker を一切叩かず、global.fetch を stub して
 * 「どの URL に / どの method で / どの body を投げるか」を assert する。
 * worker route の serialize 形 (tracked-links.ts / calendar.ts / reminders.ts) と
 * 一致する URL/method/body を api client が組むことを固定する。
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

const BASE = 'https://worker.example.test'

// api.ts はモジュール読込時に NEXT_PUBLIC_API_URL を要求する。import より前に設定。
beforeAll(() => {
  process.env.NEXT_PUBLIC_API_URL = BASE
})

// 各テストで fetch 呼び出しを捕捉するための stub。
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

describe('T-A1: trackedLinks namespace 拡張', () => {
  test('get(id) は GET /api/tracked-links/:id を叩く', async () => {
    const api = await loadApi()
    await api.trackedLinks.get('lk_1')
    expect(captured[0]).toEqual({
      url: `${BASE}/api/tracked-links/lk_1`,
      method: 'GET',
      body: undefined,
    })
  })

  test('create は POST /api/tracked-links に name/originalUrl/tagId を送る', async () => {
    const api = await loadApi()
    await api.trackedLinks.create({ name: '春キャン', originalUrl: 'https://ex.com/a', tagId: 'tag_1' })
    expect(captured[0].url).toBe(`${BASE}/api/tracked-links`)
    expect(captured[0].method).toBe('POST')
    expect(captured[0].body).toEqual({ name: '春キャン', originalUrl: 'https://ex.com/a', tagId: 'tag_1' })
  })

  test('create は tagId 省略時 null を送れる', async () => {
    const api = await loadApi()
    await api.trackedLinks.create({ name: 'x', originalUrl: 'https://ex.com', tagId: null })
    expect(captured[0].body).toEqual({ name: 'x', originalUrl: 'https://ex.com', tagId: null })
  })

  test('patch は PATCH /api/tracked-links/:id に部分更新を送る (name/tagId のみでも可)', async () => {
    // batch2 C7 で originalUrl も patch で送れるようになった (worker PATCH + db SET 句 + server URL 検証)。
    // ここでは name/tagId のみの部分更新が従来通り送れることを固定 (originalUrl 送信は batch2 テストでカバー)。
    const api = await loadApi()
    await api.trackedLinks.patch('lk_9', { name: '改名', tagId: null })
    expect(captured[0].url).toBe(`${BASE}/api/tracked-links/lk_9`)
    expect(captured[0].method).toBe('PATCH')
    expect(captured[0].body).toEqual({ name: '改名', tagId: null })
  })

  test('delete は DELETE /api/tracked-links/:id を叩く (body なし)', async () => {
    const api = await loadApi()
    await api.trackedLinks.delete('lk_del')
    expect(captured[0]).toEqual({
      url: `${BASE}/api/tracked-links/lk_del`,
      method: 'DELETE',
      body: undefined,
    })
  })

  test('list は既存どおり GET /api/tracked-links (回帰なし)', async () => {
    const api = await loadApi()
    await api.trackedLinks.list()
    expect(captured[0].url).toBe(`${BASE}/api/tracked-links`)
    expect(captured[0].method).toBe('GET')
  })
})

describe('T-A1: calendar namespace 新設', () => {
  test('list は GET /api/integrations/google-calendar', async () => {
    const api = await loadApi()
    await api.calendar.list()
    expect(captured[0].url).toBe(`${BASE}/api/integrations/google-calendar`)
    expect(captured[0].method).toBe('GET')
  })

  test('connect は POST /connect に calendarId/authType/apiKey を送る', async () => {
    const api = await loadApi()
    await api.calendar.connect({ calendarId: 'me@gmail.com', authType: 'api_key', apiKey: 'AIzaXXX' })
    expect(captured[0].url).toBe(`${BASE}/api/integrations/google-calendar/connect`)
    expect(captured[0].method).toBe('POST')
    expect(captured[0].body).toEqual({ calendarId: 'me@gmail.com', authType: 'api_key', apiKey: 'AIzaXXX' })
  })

  test('disconnect は DELETE /api/integrations/google-calendar/:id', async () => {
    const api = await loadApi()
    await api.calendar.disconnect('cal_1')
    expect(captured[0].url).toBe(`${BASE}/api/integrations/google-calendar/cal_1`)
    expect(captured[0].method).toBe('DELETE')
  })
})

describe('T-A1: reminders namespace 拡張 (enroll)', () => {
  test('enroll は POST /api/reminders/:id/enroll/:friendId に targetDate を送る', async () => {
    const api = await loadApi()
    await api.reminders.enroll('rem_1', 'fr_1', { targetDate: '2026-07-10' })
    expect(captured[0].url).toBe(`${BASE}/api/reminders/rem_1/enroll/fr_1`)
    expect(captured[0].method).toBe('POST')
    expect(captured[0].body).toEqual({ targetDate: '2026-07-10' })
  })

  test('unenroll は DELETE /api/friend-reminders/:id (friend-reminders 経路)', async () => {
    const api = await loadApi()
    await api.reminders.unenroll('fre_1')
    expect(captured[0].url).toBe(`${BASE}/api/friend-reminders/fre_1`)
    expect(captured[0].method).toBe('DELETE')
  })

  test('listEnrollments は GET /api/friends/:friendId/reminders (友だち別・worker 実経路)', async () => {
    const api = await loadApi()
    await api.reminders.listEnrollments('fr_9')
    expect(captured[0].url).toBe(`${BASE}/api/friends/fr_9/reminders`)
    expect(captured[0].method).toBe('GET')
  })

  test('既存 reminders.list は回帰なし (GET /api/reminders)', async () => {
    const api = await loadApi()
    await api.reminders.list()
    expect(captured[0].url).toBe(`${BASE}/api/reminders`)
    expect(captured[0].method).toBe('GET')
  })

  test('G57 差し戻し: create は body に lineAccountId を含めて POST できる', async () => {
    const api = await loadApi()
    await api.reminders.create({ name: '来店前日', lineAccountId: 'acc_1' })
    expect(captured[0].url).toBe(`${BASE}/api/reminders`)
    expect(captured[0].method).toBe('POST')
    expect(captured[0].body).toEqual({ name: '来店前日', lineAccountId: 'acc_1' })
  })
})
