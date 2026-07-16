/**
 * form-route-branching (T-D3) — web api client の formType 配線 + save 応答 warnings 搬送。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchApi = vi.fn()
vi.mock('./api', () => ({
  fetchApi: (...a: unknown[]) => fetchApi(...a),
  downloadCsv: vi.fn(),
}))

import { formsAdvancedApi } from './formaloo-advanced-api'

beforeEach(() => {
  fetchApi.mockReset()
  fetchApi.mockResolvedValue({ success: true, data: {} })
})

describe('formsAdvancedApi.saveDefinition — formType 配線', () => {
  it('formType を PUT body にそのまま載せる', async () => {
    await formsAdvancedApi.saveDefinition('f1', { fields: [], logic: [], formType: 'multi_step' })
    const [, opts] = fetchApi.mock.calls[0]
    expect(JSON.parse((opts as { body: string }).body).formType).toBe('multi_step')
  })

  it('envelope top-level の warnings を form.warnings に搬送する (jump+simple backstop)', async () => {
    fetchApi.mockResolvedValue({ success: true, data: { id: 'f1', syncStatus: 'idle' }, warnings: ['ページへ飛ぶ分岐がありますが…'] })
    const form = await formsAdvancedApi.saveDefinition('f1', { fields: [], logic: [] })
    expect(form.warnings).toEqual(['ページへ飛ぶ分岐がありますが…'])
  })

  it('warnings 無しの応答は warnings を付けない (後方互換)', async () => {
    fetchApi.mockResolvedValue({ success: true, data: { id: 'f1', syncStatus: 'idle' } })
    const form = await formsAdvancedApi.saveDefinition('f1', { fields: [], logic: [] })
    expect(form.warnings).toBeUndefined()
  })
})
