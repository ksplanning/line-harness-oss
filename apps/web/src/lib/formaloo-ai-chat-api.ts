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
  if (code === 'provider_unknown_failure' || code === 'provider_issue_failed') {
    return 'Formaloo で分析を始められたか確認できません。連続実行せず、管理者に確認してください'
  }
  if (code === 'provider_poll_failed' || code === 'analysis_failed') {
    return 'Formaloo の分析結果を確認できません。連続実行せず、管理者に確認してください'
  }
  if (code === 'history_write_failed') {
    return 'AI回答を履歴に保存できませんでした。再送せず、管理者に確認してください'
  }
  if (code === 'form_not_linked') {
    return '先に高機能フォームを Formaloo へ保存してください'
  }
  if (apiError?.status === 404 && code === 'ai_chat_disabled') {
    return 'AIチャットは現在オフです。管理者が設定を有効にすると使えます'
  }
  if (apiError?.status === 402 || code === 'credits_exhausted') {
    return 'Formaloo のAI利用枠が足りません。利用状況を確認してください'
  }
  if (apiError?.status === 409 && code === 'analysis_in_progress') {
    return 'このフォームは分析中です。回答が表示されるまでお待ちください'
  }
  if (code === 'daily_limit_reached') {
    return '本日のAI分析上限に達しました。明日以降にもう一度お試しください'
  }
  if (apiError?.status === 429) {
    return '操作が混み合っています。少し待ってから画面を再読み込みしてください'
  }
  if (apiError?.status === 408 || apiError?.status === 504 || code === 'poll_timeout' || code === 'provider_timeout') {
    return '回答に時間がかかっています。連続実行せず、管理者に確認してください'
  }
  if (code === 'contract_unconfigured' || code === 'contract_mismatch') {
    return 'Formaloo のAI接続設定を確認中です。管理者に確認してください'
  }
  if (code === 'formaloo_unavailable') {
    return 'Formaloo に接続できません。フォーム連携キーを確認してください'
  }
  return 'AI分析の状態を確認できません。連続実行せず、管理者に確認してください'
}
