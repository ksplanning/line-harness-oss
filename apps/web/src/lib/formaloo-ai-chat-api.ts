import { fetchApi } from './api'

export type FormalooAiChatStatus = 'pending' | 'completed' | 'failed'

export interface FormalooAiChatHistoryItem {
  id: string
  tenantScope: string
  lineAccountId: string
  formId: string
  question: string
  answer: Record<string, unknown> | null
  answerText: string | null
  analysisSlug: string | null
  status: FormalooAiChatStatus
  providerStatus: string | null
  errorCode: string | null
  errorMessage: string | null
  creditsConsumed: boolean
  creditReserved: boolean
  createdAt: string
  updatedAt: string
}

interface Envelope<T> {
  success: boolean
  data: T
}

interface ApiErrorLike {
  status?: number
  body?: { code?: string; error?: string }
}

export const formalooAiChatApi = {
  async analyze(input: { formId: string; lineAccountId: string; prompt: string }): Promise<FormalooAiChatHistoryItem> {
    const response = await fetchApi<Envelope<FormalooAiChatHistoryItem>>('/api/forms-advanced/ai-chat/analyze', {
      method: 'POST',
      body: JSON.stringify(input),
    })
    return response.data
  },

  async history(input: { formId: string; lineAccountId: string; limit?: number }): Promise<FormalooAiChatHistoryItem[]> {
    const params = new URLSearchParams({ formId: input.formId, lineAccountId: input.lineAccountId })
    params.set('limit', String(input.limit ?? 50))
    const response = await fetchApi<Envelope<{ items: FormalooAiChatHistoryItem[] }>>(
      `/api/forms-advanced/ai-chat/history?${params.toString()}`,
    )
    return response.data.items
  },
}

export function formalooAiChatErrorMessage(error: unknown): string {
  const apiError = error as ApiErrorLike
  const code = apiError?.body?.code
  if (code === 'history_write_failed') {
    return 'AI回答を履歴に保存できませんでした。再送せず、管理者に確認してください'
  }
  if (apiError?.status === 404 && code === 'ai_chat_disabled') {
    return 'AIチャットは現在オフです。管理者が設定を有効にすると使えます'
  }
  if (apiError?.status === 409 && code === 'analysis_in_progress') {
    return 'このフォームは分析中です。回答が表示されるまでお待ちください'
  }
  if (code === 'daily_limit_reached') {
    return '本日のAI分析上限に達しました。明日以降にもう一度お試しください'
  }
  if (code === 'no_analysis_data') {
    return '分析できる確認済みの回答データがまだありません'
  }
  if (code === 'analysis_data_unavailable') {
    return '回答データを準備できませんでした。少し待ってからもう一度お試しください'
  }
  if (code === 'ai_unavailable') {
    return 'AIから回答を受け取れませんでした。少し待ってからもう一度お試しください'
  }
  if (apiError?.status === 429) {
    return '操作が混み合っています。少し待ってから画面を再読み込みしてください'
  }
  if (apiError?.status === 408 || apiError?.status === 504) {
    return 'AIの回答に時間がかかっています。少し待ってからもう一度お試しください'
  }
  return 'AI分析の状態を確認できません。連続実行せず、管理者に確認してください'
}
