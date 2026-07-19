import { beforeEach, describe, expect, test, vi } from 'vitest'

const fetchApiMock = vi.hoisted(() => vi.fn())
vi.mock('./api', () => ({ fetchApi: (...args: unknown[]) => fetchApiMock(...args) }))

import { formalooAiChatApi, formalooAiChatErrorMessage } from './formaloo-ai-chat-api'

beforeEach(() => fetchApiMock.mockReset())

const item = {
  id: 'fac_1', tenantScope: 'tenant-a', lineAccountId: 'line/a', formId: 'fa/1',
  question: '今週の傾向は？', answer: { summary: '回答が増えています' },
  answerText: '回答が増えています', analysisSlug: 'analysis_1', status: 'completed' as const,
  providerStatus: 'completed', errorCode: null, errorMessage: null,
  creditsConsumed: true, creditReserved: true,
  createdAt: '2026-07-20T10:00:00.000+09:00', updatedAt: '2026-07-20T10:00:01.000+09:00',
}

describe('formalooAiChatApi', () => {
  test('asks with the selected local form/account and prompt only', async () => {
    fetchApiMock.mockResolvedValue({ success: true, data: item })
    await expect(formalooAiChatApi.analyze({
      formId: 'fa/1', lineAccountId: 'line/a', prompt: '今週の傾向は？',
    })).resolves.toEqual(item)
    expect(fetchApiMock).toHaveBeenCalledWith('/api/forms-advanced/ai-chat/analyze', {
      method: 'POST',
      body: JSON.stringify({ formId: 'fa/1', lineAccountId: 'line/a', prompt: '今週の傾向は？' }),
    })
  })

  test('loads encoded form-scoped history', async () => {
    fetchApiMock.mockResolvedValue({ success: true, data: { items: [item] } })
    await expect(formalooAiChatApi.history({ formId: 'fa/1', lineAccountId: 'line/a', limit: 20 }))
      .resolves.toEqual([item])
    expect(fetchApiMock).toHaveBeenCalledWith(
      '/api/forms-advanced/ai-chat/history?formId=fa%2F1&lineAccountId=line%2Fa&limit=20',
    )
  })
})

describe('formalooAiChatErrorMessage', () => {
  test.each([
    [{ status: 404, body: { code: 'ai_chat_disabled' } }, 'AIチャットは現在オフです。管理者が設定を有効にすると使えます'],
    [{ status: 402, body: { code: 'credits_exhausted' } }, 'Formaloo のAI利用枠が足りません。利用状況を確認してください'],
    [{ status: 409, body: { code: 'analysis_in_progress' } }, 'このフォームは分析中です。回答が表示されるまでお待ちください'],
    [{ status: 429, body: { code: 'daily_limit_reached' } }, '本日のAI分析上限に達しました。明日以降にもう一度お試しください'],
    [{ status: 504, body: { code: 'poll_timeout' } }, '回答に時間がかかっています。連続実行せず、管理者に確認してください'],
    [{ status: 502, body: { code: 'provider_unknown_failure' } }, 'Formaloo で分析を始められたか確認できません。連続実行せず、管理者に確認してください'],
    [{ status: 429, body: { error: 'Too many requests' } }, '操作が混み合っています。少し待ってから画面を再読み込みしてください'],
  ] as const)('maps operational failure %# to everyday Japanese', (error, message) => {
    expect(formalooAiChatErrorMessage(error)).toBe(message)
  })
})
