// @vitest-environment jsdom
/**
 * U3 (broadcast-combo-messages Batch 2) — PackInsertSelector の「パック全体を追加」+ 個別 append。
 *  - 残枠十分: 「パック全体を追加」で onAppend が全吹き出し配列 (順序保持) で呼ばれる
 *  - 残枠不足: 全体追加ボタンは disabled + 不足表示、onAppend は呼ばれない (silent 切り詰めなし)
 *  - 個別「追加」は 1 件 append (置換でなく追加)、残枠 0 で disabled
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const { listMock, getMock } = vi.hoisted(() => ({ listMock: vi.fn(), getMock: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: { templatePacks: { list: (...a: unknown[]) => listMock(...a), get: (...a: unknown[]) => getMock(...a) } },
}))

import PackInsertSelector from './pack-insert-selector'

const PACK = { id: 'p1', name: '初回あいさつ', itemCount: 3 }
const ITEMS = [
  { id: 'i1', message_type: 'text', message_content: 'あいさつ' },
  { id: 'i2', message_type: 'flex', message_content: '{"type":"bubble"}' },
  { id: 'i3', message_type: 'text', message_content: '締め' },
]

beforeEach(() => {
  listMock.mockReset(); getMock.mockReset()
  listMock.mockResolvedValue({ success: true, data: [PACK] })
  getMock.mockResolvedValue({ success: true, data: { items: ITEMS } })
})
afterEach(() => cleanup())

async function renderAndSelectPack(remainingSlots: number, onAppend = vi.fn()) {
  render(<PackInsertSelector accountId="acc-1" remainingSlots={remainingSlots} onAppend={onAppend} />)
  await waitFor(() => expect(screen.getByRole('option', { name: /初回あいさつ/ })).toBeTruthy())
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p1' } })
  await waitFor(() => expect(screen.getByRole('button', { name: /パック全体を追加/ })).toBeTruthy())
  return onAppend
}

describe('PackInsertSelector U3: パック全体を追加 + 個別 append', () => {
  it('残枠5・3吹き出し → 「パック全体を追加」で onAppend が 3件配列 (順序保持) で呼ばれる', async () => {
    const onAppend = await renderAndSelectPack(5)
    fireEvent.click(screen.getByRole('button', { name: /パック全体を追加/ }))
    expect(onAppend).toHaveBeenCalledTimes(1)
    expect(onAppend.mock.calls[0][0]).toEqual([
      { messageType: 'text', messageContent: 'あいさつ' },
      { messageType: 'flex', messageContent: '{"type":"bubble"}' },
      { messageType: 'text', messageContent: '締め' },
    ])
  })

  it('残枠2・3吹き出し → 全体追加は disabled + 不足表示、onAppend は呼ばれない', async () => {
    const onAppend = await renderAndSelectPack(2)
    const wholeBtn = screen.getByRole('button', { name: /パック全体を追加/ }) as HTMLButtonElement
    expect(wholeBtn.disabled).toBe(true)
    expect(screen.getByText(/残り枠が足りません/)).toBeTruthy()
    fireEvent.click(wholeBtn)
    expect(onAppend).not.toHaveBeenCalled()
  })

  it('個別「追加」ボタンは 1件だけ append する (置換でない)', async () => {
    const onAppend = await renderAndSelectPack(5)
    const addBtns = screen.getAllByRole('button', { name: '追加' })
    fireEvent.click(addBtns[1])
    expect(onAppend).toHaveBeenCalledTimes(1)
    expect(onAppend.mock.calls[0][0]).toEqual([{ messageType: 'flex', messageContent: '{"type":"bubble"}' }])
  })

  it('残枠0 → 個別「追加」ボタンは disabled', async () => {
    const onAppend = await renderAndSelectPack(0)
    const addBtns = screen.getAllByRole('button', { name: '追加' }) as HTMLButtonElement[]
    expect(addBtns.every((b) => b.disabled)).toBe(true)
    fireEvent.click(addBtns[0])
    expect(onAppend).not.toHaveBeenCalled()
  })
})
