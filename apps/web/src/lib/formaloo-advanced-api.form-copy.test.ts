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

describe('formsAdvancedApi.publish — 自前公開 revision 配線', () => {
  it('revision 指定時だけ確認済み revision を JSON body に載せる', async () => {
    await formsAdvancedApi.publish('f1', 'revision-1')
    expect(fetchApi).toHaveBeenCalledWith('/api/forms-advanced/f1/publish', {
      method: 'POST',
      body: JSON.stringify({ publishRevision: 'revision-1' }),
    })
  })

  it('revision 未指定の既存 Formaloo 公開は body を追加しない', async () => {
    await formsAdvancedApi.publish('f1')
    expect(fetchApi).toHaveBeenCalledWith('/api/forms-advanced/f1/publish', { method: 'POST' })
  })
})

describe('formsAdvancedApi.unpublish — 自前公開世代の配線', () => {
  it('自前配信だけ画面表示時の updatedAt を JSON body に載せる', async () => {
    await formsAdvancedApi.unpublish('f1', 'internal', 'shown-at')
    expect(fetchApi).toHaveBeenCalledWith('/api/forms-advanced/f1/unpublish', {
      method: 'POST',
      headers: { 'X-Form-Render-Backend': 'internal' },
      body: JSON.stringify({ expectedUpdatedAt: 'shown-at' }),
    })
  })

  it('既存 Formaloo 非公開は body を追加しない', async () => {
    await formsAdvancedApi.unpublish('f1', 'formaloo')
    expect(fetchApi).toHaveBeenCalledWith('/api/forms-advanced/f1/unpublish', {
      method: 'POST',
      headers: { 'X-Form-Render-Backend': 'formaloo' },
    })
  })
})
