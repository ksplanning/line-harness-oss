/**
 * F1 batch3 — api client 拡張の request 契約テスト (T-W1 client / G39 downloadCsv)。
 *
 * worker を叩かず global.fetch を stub し「どの URL に / どの method で」を assert。
 * downloadCsv は fetchApi を使わず fetch(credentials:'include')→blob→downloadBlob 経路
 * (CSV blob を JSON parse で落とさない) であることを固定する。
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

const BASE = 'https://worker.example.test'

beforeAll(() => {
  process.env.NEXT_PUBLIC_API_URL = BASE
})

interface Captured {
  url: string
  method: string
  credentials: string | undefined
}

let captured: Captured[] = []

// downloadBlob (DOM 依存) は stub して呼ばれた filename を記録する。
const downloaded: { filename: string }[] = []
vi.mock('./download', () => ({
  downloadBlob: (_blob: Blob, filename: string) => {
    downloaded.push({ filename })
  },
}))

function stubFetch(response: Partial<Response> & { ok: boolean; status: number }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      captured.push({
        url,
        method: (init?.method ?? 'GET').toUpperCase(),
        credentials: init?.credentials,
      })
      return response as unknown as Response
    }),
  )
}

beforeEach(() => {
  captured = []
  downloaded.length = 0
  stubFetch({ ok: true, status: 200, json: async () => ({ success: true, data: null }) })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function loadMod() {
  return import('./api')
}

describe('T-W1 client: api.scenarios.duplicate', () => {
  test('duplicate(id) は POST /api/scenarios/:id/duplicate', async () => {
    const { api } = await loadMod()
    await api.scenarios.duplicate('sc_1')
    expect(captured[0].url).toBe(`${BASE}/api/scenarios/sc_1/duplicate`)
    expect(captured[0].method).toBe('POST')
  })

  test('duplicate(id, accountId) は lineAccountId を query に付ける (account 境界 guard)', async () => {
    const { api } = await loadMod()
    await api.scenarios.duplicate('sc_1', 'acc-1')
    expect(captured[0].url).toBe(`${BASE}/api/scenarios/sc_1/duplicate?lineAccountId=acc-1`)
    expect(captured[0].method).toBe('POST')
  })
})

describe('G39: downloadCsv (fetchApi を使わない blob 経路)', () => {
  test('downloadCsv は credentials:include で fetch し blob を downloadBlob へ渡す', async () => {
    const blob = new Blob(['﻿a,b\r\n1,2\r\n'], { type: 'text/csv' })
    stubFetch({ ok: true, status: 200, blob: async () => blob } as Partial<Response> & { ok: boolean; status: number })
    const { downloadCsv } = await loadMod()

    await downloadCsv('/api/exports/friends.csv?lineAccountId=acc-1', '友だち一覧_20260703.csv')

    expect(captured[0].url).toBe(`${BASE}/api/exports/friends.csv?lineAccountId=acc-1`)
    expect(captured[0].method).toBe('GET')
    expect(captured[0].credentials).toBe('include') // cross-site cookie
    expect(downloaded[0].filename).toBe('友だち一覧_20260703.csv')
  })

  test('res.ok=false のとき body.error (日本語) を Error として投げ、DL しない', async () => {
    stubFetch({
      ok: false,
      status: 400,
      json: async () => ({ success: false, error: '件数が多すぎて一度に出力できません（上限 5万件）。' }),
    } as Partial<Response> & { ok: boolean; status: number })
    const { downloadCsv } = await loadMod()

    await expect(downloadCsv('/api/exports/friends.csv?lineAccountId=acc-1', 'x.csv')).rejects.toThrow('5万件')
    expect(downloaded).toHaveLength(0)
  })
})
