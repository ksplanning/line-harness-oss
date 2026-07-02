/**
 * G35 QR — 純ロジックテスト (T-A6)。
 * QR 画像 URL 組立 (/api/qr?size=...&data=<encoded>) と DL ファイル名生成を固定する。
 */
import { describe, test, expect } from 'vitest'
import { buildQrImageUrl, qrDownloadFilename } from './qr'

describe('buildQrImageUrl', () => {
  test('size=240x240 + data を encodeURIComponent する', () => {
    expect(buildQrImageUrl('https://api.example', 'https://ex.com/r/abc')).toBe(
      'https://api.example/api/qr?size=240x240&data=https%3A%2F%2Fex.com%2Fr%2Fabc',
    )
  })

  test('base が末尾スラッシュでも二重にならない', () => {
    expect(buildQrImageUrl('https://api.example/', 'https://ex.com/r/x')).toBe(
      'https://api.example/api/qr?size=240x240&data=https%3A%2F%2Fex.com%2Fr%2Fx',
    )
  })

  test('日本語やクエリ付き URL も encode', () => {
    const url = 'https://ex.com/r/春?q=1'
    expect(buildQrImageUrl('https://api.example', url)).toBe(
      `https://api.example/api/qr?size=240x240&data=${encodeURIComponent(url)}`,
    )
  })
})

describe('qrDownloadFilename', () => {
  test('英数字・かな・漢字は保持し記号を - に置換 (長音符 ー は範囲外で - になる)', () => {
    // ui-design.md §6 の正規表現 [^a-zA-Z0-9ぁ-んァ-ン一-龯] に忠実。
    // 長音符 ー(U+30FC) は カタカナ範囲 ァ-ン(U+30A1-U+30F3) の外なので - に置換される。
    expect(qrDownloadFilename('春 キャンペーン!')).toBe('qr-春-キャンペ-ン-.png')
  })

  test('全て記号なら qr-.png に落ちる', () => {
    expect(qrDownloadFilename('@@@')).toBe('qr----.png')
  })

  test('ascii 名はそのまま', () => {
    expect(qrDownloadFilename('spring2026')).toBe('qr-spring2026.png')
  })
})
