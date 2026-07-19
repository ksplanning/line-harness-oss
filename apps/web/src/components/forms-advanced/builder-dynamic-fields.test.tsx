// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { HarnessField } from '@line-crm/shared'

const choiceListsApi = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}))
vi.mock('@/lib/formaloo-choice-lists-api', () => ({ formalooChoiceListsApi: choiceListsApi }))

import FormBuilder from './builder'

afterEach(() => cleanup())
beforeEach(() => {
  choiceListsApi.list.mockReset().mockResolvedValue([])
  choiceListsApi.create.mockReset()
  choiceListsApi.update.mockReset()
  choiceListsApi.remove.mockReset()
})

function field(type: HarnessField['type'], id: string, label: string, config: HarnessField['config'] = {}): HarnessField {
  return { id, type, label, required: false, position: 0, config }
}

function base(overrides: Record<string, unknown> = {}) {
  return {
    formId: 'form_1',
    formTitle: '見積り',
    status: 'draft' as const,
    initialFields: [] as HarnessField[],
    initialLogic: [],
    onSave: vi.fn(),
    ...overrides,
  }
}

describe('variable field builder', () => {
  test('palette から追加した計算は int 既定で、実測済み 4 sub_type を選べる', () => {
    const onSave = vi.fn()
    render(<FormBuilder {...base({ onSave })} />)

    fireEvent.click(screen.getByLabelText('計算を追加'))
    const subtype = screen.getByLabelText('計算の種類') as HTMLSelectElement
    expect(Array.from(subtype.options).map((option) => option.value)).toEqual(['int', 'string', 'decimal', 'formula'])
    expect(subtype.value).toBe('int')

    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields[0]).toMatchObject({ type: 'variable', required: false, config: { variableSubType: 'int' } })
  })

  test('formula editor は他 field の internal id 参照を {id} で挿入し、小数桁も保持する', () => {
    const onSave = vi.fn()
    const fields = [
      field('number', 'price_id', '単価'),
      field('number', 'quantity_id', '数量'),
      field('variable', 'total_id', '合計', { variableSubType: 'formula', formula: '' }),
    ]
    render(<FormBuilder {...base({ initialFields: fields, onSave })} />)

    const totalCardLabel = within(screen.getByTestId('canvas')).getByText('合計')
    fireEvent.click(totalCardLabel.closest('button')!)
    fireEvent.click(screen.getByLabelText('単価を式に挿入'))
    fireEvent.change(screen.getByLabelText('計算式'), { target: { value: '{price_id}*' } })
    fireEvent.click(screen.getByLabelText('数量を式に挿入'))
    fireEvent.change(screen.getByLabelText('小数点以下の桁数'), { target: { value: '2' } })
    fireEvent.click(screen.getByText('保存'))

    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields.find((item) => item.id === 'total_id')?.config).toMatchObject({
      variableSubType: 'formula',
      formula: '{price_id}*{quantity_id}',
      decimalPlaces: 2,
    })
  })
})

