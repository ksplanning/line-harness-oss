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
      json: async () => ({
        success: true,
        data: { defaultReplyName: '受付係' },
      }),
    } as unknown as Response
  }))
})

afterEach(() => vi.unstubAllGlobals())

async function loadApi() {
  return (await import('./api')).api
}

describe('chat reply settings API client', () => {
  test('encodes the account id when loading the account-scoped setting', async () => {
    const api = await loadApi()

    await expect(
      api.accountSettings.getChatReplySettings('account/1 ?'),
    ).resolves.toEqual({
      success: true,
      data: { defaultReplyName: '受付係' },
    })
    expect(captured[0]).toEqual({
      url: `${BASE}/api/account-settings/chat-reply?accountId=account%2F1%20%3F`,
      method: 'GET',
      body: undefined,
    })
  })

  test('sends the account id and exact reply name when updating the setting', async () => {
    const api = await loadApi()

    await api.accountSettings.updateChatReplySettings('account-1', '夜間受付')

    expect(captured[0]).toEqual({
      url: `${BASE}/api/account-settings/chat-reply`,
      method: 'PUT',
      body: {
        accountId: 'account-1',
        defaultReplyName: '夜間受付',
      },
    })
  })
})
