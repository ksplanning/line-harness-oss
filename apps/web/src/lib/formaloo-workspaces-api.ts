import { fetchApi } from './api'

// =============================================================================
// Formaloo workspace キー管理 API クライアント (F6-1 / T-A5)。fetchApi 経由 (cookie 認証 + CSRF)。
// -----------------------------------------------------------------------------
// 全 route は owner-only (worker の ownerGate が enforcement)。KEY/SECRET は書き込み専用で、
// 応答・一覧には決して含まれない (write-only / M-8)。UI は登録済みの label/有効状態のみ表示する。
// =============================================================================

export interface FormalooWorkspace {
  id: string
  label: string
  businessSlug: string | null
  isActive: boolean
}

interface Envelope<T> {
  success: boolean
  data: T
  error?: string
}

export const formalooWorkspacesApi = {
  async list(): Promise<FormalooWorkspace[]> {
    return (await fetchApi<Envelope<FormalooWorkspace[]>>('/api/formaloo-workspaces')).data
  },
  /** 疎通テスト (dry-run / 保存しない)。ok=false でも throw しない (テスト結果として boolean を返す)。 */
  async test(key: string, secret: string): Promise<boolean> {
    return (
      await fetchApi<Envelope<{ ok: boolean }>>('/api/formaloo-workspaces/test', {
        method: 'POST',
        body: JSON.stringify({ key, secret }),
      })
    ).data.ok
  },
  /** 追加 (疎通テスト → 暗号化 → 保存)。誤鍵/KEK 未投入は fetchApi が throw (caller が error 表示)。 */
  async add(input: {
    label: string
    key: string
    secret: string
    businessSlug?: string | null
  }): Promise<FormalooWorkspace> {
    return (
      await fetchApi<Envelope<FormalooWorkspace>>('/api/formaloo-workspaces', {
        method: 'POST',
        body: JSON.stringify(input),
      })
    ).data
  },
  /** 有効化/無効化の切替 (F6-1「切替」= enable/disable)。 */
  async setActive(id: string, isActive: boolean): Promise<void> {
    await fetchApi<Envelope<unknown>>(`/api/formaloo-workspaces/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ isActive }),
    })
  },
  /** 削除 (soft-delete)。 */
  async remove(id: string): Promise<void> {
    await fetchApi<Envelope<null>>(`/api/formaloo-workspaces/${id}`, { method: 'DELETE' })
  },
}
