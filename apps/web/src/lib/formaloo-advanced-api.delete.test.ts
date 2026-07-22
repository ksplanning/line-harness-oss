/**
 * form-response-delete (D-2) — formalooDataApi.deleteRow の request 契約。
 * worker を叩かず、DELETE path・body 無し・Envelope data:null を固定する。
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

const BASE = 'https://worker.example.test'

beforeAll(() => {
  process.env.NEXT_PUBLIC_API_URL = BASE
})

interface CapturedRequest {
  url: string
  method: string
  body: BodyInit | null | undefined
}

let captured: CapturedRequest[] = []

beforeEach(() => {
  captured = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    captured.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      body: init?.body,
    })
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, data: null }),
    } as Response
  }))
})

afterEach(() => vi.unstubAllGlobals())

describe('formalooDataApi.deleteRow', () => {
  test('DELETE /api/forms-advanced/{id}/rows/{rowId} を body 無しで送り Envelope data:null を受理する', async () => {
    const { formalooDataApi } = await import('./formaloo-advanced-api')

    await expect(formalooDataApi.deleteRow('form-1', 'row-1')).resolves.toBeUndefined()

    expect(captured).toEqual([{
      url: `${BASE}/api/forms-advanced/form-1/rows/row-1`,
      method: 'DELETE',
      body: undefined,
    }])
  })
})
