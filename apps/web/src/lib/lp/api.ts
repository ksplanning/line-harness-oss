/**
 * LP 置き場 admin クライアント (harness-lp-hosting) — worker `/api/lp/*` を叩く。
 * JSON 系は共有 fetchApi (credentials + CSRF) を再利用。ファイル upload のみ multipart form-data
 * ゆえ fetchApi (Content-Type: application/json 固定) を避け、直接 fetch する (boundary は browser 任せ)。
 * 大きな api.ts に足さず lib/lp/ に分離 = 並走案件との衝突面ゼロ (plan §Files)。
 */
import { fetchApi, getCsrfToken } from '@/lib/api'

const API_URL = process.env.NEXT_PUBLIC_API_URL || ''

export type ApiResponse<T> = { success: true; data: T } | { success: false; error: string }

export interface LpViewCounts {
  total: number
  friendBound: number
}

export interface LpPageItem {
  slug: string
  title: string
  status: 'active' | 'stopped'
  entry_key: string | null
  created_at: string
  updated_at: string
  url: string
  views: LpViewCounts
}

export interface LpViewRow {
  id: string
  lp_slug: string
  friend_id: string | null
  friend_name: string | null
  referrer: string | null
  viewed_at: string
}

export const lpApi = {
  /** 一覧。status='active' で公開中のみ (route-phase2 picker 用)。 */
  list: (status?: 'active') =>
    fetchApi<ApiResponse<{ items: LpPageItem[] }>>(status ? `/api/lp?status=${status}` : '/api/lp'),

  get: (slug: string) =>
    fetchApi<ApiResponse<LpPageItem>>(`/api/lp/${encodeURIComponent(slug)}`),

  create: (body: { slug: string; title: string }) =>
    fetchApi<ApiResponse<LpPageItem>>('/api/lp', { method: 'POST', body: JSON.stringify(body) }),

  setStatus: (slug: string, status: 'active' | 'stopped') =>
    fetchApi<ApiResponse<LpPageItem>>(`/api/lp/${encodeURIComponent(slug)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    }),

  remove: (slug: string) =>
    fetchApi<ApiResponse<null>>(`/api/lp/${encodeURIComponent(slug)}`, { method: 'DELETE' }),

  views: (slug: string) =>
    fetchApi<ApiResponse<{ views: LpViewRow[]; counts: LpViewCounts }>>(
      `/api/lp/${encodeURIComponent(slug)}/views`,
    ),

  /** ファイル upload (multipart)。path 省略時は file.name を使う。index.html は worker が entry_key 記録。 */
  uploadFile: async (
    slug: string,
    file: File,
    path?: string,
  ): Promise<ApiResponse<{ key: string; size: number }>> => {
    const fd = new FormData()
    fd.append('file', file)
    if (path) fd.append('path', path)
    const csrf = getCsrfToken()
    const res = await fetch(`${API_URL}/api/lp/${encodeURIComponent(slug)}/files`, {
      method: 'POST',
      credentials: 'include',
      // Content-Type は付けない (multipart boundary は browser が付与)。CSRF のみ echo。
      headers: { ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      body: fd,
    })
    return (await res.json().catch(() => ({ success: false, error: `アップロードに失敗しました (${res.status})` }))) as ApiResponse<{ key: string; size: number }>
  },
}
