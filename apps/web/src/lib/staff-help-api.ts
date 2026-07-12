import { fetchApi } from './api'

/**
 * line-staff-docs-chat Batch 2 — 常駐ヘルプパネルの worker API ラッパ (lib/api.ts の fetchApi 様式踏襲)。
 * static export (output:'export') 制約下でも client component から worker /api/staff-docs/* を fetch する
 * (新規動的ルート追加なし)。**送信ゼロ**: 顧客への LINE 送信経路には一切触れない (help 応答は HTTP のみ)。
 */

export type StaffHelpStatus = 'ok' | 'no_evidence' | 'busy' | 'error'

export interface StaffHelpCitation {
  docId: string
  docTitle: string
  chunkId: string
}

export interface StaffHelpAnswer {
  status: StaffHelpStatus
  answer: string
  citations: StaffHelpCitation[]
}

/**
 * capabilities discovery で staff-docs が有効か (両面 OFF の web 側 / plan §6)。
 * STAFF_DOCS_ENABLED != 'true' → false → パネル非描画 (dark-ship)。取得失敗も安全側 false。
 */
export async function fetchStaffDocsEnabled(): Promise<boolean> {
  try {
    const res = await fetchApi<{ success: boolean; data: { staffDocs?: boolean } }>('/api/capabilities')
    return res?.data?.staffDocs === true
  } catch {
    return false
  }
}

/** スタッフ質問を投げて RAG 回答 + 根拠引用を得る (fail-closed は status で表現)。 */
export async function postStaffHelpChat(question: string): Promise<StaffHelpAnswer> {
  const res = await fetchApi<{ success: boolean; data: StaffHelpAnswer }>('/api/staff-docs/chat', {
    method: 'POST',
    body: JSON.stringify({ question }),
  })
  return res.data
}
