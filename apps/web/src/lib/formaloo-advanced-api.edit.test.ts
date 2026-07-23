/**
 * form-post-edit (弾M / T-D1) — formalooDataApi.editRow の request 契約テスト。
 *   worker を叩かず global.fetch を stub し「PATCH /api/forms-advanced/{id}/rows/{rowId} + body {answers}」を固定。
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

const BASE = 'https://worker.example.test'

beforeAll(() => {
  process.env.NEXT_PUBLIC_API_URL = BASE
})

interface Captured { url: string; method: string; body: unknown; headers?: HeadersInit }
let captured: Captured[] = []
let nextResponse: { ok: boolean; status: number; data: unknown; error?: string } = { ok: true, status: 200, data: null }

beforeEach(() => {
  captured = []
  nextResponse = { ok: true, status: 200, data: null }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    captured.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      body: init?.body instanceof FormData
        ? init.body
        : init?.body ? JSON.parse(init.body as string) : undefined,
      headers: init?.headers,
    })
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

  test('内部回答は editVersion を同じ PATCH body に載せて CAS できる', async () => {
    const api = await loadApi()
    nextResponse = {
      ok: true,
      status: 200,
      data: {
        id: 'r1', answers: { nameSlug: '内部更新' }, submittedAt: '2026-07-17T00:00:00+09:00',
        source: 'internal', editVersion: 8, answerRevision: 'next-revision', lastEdit: null,
      },
    }

    const res = await api.editRow('f1', 'r1', { nameSlug: '内部更新' }, 7, 'shown-revision')

    expect(captured).toHaveLength(1)
    expect(captured[0].body).toEqual({
      answers: { nameSlug: '内部更新' }, editVersion: 7, answerRevision: 'shown-revision',
    })
    expect(res).toMatchObject({ source: 'internal', editVersion: 8, answerRevision: 'next-revision' })
  })

  test('添付変更は既存 index と File を multipart に載せ、browser に boundary を付けさせる', async () => {
    const api = await loadApi()
    const added = new File(['new'], '追加.png', { type: 'image/png' })
    nextResponse = {
      ok: true,
      status: 200,
      data: {
        id: 'r1', answers: { docs: [] }, submittedAt: '2026-07-17T00:00:00+09:00',
        source: 'internal', editVersion: 8, answerRevision: 'next-revision', lastEdit: null,
      },
    }

    await api.editRow('f1', 'r1', { name: '更新' }, 7, 'shown-revision', {
      attachments: [{
        fieldIndex: 2,
        fieldId: 'docs',
        removedIndexes: [0, 3],
        files: [added],
      }],
    })

    const body = captured[0].body as FormData
    expect(body).toBeInstanceOf(FormData)
    expect(body.get('answers')).toBe(JSON.stringify({ name: '更新' }))
    expect(body.get('editVersion')).toBe('7')
    expect(body.get('answerRevision')).toBe('shown-revision')
    expect(body.get('attachment_field_2')).toBe('docs')
    expect(body.getAll('remove_a_2')).toEqual(['0', '3'])
    expect(body.getAll('a_2')).toEqual([added])
    expect(new Headers(captured[0].headers).has('Content-Type')).toBe(false)
  })
})
