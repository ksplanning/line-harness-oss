import { describe, expect, test } from 'vitest'
import { decodeCsvBuffer, EncodingDetectionError } from './encoding'

// '日本語' encodings
const UTF8 = new TextEncoder().encode('日本語') // e6 97 a5 e6 9c ac e8 aa 9e
const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf, ...UTF8])
// Shift_JIS bytes for 日本語: 93 fa 96 7b 8c ea
const SJIS = new Uint8Array([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea])

// D-1: UTF-8(BOM有無) と Shift_JIS を正しくデコードし、判別不能は例外で止める (黙って化けさせない)
describe('decodeCsvBuffer', () => {
  test('decodes UTF-8 without BOM', () => {
    const r = decodeCsvBuffer(UTF8)
    expect(r.text).toBe('日本語')
    expect(r.encoding).toBe('utf-8')
  })

  test('decodes UTF-8 with BOM and strips the BOM from text', () => {
    const r = decodeCsvBuffer(UTF8_BOM)
    expect(r.text).toBe('日本語')
    expect(r.text.charCodeAt(0)).not.toBe(0xfeff) // BOM removed
    expect(r.encoding).toBe('utf-8')
  })

  test('decodes Shift_JIS (Japanese Excel CSV) without mojibake', () => {
    const r = decodeCsvBuffer(SJIS)
    expect(r.text).toBe('日本語')
    expect(r.encoding).toBe('shift_jis')
  })

  test('throws EncodingDetectionError on bytes that are neither valid UTF-8 nor Shift_JIS', () => {
    // 0xff 0xfe 0xff is invalid as both UTF-8 (fatal) and Shift_JIS lead bytes
    const garbage = new Uint8Array([0xff, 0xfe, 0xff, 0xfe])
    expect(() => decodeCsvBuffer(garbage)).toThrow(EncodingDetectionError)
  })

  test('empty buffer decodes to empty string (utf-8)', () => {
    const r = decodeCsvBuffer(new Uint8Array([]))
    expect(r.text).toBe('')
  })

  test('accepts ArrayBuffer input as well as Uint8Array', () => {
    const r = decodeCsvBuffer(UTF8.buffer.slice(0))
    expect(r.text).toBe('日本語')
  })
})
