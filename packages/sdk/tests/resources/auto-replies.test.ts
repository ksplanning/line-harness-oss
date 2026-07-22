import { describe, expect, it, vi } from 'vitest'
import type { HttpClient } from '../../src/http.js'
import { AutoRepliesResource } from '../../src/resources/auto-replies.js'
import type { AutoReply } from '../../src/types.js'

function mockHttp(overrides: Partial<HttpClient> = {}): HttpClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  } as unknown as HttpClient
}

const optedInRule: AutoReply = {
  id: 'rule-1',
  keyword: '#問い合わせ',
  matchType: 'exact',
  responseType: 'text',
  responseContent: '担当者が確認します',
  responseMessages: [],
  lineAccountId: 'acc-1',
  keepInUnresponded: true,
  isActive: true,
  createdAt: '2026-07-22T00:00:00+09:00',
}

describe('AutoRepliesResource keepInUnresponded contract', () => {
  it('reads the opt-in from list responses', async () => {
    const http = mockHttp({ get: vi.fn().mockResolvedValue({ success: true, data: [optedInRule] }) })
    const resource = new AutoRepliesResource(http)

    const result = await resource.list()

    expect(result[0].keepInUnresponded).toBe(true)
  })

  it('forwards the opt-in on create and update', async () => {
    const http = mockHttp({
      post: vi.fn().mockResolvedValue({ success: true, data: optedInRule }),
      put: vi.fn().mockResolvedValue({ success: true, data: optedInRule }),
    })
    const resource = new AutoRepliesResource(http)

    await resource.create({
      keyword: '#問い合わせ',
      responseContent: '担当者が確認します',
      keepInUnresponded: true,
    })
    await resource.update('rule-1', { keepInUnresponded: false })

    expect(http.post).toHaveBeenCalledWith('/api/auto-replies', expect.objectContaining({ keepInUnresponded: true }))
    expect(http.put).toHaveBeenCalledWith('/api/auto-replies/rule-1', { keepInUnresponded: false })
  })
})
