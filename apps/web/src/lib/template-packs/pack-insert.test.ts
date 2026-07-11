/**
 * template-packs/pack-insert.ts の純ロジック検証 (挿入 patch 変換・ラベル・空パック判定)。
 * 送信は関与しない (form state 反映のみ)。
 */
import { describe, test, expect } from 'vitest'
import { itemToFormPatch, packOptionLabel, isInsertablePack, packToFormMessages, packFitsRemaining } from './pack-insert'

describe('itemToFormPatch', () => {
  test('text bubble → text form patch', () => {
    expect(itemToFormPatch({ message_type: 'text', message_content: 'こんにちは' })).toEqual({
      messageType: 'text',
      messageContent: 'こんにちは',
    })
  })
  test('flex bubble → flex form patch (content preserved verbatim)', () => {
    const flex = '{"type":"bubble"}'
    expect(itemToFormPatch({ message_type: 'flex', message_content: flex })).toEqual({
      messageType: 'flex',
      messageContent: flex,
    })
  })
})

describe('packOptionLabel', () => {
  test('formats name with item count', () => {
    expect(packOptionLabel('初回あいさつ', 3)).toBe('初回あいさつ（3吹き出し）')
  })
})

describe('isInsertablePack', () => {
  test('true when >=1 item, false when empty', () => {
    expect(isInsertablePack(1)).toBe(true)
    expect(isInsertablePack(0)).toBe(false)
  })
})

describe('packToFormMessages', () => {
  test('maps every bubble to a form patch in the same order (no truncation)', () => {
    const items = [
      { message_type: 'text' as const, message_content: 'あいさつ' },
      { message_type: 'flex' as const, message_content: '{"type":"bubble"}' },
      { message_type: 'text' as const, message_content: '締め' },
    ]
    expect(packToFormMessages(items)).toEqual([
      { messageType: 'text', messageContent: 'あいさつ' },
      { messageType: 'flex', messageContent: '{"type":"bubble"}' },
      { messageType: 'text', messageContent: '締め' },
    ])
  })
  test('empty pack → empty patch array', () => {
    expect(packToFormMessages([])).toEqual([])
  })
})

describe('packFitsRemaining', () => {
  test('true when the whole pack fits the remaining slots (fail-loud capacity check, no silent truncation)', () => {
    expect(packFitsRemaining(3, 5)).toBe(true)
    expect(packFitsRemaining(3, 3)).toBe(true)
    expect(packFitsRemaining(3, 2)).toBe(false)
    expect(packFitsRemaining(3, 0)).toBe(false)
  })
})
