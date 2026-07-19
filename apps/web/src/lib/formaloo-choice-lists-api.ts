import type { ChoiceFetchItem } from '@line-crm/shared'

export interface FormalooChoiceList {
  id: string
  name: string
  items: ChoiceFetchItem[]
  sourceUrl: string
  createdAt?: string
  updatedAt?: string
}

interface Envelope<T> {
  success: boolean
  data: T
}

export interface FormalooChoiceListInput {
  name: string
  items: ChoiceFetchItem[]
}

function collectionPath(formId: string): string {
  return `/api/forms-advanced/${encodeURIComponent(formId)}/choice-lists`
}

function itemPath(formId: string, listId: string): string {
  return `${collectionPath(formId)}/${encodeURIComponent(listId)}`
}

/**
 * builder の既存 field test / 画面では choice list API 自体を使わない。
 * 操作時にだけ API 基盤を読み、未使用フォームを環境変数の読み込みから切り離す。
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { fetchApi } = await import('./api')
  return init === undefined ? fetchApi<T>(path) : fetchApi<T>(path, init)
}

/** form 単位の choice_fetch 供給リストを管理する、cookie/CSRF 付き管理 API。 */
export const formalooChoiceListsApi = {
  async list(formId: string): Promise<FormalooChoiceList[]> {
    return (await request<Envelope<FormalooChoiceList[]>>(collectionPath(formId))).data
  },

  async create(formId: string, input: FormalooChoiceListInput): Promise<FormalooChoiceList> {
    return (await request<Envelope<FormalooChoiceList>>(collectionPath(formId), {
      method: 'POST',
      body: JSON.stringify(input),
    })).data
  },

  async update(formId: string, listId: string, input: FormalooChoiceListInput): Promise<FormalooChoiceList> {
    return (await request<Envelope<FormalooChoiceList>>(itemPath(formId, listId), {
      method: 'PATCH',
      body: JSON.stringify(input),
    })).data
  },

  async remove(formId: string, listId: string): Promise<void> {
    await request<Envelope<null>>(itemPath(formId, listId), { method: 'DELETE' })
  },
}
