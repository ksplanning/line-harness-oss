/**
 * T-B3 (F6-2 / web api client) — 表示スコープ + 作成先 workspace の URL/payload 契約。
 *   - list(accountId) が ?lineAccountId=<enc> を付ける / 無引数は従来 URL。
 *   - create が lineAccountId/workspaceId を body に載せる。
 *   - account_binding api list/set/clear が正しい method/URL/body を叩く。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchApi = vi.fn()
vi.mock('./api', () => ({
  fetchApi: (...a: unknown[]) => fetchApi(...a),
  downloadCsv: vi.fn(),
}))

import { formsAdvancedApi } from './formaloo-advanced-api'
import { formalooAccountBindingsApi } from './formaloo-account-bindings-api'

beforeEach(() => {
  fetchApi.mockReset()
  fetchApi.mockResolvedValue({ success: true, data: [] })
})

describe('formsAdvancedApi.list — 表示スコープ URL', () => {
  it('accountId を渡すと ?lineAccountId=<enc> を付ける', async () => {
    await formsAdvancedApi.list('acc/A?x')
    expect(fetchApi).toHaveBeenCalledWith(`/api/forms-advanced?lineAccountId=${encodeURIComponent('acc/A?x')}`)
  })
  it('無引数は従来 URL (後方互換)', async () => {
    await formsAdvancedApi.list()
    expect(fetchApi).toHaveBeenCalledWith('/api/forms-advanced')
  })
})

describe('formsAdvancedApi.create — payload', () => {
  it('lineAccountId/workspaceId を body に載せる', async () => {
    fetchApi.mockResolvedValue({ success: true, data: { id: 'fa1' } })
    await formsAdvancedApi.create({ title: 'A社', lineAccountId: 'acc_A', workspaceId: 'fw_1' })
    const [, opts] = fetchApi.mock.calls[0]
    expect((opts as { method: string }).method).toBe('POST')
    expect(JSON.parse((opts as { body: string }).body)).toEqual({ title: 'A社', lineAccountId: 'acc_A', workspaceId: 'fw_1' })
  })
})

describe('formsAdvancedApi.saveDefinition — metadata payload', () => {
  it('title と空 description を PUT body にそのまま載せる', async () => {
    fetchApi.mockResolvedValue({ success: true, data: { id: 'fa1' } })
    await formsAdvancedApi.saveDefinition('fa1', { fields: [], logic: [], title: '新タイトル', description: '' })
    const [url, opts] = fetchApi.mock.calls[0]
    expect(url).toBe('/api/forms-advanced/fa1')
    expect((opts as { method: string }).method).toBe('PUT')
    expect(JSON.parse((opts as { body: string }).body)).toEqual({ fields: [], logic: [], title: '新タイトル', description: '' })
  })
})

describe('formsAdvancedApi.saveInternalDefinition — isolated local endpoint', () => {
  it('PUTs the definition to the encoded internal-only URL', async () => {
    fetchApi.mockResolvedValue({ success: true, data: null })
    const definition = { fields: [], logic: [], title: '自前フォーム', description: '' }

    await formsAdvancedApi.saveInternalDefinition('fa/a', definition)

    const [url, opts] = fetchApi.mock.calls[0]
    expect(url).toBe('/api/forms-advanced/fa%2Fa/internal-definition')
    expect((opts as { method: string }).method).toBe('PUT')
    expect(JSON.parse((opts as { body: string }).body)).toEqual(definition)
  })
})

describe('formsAdvancedApi render backend — separate additive endpoint', () => {
  it('GET reads the backend without changing the existing form response', async () => {
    fetchApi.mockResolvedValue({ success: true, data: { renderBackend: 'internal' } })
    await expect(formsAdvancedApi.getRenderBackend('fa/a')).resolves.toBe('internal')
    expect(fetchApi).toHaveBeenCalledWith(`/api/forms-advanced/${encodeURIComponent('fa/a')}/render-backend`)
  })

  it('PATCH sends only the selected backend', async () => {
    fetchApi.mockResolvedValue({ success: true, data: { renderBackend: 'internal' } })
    await expect(formsAdvancedApi.setRenderBackend('fa1', 'internal')).resolves.toBe('internal')
    const [url, opts] = fetchApi.mock.calls[0]
    expect(url).toBe('/api/forms-advanced/fa1/render-backend')
    expect((opts as { method: string }).method).toBe('PATCH')
    expect(JSON.parse((opts as { body: string }).body)).toEqual({ renderBackend: 'internal' })
  })
})

describe('formalooAccountBindingsApi', () => {
  it('list → GET /api/formaloo-account-bindings', async () => {
    await formalooAccountBindingsApi.list()
    expect(fetchApi).toHaveBeenCalledWith('/api/formaloo-account-bindings')
  })
  it('set → PUT with defaultWorkspaceId body', async () => {
    fetchApi.mockResolvedValue({ success: true, data: null })
    await formalooAccountBindingsApi.set('acc_A', 'fw_1')
    const [url, opts] = fetchApi.mock.calls[0]
    expect(url).toBe('/api/formaloo-account-bindings/acc_A')
    expect((opts as { method: string }).method).toBe('PUT')
    expect(JSON.parse((opts as { body: string }).body)).toEqual({ defaultWorkspaceId: 'fw_1' })
  })
  it('clear → DELETE', async () => {
    fetchApi.mockResolvedValue({ success: true, data: null })
    await formalooAccountBindingsApi.clear('acc_A')
    const [url, opts] = fetchApi.mock.calls[0]
    expect(url).toBe('/api/formaloo-account-bindings/acc_A')
    expect((opts as { method: string }).method).toBe('DELETE')
  })
})
