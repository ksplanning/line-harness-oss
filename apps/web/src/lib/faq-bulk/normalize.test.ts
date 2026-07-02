import { describe, expect, test } from 'vitest'
import { normalizeQuestion } from './normalize'

// D-4 / D-19: question 正規化は重複突合の単一正典。
// trim + 全半角統一 + 大小無視。UI (validate) と Worker (bulk) が同じキーを出すことで
// 「UI では重複・サーバでは新規」による二重登録を防ぐ。
describe('normalizeQuestion', () => {
  test('trims leading/trailing whitespace', () => {
    expect(normalizeQuestion('  営業時間は？  ')).toBe(normalizeQuestion('営業時間は？'))
  })

  test('collapses internal whitespace runs to a single space', () => {
    expect(normalizeQuestion('営業  時間\t は')).toBe(normalizeQuestion('営業 時間 は'))
  })

  test('is case-insensitive for ASCII letters', () => {
    expect(normalizeQuestion('Open Hours')).toBe(normalizeQuestion('open hours'))
  })

  test('unifies full-width ASCII to half-width (letters/digits)', () => {
    // 全角 "ＯＰＥＮ１２３" == 半角 "open123"
    expect(normalizeQuestion('ＯＰＥＮ１２３')).toBe(normalizeQuestion('open123'))
  })

  test('unifies full-width space to half-width', () => {
    expect(normalizeQuestion('営業　時間')).toBe(normalizeQuestion('営業 時間'))
  })

  test('same logical question with mixed width/case/space collapses to one key', () => {
    // 全角スペース+全角OPEN+連続半角スペース+全角？ を、半角小文字の同義入力へ畳む。
    const a = normalizeQuestion('　ＯＰＥＮ  Hours？ ')
    const b = normalizeQuestion('open hours？')
    expect(a).toBe(b)
  })

  test('distinct questions produce distinct keys', () => {
    expect(normalizeQuestion('営業時間は？')).not.toBe(normalizeQuestion('駐車場は？'))
  })

  test('empty / whitespace-only normalizes to empty string', () => {
    expect(normalizeQuestion('   \t 　 ')).toBe('')
    expect(normalizeQuestion('')).toBe('')
  })
})
