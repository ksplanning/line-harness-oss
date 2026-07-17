/**
 * form-post-edit (弾M / T-D1) — formalooDataApi.editRow の request 契約テスト。
 *   worker を叩かず global.fetch を stub し「PATCH /api/forms-advanced/{id}/rows/{rowId} + body {answers}」を固定。
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

const BASE = 'https://worker.example.test'

beforeAll(() => {
  process.env.NEXT_PUBLIC_API_URL = BASE
})

interface Captured { url: string; method: string; body: unknown }
let captured: Captured[] = []
let nextResponse: { ok: boolean; status: number; data: unknown; error?: string } = { ok: true, status: 200, data: null }

beforeEach(() => {
  captured = []
  nextResponse = { ok: true, status: 200, data: null }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    captured.push({ url, method: (init?.method ?? 'GET').toUpperCase(), body: init?.body ? JSON.parse(init.body as string) : undefined })
    return {
      ok: nextResponse.ok,
      status: nextResponse.status,
      json: async () => (nextResponse.ok ? { success: true, data: nextResponse.data } : { success: false, error: nextResponse.error ?? 'error' }),
    } as unknown as Response
  }))
})
afterEach(() => vi.unstubAllGlobals())

async function loadApi() {
  const mod = await import('./formaloo-advanced-api')
  return mod.formalooDataApi
}

describe('T-D1 formalooDataApi.editRow', () => {
  test('PATCH /api/forms-advanced/{id}/rows/{rowId} に answers を送り Envelope.data を返す', async () => {
    const api = await loadApi()
    nextResponse = { ok: true, status: 200, data: { id: 'r1', answers: { nameSlug: '山田' }, submittedAt: '2026-07-17T00:00:00+09:00', source: 'formaloo', lastEdit: { editorStaffId: 'env-owner', editorName: 'Owner', editedAt: '2026-07-17T01:00:00+09:00' } } }

    const res = await api.editRow('f1', 'r1', { nameSlug: '山田' })

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe(`${BASE}/api/forms-advanced/f1/rows/r1`)
    expect(captured[0].method).toBe('PATCH')
    expect(captured[0].body).toEqual({ answers: { nameSlug: '山田' } })
    expect(res.answers).toEqual({ nameSlug: '山田' })
    expect(res.lastEdit?.editorName).toBe('Owner')
  })

  test('非 2xx (必須空など) はエラーを throw する (呼び出し側で保存を止める)', async () => {
    const api = await loadApi()
    nextResponse = { ok: false, status: 400, data: null, error: '必須項目を空にできません' }
    await expect(api.editRow('f1', 'r1', { nameSlug: '' })).rejects.toBeTruthy()
  })
})
