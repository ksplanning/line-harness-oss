import { beforeEach, describe, expect, test, vi } from 'vitest'

const fetchApiMock = vi.hoisted(() => vi.fn())
vi.mock('./api', () => ({ fetchApi: (...args: unknown[]) => fetchApiMock(...args) }))

import { formalooChoiceListsApi } from './formaloo-choice-lists-api'

beforeEach(() => fetchApiMock.mockReset())

describe('formalooChoiceListsApi', () => {
  test('form scoped collection を読む', async () => {
    fetchApiMock.mockResolvedValue({ success: true, data: [] })

    await expect(formalooChoiceListsApi.list('form/A')).resolves.toEqual([])
    expect(fetchApiMock).toHaveBeenCalledWith('/api/forms-advanced/form%2FA/choice-lists')
  })

  test('create/update/delete は name と {label,value}[] だけを管理 API へ渡す', async () => {
    const items = [{ label: '渋谷店', value: 'shibuya' }]
    fetchApiMock
      .mockResolvedValueOnce({ success: true, data: { id: 'fcl_1', name: '店舗', items, sourceUrl: 'https://worker.test/formaloo/choices/form/fcl_1' } })
      .mockResolvedValueOnce({ success: true, data: { id: 'fcl_1', name: '予約店舗', items, sourceUrl: 'https://worker.test/formaloo/choices/form/fcl_1' } })
      .mockResolvedValueOnce({ success: true, data: null })

    await formalooChoiceListsApi.create('form', { name: '店舗', items })
    expect(fetchApiMock).toHaveBeenNthCalledWith(1, '/api/forms-advanced/form/choice-lists', {
      method: 'POST',
      body: JSON.stringify({ name: '店舗', items }),
    })

    await formalooChoiceListsApi.update('form', 'fcl/1', { name: '予約店舗', items })
    expect(fetchApiMock).toHaveBeenNthCalledWith(2, '/api/forms-advanced/form/choice-lists/fcl%2F1', {
      method: 'PATCH',
      body: JSON.stringify({ name: '予約店舗', items }),
    })

    await expect(formalooChoiceListsApi.remove('form', 'fcl/1')).resolves.toBeUndefined()
    expect(fetchApiMock).toHaveBeenNthCalledWith(3, '/api/forms-advanced/form/choice-lists/fcl%2F1', {
      method: 'DELETE',
    })
  })
})
