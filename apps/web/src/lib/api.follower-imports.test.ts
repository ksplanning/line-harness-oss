import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

const BASE = 'https://worker.example.test'
const captured: Array<{ url: string; method: string }> = []

beforeAll(() => {
  process.env.NEXT_PUBLIC_API_URL = BASE
})

beforeEach(() => {
  captured.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    captured.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
    })
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: null }),
    } as unknown as Response
  }))
})

afterEach(() => vi.unstubAllGlobals())

async function loadApi() {
  return (await import('./api')).api
}

describe('follower imports API client', () => {
  test('account scope を URL encode して開始・最新状態を取得する', async () => {
    const api = await loadApi()

    await api.followerImports.start('account/a')
    await api.followerImports.latest('account/a')

    expect(captured).toEqual([
      {
        url: `${BASE}/api/friends/follower-imports?accountId=account%2Fa`,
        method: 'POST',
      },
      {
        url: `${BASE}/api/friends/follower-imports/latest?accountId=account%2Fa`,
        method: 'GET',
      },
    ])
  })

  test('進行中 job を account scope 付きで1段階進める', async () => {
    const api = await loadApi()

    await api.followerImports.advance('job/1', 'account/a')

    expect(captured).toEqual([{
      url: `${BASE}/api/friends/follower-imports/job%2F1/advance?accountId=account%2Fa`,
      method: 'POST',
    }])
  })
})
