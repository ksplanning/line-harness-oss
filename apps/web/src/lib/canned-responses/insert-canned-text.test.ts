/**
 * G23 C6 — 挿入 helper の純関数性 + 送信経路との物理分離 (failure_observable 筆頭)。
 *
 *   - insertCannedText: 空 composer→insert / 既存文字→改行区切りで末尾追記 (純関数・副作用なし)
 *   - applyCannedSelection: setContent 相当のみを更新し api.chats.send を 1 度も呼ばない (spy 0 回)
 */
import { describe, test, expect, beforeAll, vi } from 'vitest'
import { insertCannedText, applyCannedSelection } from './insert-canned-text'

// api.ts はモジュール読込時に NEXT_PUBLIC_API_URL を要求する。dynamic import 前に set。
beforeAll(() => {
  process.env.NEXT_PUBLIC_API_URL = 'https://worker.example.test'
})

describe('insertCannedText', () => {
  test('空 composer には本文をそのまま入れる', () => {
    expect(insertCannedText('', 'こんにちは')).toBe('こんにちは')
  })

  test('既存文字があれば改行を 1 つ挟んで末尾追記する', () => {
    expect(insertCannedText('お世話になります', '定型文')).toBe('お世話になります\n定型文')
  })

  test('既存文字が改行で終わっていれば余計な改行を足さない', () => {
    expect(insertCannedText('一行目\n', '二行目')).toBe('一行目\n二行目')
  })

  test('純関数: 入力を破壊しない', () => {
    const current = 'a'
    insertCannedText(current, 'b')
    expect(current).toBe('a')
  })
})

describe('applyCannedSelection (送信経路と物理分離)', () => {
  test('setContent 相当のみを更新し、api.chats.send を 1 度も呼ばない (spy 0 回)', async () => {
    const { api } = await import('../api')
    const sendSpy = vi.spyOn(api.chats, 'send')
    const setContent = vi.fn()

    applyCannedSelection('定型文の本文', setContent)

    // setContent は updater 関数で 1 回だけ呼ばれる。
    expect(setContent).toHaveBeenCalledTimes(1)
    const updater = setContent.mock.calls[0][0] as (prev: string) => string
    expect(updater('既存の下書き')).toBe('既存の下書き\n定型文の本文')
    expect(updater('')).toBe('定型文の本文')

    // 送信 API は絶対に発火しない。
    expect(sendSpy).not.toHaveBeenCalled()
    sendSpy.mockRestore()
  })
})
