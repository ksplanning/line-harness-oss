/**
 * template-packs/pack-insert.ts の純ロジック検証 (挿入 patch 変換・ラベル・空パック判定)。
 * 送信は関与しない (form state 反映のみ)。
 */
import { describe, test, expect } from 'vitest'
import { itemToFormPatch, packOptionLabel, isInsertablePack } from './pack-insert'

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
