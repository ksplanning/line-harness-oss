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
      json: async () => ({ success: true, data: {} }),
    } as unknown as Response
  }))
})

afterEach(() => vi.unstubAllGlobals())

async function loadApi() {
  return (await import('./api')).api
}

describe('inquiry console API client', () => {
  test('open/send/complete は URL の問い合わせだけを対象にする worker endpoint を使う', async () => {
    const api = await loadApi()

    await api.chats.openInquiry('friend/1')
    await api.chats.send('friend/1', { content: '確認します' })
    await api.chats.complete('friend/1')

    expect(captured).toEqual([
      {
        url: `${BASE}/api/chats/friend%2F1/inquiry/open`,
        method: 'POST',
        body: undefined,
      },
      {
        url: `${BASE}/api/chats/friend%2F1/send`,
        method: 'POST',
        body: { content: '確認します' },
      },
      {
        url: `${BASE}/api/chats/friend%2F1/complete`,
        method: 'POST',
        body: undefined,
      },
    ])
  })

  test('担当名の自動付与設定を GET/PATCH する', async () => {
    const api = await loadApi()

    await api.chats.inquiryPreferences.get()
    await api.chats.inquiryPreferences.update(false)

    expect(captured).toEqual([
      {
        url: `${BASE}/api/chats/inquiry/preferences`,
        method: 'GET',
        body: undefined,
      },
      {
        url: `${BASE}/api/chats/inquiry/preferences`,
        method: 'PATCH',
        body: { replySignatureEnabled: false },
      },
    ])
  })
})
