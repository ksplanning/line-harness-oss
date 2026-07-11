import { fetchApi } from './api'

// =============================================================================
// Formaloo アカウント→既定 workspace binding API クライアント (F6-2 / T-B3)。fetchApi 経由 (cookie + CSRF)。
// -----------------------------------------------------------------------------
// 全 route は owner-only (worker の ownerGate が enforcement)。作成 UI の workspace セレクタ既定 +
// POST /api/forms-advanced の明示無し解決に使う。default_workspace_id は登録済 active workspace のみ受理。
// =============================================================================

export interface FormalooAccountBinding {
  lineAccountId: string
  defaultWorkspaceId: string | null
}

interface Envelope<T> {
  success: boolean
  data: T
  error?: string
}

export const formalooAccountBindingsApi = {
  async list(): Promise<FormalooAccountBinding[]> {
    return (await fetchApi<Envelope<FormalooAccountBinding[]>>('/api/formaloo-account-bindings')).data
  },
  /** set: そのアカウントの既定 workspace を登録済 active workspace に設定 (UPSERT)。 */
  async set(lineAccountId: string, defaultWorkspaceId: string): Promise<void> {
    await fetchApi<Envelope<unknown>>(`/api/formaloo-account-bindings/${encodeURIComponent(lineAccountId)}`, {
      method: 'PUT',
      body: JSON.stringify({ defaultWorkspaceId }),
    })
  },
  /** clear: 既定 workspace の binding を削除 (以後は env 既定)。 */
  async clear(lineAccountId: string): Promise<void> {
    await fetchApi<Envelope<null>>(`/api/formaloo-account-bindings/${encodeURIComponent(lineAccountId)}`, {
      method: 'DELETE',
    })
  },
}
