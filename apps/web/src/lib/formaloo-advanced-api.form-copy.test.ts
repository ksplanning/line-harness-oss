/**
 * form-jp-localization (T-C2) — web api client の formCopy 配線。
 *   builder onSave → handleSave → saveDefinition の PUT body に formCopy がそのまま載る (中継漏れ防止)。
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

describe('formsAdvancedApi.saveDefinition — formCopy 配線 (T-C2)', () => {
  it('formCopy を PUT body にそのまま載せる', async () => {
    await formsAdvancedApi.saveDefinition('f1', {
      fields: [], logic: [],
      formCopy: { buttonText: '送信', successMessage: 'ありがとうございました', errorMessage: '送信に失敗しました' },
    })
    const [, opts] = fetchApi.mock.calls[0]
    expect(JSON.parse((opts as { body: string }).body).formCopy).toEqual({
      buttonText: '送信', successMessage: 'ありがとうございました', errorMessage: '送信に失敗しました',
    })
  })

  it('formCopy 未指定の save は body に formCopy を載せない (absent = 後方互換)', async () => {
    await formsAdvancedApi.saveDefinition('f1', { fields: [], logic: [] })
    const [, opts] = fetchApi.mock.calls[0]
    expect('formCopy' in JSON.parse((opts as { body: string }).body)).toBe(false)
  })
})