describe('choice_fetch list manager', () => {
  test('既存リストを選ぶと sourceUrl と現在値を field config へ自動設定する', async () => {
    const list = {
      id: 'fcl_1', name: '店舗', sourceUrl: 'https://worker.test/formaloo/choices/form_1/fcl_1',
      items: [{ label: '渋谷店', value: 'shibuya' }],
    }
    choiceListsApi.list.mockResolvedValue([list])
    const onSave = vi.fn()
    render(<FormBuilder {...base({
      initialFields: [field('choice_fetch', 'store_id', '予約店舗')],
      onSave,
    })} />)

    const selector = await screen.findByLabelText('選択肢リスト')
    fireEvent.change(selector, { target: { value: 'fcl_1' } })
    fireEvent.click(screen.getByText('保存'))

    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields[0].config).toMatchObject({
      choiceListId: 'fcl_1',
      choicesSource: list.sourceUrl,
      choiceFetchItems: list.items,
    })
  })

  test('form scoped list を作成・更新・削除できる', async () => {
    const created = {
      id: 'fcl_new', name: '店舗', sourceUrl: 'https://worker.test/formaloo/choices/form_1/fcl_new', items: [],
    }
    const updated = {
      ...created,
      name: '予約店舗',
      items: [{ label: '横浜店', value: 'yokohama' }],
    }
    choiceListsApi.create.mockResolvedValue(created)
    choiceListsApi.update.mockResolvedValue(updated)
    choiceListsApi.remove.mockResolvedValue(undefined)
    render(<FormBuilder {...base({ initialFields: [field('choice_fetch', 'store_id', '予約店舗')] })} />)

    await screen.findByLabelText('新しいリスト名')
    await waitFor(() => expect((screen.getByLabelText('選択肢リスト') as HTMLSelectElement).disabled).toBe(false))
    fireEvent.change(screen.getByLabelText('新しいリスト名'), { target: { value: '店舗' } })
    fireEvent.click(screen.getByRole('button', { name: 'リストを作成' }))
    await waitFor(() => expect(choiceListsApi.create).toHaveBeenCalledWith('form_1', { name: '店舗', items: [] }))

    fireEvent.change(screen.getByLabelText('リスト名'), { target: { value: '予約店舗' } })
    fireEvent.click(screen.getByRole('button', { name: '選択肢を追加' }))
    const item = screen.getByTestId('choice-list-item-0')
    fireEvent.change(within(item).getByLabelText('表示名'), { target: { value: '横浜店' } })
    fireEvent.change(within(item).getByLabelText('値'), { target: { value: 'yokohama' } })
    fireEvent.click(screen.getByRole('button', { name: 'リストを保存' }))
    await waitFor(() => expect(choiceListsApi.update).toHaveBeenCalledWith('form_1', 'fcl_new', {
      name: '予約店舗', items: [{ label: '横浜店', value: 'yokohama' }],
    }))

    fireEvent.click(screen.getByRole('button', { name: 'リストを削除' }))
    await waitFor(() => expect(choiceListsApi.remove).toHaveBeenCalledWith('form_1', 'fcl_new'))
    expect((screen.getByLabelText('選択肢リスト') as HTMLSelectElement).value).toBe('')
  })

  test('pull 由来の choicesSource だけでも URL 一致の管理リスト id と現在値を復元する', async () => {
    const list = {
      id: 'fcl_pulled', name: '予約枠', sourceUrl: 'https://worker.test/formaloo/choices/form_1/fcl_pulled',
      items: [{ label: '10:00', value: '10' }],
    }
    choiceListsApi.list.mockResolvedValue([list])
    const onSave = vi.fn()
    render(<FormBuilder {...base({
      initialFields: [field('choice_fetch', 'slot_id', '予約枠', { choicesSource: list.sourceUrl })],
      onSave,
    })} />)

    await waitFor(() => expect((screen.getByLabelText('選択肢リスト') as HTMLSelectElement).value).toBe('fcl_pulled'))
    fireEvent.click(screen.getByText('保存'))

    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields[0].config).toMatchObject({
      choiceListId: 'fcl_pulled',
      choicesSource: list.sourceUrl,
      choiceFetchItems: list.items,
    })
  })

  test('共有リストの更新・削除を同じ choiceListId の全 field へ反映する', async () => {
    const sourceUrl = 'https://worker.test/formaloo/choices/form_1/fcl_shared'
    const original = {
      id: 'fcl_shared', name: '店舗', sourceUrl,
      items: [{ label: '渋谷店', value: 'shibuya' }],
    }
    const updated = {
      ...original,
      items: [{ label: '新宿店', value: 'shinjuku' }],
    }
    choiceListsApi.list.mockResolvedValue([original])
    choiceListsApi.update.mockResolvedValue(updated)
    choiceListsApi.remove.mockResolvedValue(undefined)
    const onSave = vi.fn()
    const sharedConfig = { choiceListId: original.id, choicesSource: sourceUrl, choiceFetchItems: original.items }
    render(<FormBuilder {...base({
      initialFields: [
        field('choice_fetch', 'store_1', '店舗第1希望', sharedConfig),
        field('choice_fetch', 'store_2', '店舗第2希望', sharedConfig),
      ],
      onSave,
    })} />)

    await screen.findByLabelText('リスト名')
    const item = screen.getByTestId('choice-list-item-0')
    fireEvent.change(within(item).getByLabelText('表示名'), { target: { value: '新宿店' } })
    fireEvent.change(within(item).getByLabelText('値'), { target: { value: 'shinjuku' } })
    fireEvent.click(screen.getByRole('button', { name: 'リストを保存' }))
    await waitFor(() => expect(choiceListsApi.update).toHaveBeenCalled())

    fireEvent.click(screen.getByText('保存'))
    const afterUpdate = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    for (const savedField of afterUpdate.fields) {
      expect(savedField.config).toMatchObject({ choiceListId: 'fcl_shared', choicesSource: sourceUrl, choiceFetchItems: updated.items })
    }

    fireEvent.click(screen.getByRole('button', { name: 'リストを削除' }))
    await waitFor(() => expect(choiceListsApi.remove).toHaveBeenCalledWith('form_1', 'fcl_shared'))
    fireEvent.click(screen.getByText('保存'))
    const afterDelete = onSave.mock.calls[1][0] as { fields: HarnessField[] }
    for (const savedField of afterDelete.fields) {
      expect(savedField.config.choiceListId).toBeUndefined()
      expect(savedField.config.choicesSource).toBeUndefined()
      expect(savedField.config.choiceFetchItems).toBeUndefined()
    }
  })

  test('同じ field id の再取り込みで choiceListId が消えても choicesSource から再接続する', async () => {
    const list = {
      id: 'fcl_reimport', name: '予約枠', sourceUrl: 'https://worker.test/formaloo/choices/form_1/fcl_reimport',
      items: [{ label: '11:00', value: '11' }],
    }
    choiceListsApi.list.mockResolvedValue([list])
    const onSave = vi.fn()
    const onReimport = vi.fn().mockResolvedValue({
      ok: true,
      fields: [field('choice_fetch', 'slot_id', '予約枠', { choicesSource: list.sourceUrl })],
      logic: [],
      note: '再取込み',
    })
    render(<FormBuilder {...base({
      initialFields: [field('choice_fetch', 'slot_id', '予約枠', {
        choiceListId: list.id,
        choicesSource: list.sourceUrl,
        choiceFetchItems: [{ label: '古い枠', value: 'old' }],
      })],
      onSave,
      onReimport,
    })} />)

    await waitFor(() => expect((screen.getByLabelText('選択肢リスト') as HTMLSelectElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Formaloo から再取り込み' }))
    fireEvent.click(screen.getByRole('button', { name: 'はい' }))
    await waitFor(() => expect(onReimport).toHaveBeenCalled())
    await waitFor(() => expect((screen.getByLabelText('選択肢リスト') as HTMLSelectElement).value).toBe('fcl_reimport'))

    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields[0].config).toMatchObject({
      choiceListId: 'fcl_reimport', choicesSource: list.sourceUrl, choiceFetchItems: list.items,
    })
  })

  test('source URL だけの複数 field も同じ管理リストへ一括復元する', async () => {
    const list = {
      id: 'fcl_shared_pull', name: 'メニュー', sourceUrl: 'https://worker.test/formaloo/choices/form_1/fcl_shared_pull',
      items: [{ label: 'ランチ', value: 'lunch' }],
    }
    choiceListsApi.list.mockResolvedValue([list])
    const onSave = vi.fn()
    render(<FormBuilder {...base({
      initialFields: [
        field('choice_fetch', 'menu_1', '第1希望', { choicesSource: list.sourceUrl }),
        field('choice_fetch', 'menu_2', '第2希望', { choicesSource: list.sourceUrl }),
      ],
      onSave,
    })} />)

    await waitFor(() => expect((screen.getByLabelText('選択肢リスト') as HTMLSelectElement).value).toBe(list.id))
    fireEvent.click(screen.getByText('保存'))
    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    for (const savedField of saved.fields) {
      expect(savedField.config).toMatchObject({
        choiceListId: list.id, choicesSource: list.sourceUrl, choiceFetchItems: list.items,
      })
    }
  })

  test('一覧応答を待つ間のラベル編集を古い field snapshot で戻さない', async () => {
    const list = {
      id: 'fcl_deferred', name: '店舗', sourceUrl: 'https://worker.test/formaloo/choices/form_1/fcl_deferred',
      items: [{ label: '渋谷店', value: 'shibuya' }],
    }
    let resolveList!: (lists: typeof list[]) => void
    choiceListsApi.list.mockReturnValue(new Promise((resolve) => { resolveList = resolve }))
    const onSave = vi.fn()
    render(<FormBuilder {...base({
      initialFields: [field('choice_fetch', 'store_id', '古いラベル', { choicesSource: list.sourceUrl })],
      onSave,
    })} />)

    fireEvent.change(screen.getByLabelText('ラベル'), { target: { value: '編集後のラベル' } })
    await act(async () => resolveList([list]))
    await waitFor(() => expect((screen.getByLabelText('選択肢リスト') as HTMLSelectElement).value).toBe(list.id))
    fireEvent.click(screen.getByText('保存'))

    const saved = onSave.mock.calls[0][0] as { fields: HarnessField[] }
    expect(saved.fields[0].label).toBe('編集後のラベル')
    expect(saved.fields[0].config.choiceListId).toBe(list.id)
  })
})
