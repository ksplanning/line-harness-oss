import { fetchApi } from './api'

// =============================================================================
// ハーネス側フォルダ分類 API クライアント (F6-3 / 本柱③)。fetchApi 経由 (cookie 認証 + CSRF)。
// フォルダはハーネス側だけの整理軸 (SoT)。Formaloo 側フォルダとは自動連動しない (API 非露出 / N-19)。
// 割当 (assign) は /api/forms-advanced/:id/folder (Formaloo push なし = ローカル分類)。
// =============================================================================

export interface FormalooFolder {
  id: string
  lineAccountId: string
  name: string
  parentId: string | null
  position: number
}

interface Envelope<T> {
  success: boolean
  data: T
  error?: string
}

export const formalooFoldersApi = {
  // account スコープのフォルダ一覧 (別 account のフォルダは返らない = server 側で絞る)。
  async list(lineAccountId: string): Promise<FormalooFolder[]> {
    return (await fetchApi<Envelope<FormalooFolder[]>>(`/api/formaloo-folders?lineAccountId=${encodeURIComponent(lineAccountId)}`)).data
  },
  async create(lineAccountId: string, name: string, parentId?: string | null): Promise<FormalooFolder> {
    return (
      await fetchApi<Envelope<FormalooFolder>>('/api/formaloo-folders', {
        method: 'POST',
        body: JSON.stringify({ lineAccountId, name, parentId: parentId ?? null }),
      })
    ).data
  },
  async rename(id: string, name: string): Promise<void> {
    await fetchApi<Envelope<null>>(`/api/formaloo-folders/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
  },
  // 親付け替え (null=トップレベル化)。循環/自己親/別 account は server が 400 で弾く。
  async move(id: string, parentId: string | null): Promise<void> {
    await fetchApi<Envelope<null>>(`/api/formaloo-folders/${id}`, { method: 'PATCH', body: JSON.stringify({ parentId }) })
  },
  // 削除 (所属 form は未分類へ・form は消えない / 子は親へ再接続)。
  async remove(id: string): Promise<void> {
    await fetchApi<Envelope<null>>(`/api/formaloo-folders/${id}`, { method: 'DELETE' })
  },
  // フォーム→フォルダ割当/解除 (folderId=null で未分類)。同一 account 検証は server (cross-account 400)。
  async assign(formId: string, folderId: string | null): Promise<void> {
    await fetchApi<Envelope<unknown>>(`/api/forms-advanced/${formId}/folder`, { method: 'PUT', body: JSON.stringify({ folderId }) })
  },
}
