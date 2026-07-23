import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

const BASE = 'https://worker.example.test'
const downloadBlobMock = vi.fn()
vi.mock('./download', () => ({ downloadBlob: (...args: unknown[]) => downloadBlobMock(...args) }))

beforeAll(() => {
  process.env.NEXT_PUBLIC_API_URL = BASE
})

interface Captured { url: string; credentials?: RequestCredentials }
let captured: Captured[] = []
let nextResponse: { ok: boolean; status: number; error?: string } = { ok: true, status: 200 }

beforeEach(() => {
  captured = []
  downloadBlobMock.mockReset()
  nextResponse = { ok: true, status: 200 }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    captured.push({ url, credentials: init?.credentials })
    return {
      ok: nextResponse.ok,
      status: nextResponse.status,
      blob: async () => new Blob(['file-bytes']),
      json: async () => ({ success: false, error: nextResponse.error ?? 'error' }),
    } as unknown as Response
  }))
})

afterEach(() => vi.unstubAllGlobals())

async function loadApi() {
  const mod = await import('./formaloo-advanced-api')
  return mod.formalooDataApi
}

describe('formalooDataApi.downloadAttachment', () => {
  test('認証付き GET で画像表示用 Blob を返し、download は開始しない', async () => {
    const api = await loadApi()

    const blob = await api.fetchAttachmentBlob('f1', 'r1', 'docs', 1)

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe(`${BASE}/api/forms-advanced/f1/rows/r1/files/docs/1`)
    expect(captured[0].credentials).toBe('include')
    expect(await blob.text()).toBe('file-bytes')
    expect(downloadBlobMock).not.toHaveBeenCalled()
  })

  test('認証付き GET で対象 index を取得し元ファイル名で保存する', async () => {
    const api = await loadApi()
    await api.downloadAttachment('f1', 'r1', 'docs', 2, '見積書.pdf')

    expect(captured).toHaveLength(1)
    expect(captured[0].url).toBe(`${BASE}/api/forms-advanced/f1/rows/r1/files/docs/2`)
    expect(captured[0].credentials).toBe('include')
    expect(downloadBlobMock).toHaveBeenCalledTimes(1)
    expect(downloadBlobMock.mock.calls[0][1]).toBe('見積書.pdf')
  })

  test('非 2xx は worker のエラーを投げ downloadBlob を呼ばない', async () => {
    const api = await loadApi()
    nextResponse = { ok: false, status: 404, error: 'ファイルが見つかりません' }

    await expect(api.downloadAttachment('f1', 'r1', 'docs', 0, 'a.pdf'))
      .rejects.toThrow('ファイルが見つかりません')
    expect(downloadBlobMock).not.toHaveBeenCalled()
  })
})
