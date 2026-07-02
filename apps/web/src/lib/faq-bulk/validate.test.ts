import { describe, expect, test } from 'vitest'
import { validateRows, QUESTION_MAX, ANSWER_MAX, VARIANTS_MAX, VARIANT_LEN_MAX } from './validate'
import type { MappedRow } from './types'

function row(partial: Partial<MappedRow>, line = 1): MappedRow {
  return {
    sourceLine: line,
    question: 'q',
    variants: [],
    answer: 'a',
    isActive: null,
    ...partial,
  }
}

// D-6: 行検証が空欄=エラー/長さ超過/ファイル内重複/既存FAQ重複を分類し行結果を返す
describe('validateRows — per-row classification', () => {
  test('marks a valid row as ok', () => {
    const r = validateRows([row({ question: '営業時間は？', answer: '10時です' })], [])
    expect(r[0].status).toBe('ok')
    expect(r[0].reason).toBe('')
  })

  test('empty question is an error', () => {
    const r = validateRows([row({ question: '   ', answer: '10時です' })], [])
    expect(r[0].status).toBe('error')
    expect(r[0].reason).toContain('質問')
  })

  test('empty answer is an error', () => {
    const r = validateRows([row({ question: '時間？', answer: '' })], [])
    expect(r[0].status).toBe('error')
    expect(r[0].reason).toContain('答え')
  })

  test('question longer than QUESTION_MAX is an error', () => {
    const r = validateRows([row({ question: 'あ'.repeat(QUESTION_MAX + 1), answer: 'a' })], [])
    expect(r[0].status).toBe('error')
    expect(r[0].reason).toContain('質問')
  })

  test('answer longer than ANSWER_MAX is an error', () => {
    const r = validateRows([row({ question: 'q', answer: 'あ'.repeat(ANSWER_MAX + 1) })], [])
    expect(r[0].status).toBe('error')
    expect(r[0].reason).toContain('答え')
  })

  // reviewer R1-H2 (client mirror): variants の件数/要素長を client 側でも弾く (server と同値)。
  test('too many variants is an error (count cap)', () => {
    const many = Array.from({ length: VARIANTS_MAX + 1 }, (_, i) => `v${i}`)
    const r = validateRows([row({ question: 'q', answer: 'a', variants: many })], [])
    expect(r[0].status).toBe('error')
    expect(r[0].reason).toContain('言い換え')
  })

  test('variant element too long is an error (length cap)', () => {
    const r = validateRows([row({ question: 'q', answer: 'a', variants: ['あ'.repeat(VARIANT_LEN_MAX + 1)] })], [])
    expect(r[0].status).toBe('error')
    expect(r[0].reason).toContain('言い換え')
  })

  test('within-limit variants stay ok', () => {
    const r = validateRows([row({ question: 'q', answer: 'a', variants: ['何時から', '開店'] })], [])
    expect(r[0].status).toBe('ok')
  })
})

describe('validateRows — existing FAQ duplicate', () => {
  test('marks a row duplicate when question matches an existing FAQ (normalized)', () => {
    const existing = [{ id: 'faq-1', question: '営業時間は？' }]
    const r = validateRows([row({ question: '　営業時間は？　', answer: '新答え' })], existing)
    expect(r[0].status).toBe('duplicate')
    expect(r[0].existingFaqId).toBe('faq-1')
  })

  test('does not mark duplicate when normalized questions differ', () => {
    const existing = [{ id: 'faq-1', question: '営業時間は？' }]
    const r = validateRows([row({ question: '駐車場は？', answer: 'a' })], existing)
    expect(r[0].status).toBe('ok')
  })
})

// spec §ファイル内重複の確定仕様 (独立レビュー #7): 後勝ちで1件に集約
describe('validateRows — file-internal duplicate (last-wins collapse)', () => {
  test('collapses duplicate questions to the last row; earlier ones become warning (skipped)', () => {
    const rows = [
      row({ question: '時間？', answer: '古い答え' }, 1),
      row({ question: '　時間？　', answer: '新しい答え' }, 2),
    ]
    const r = validateRows(rows, [])
    // 先に現れた行は集約でスキップ (warning)、最後の行が採用 (ok)
    const kept = r.filter((x) => x.status === 'ok')
    const skipped = r.filter((x) => x.status === 'warning')
    expect(kept).toHaveLength(1)
    expect(kept[0].answer).toBe('新しい答え')
    expect(skipped).toHaveLength(1)
    expect(skipped[0].sourceLine).toBe(1)
    expect(skipped[0].reason).toContain('重複')
  })

  test('three duplicates: only the last is ok, first two are warnings', () => {
    const rows = [
      row({ question: 'x', answer: 'a1' }, 1),
      row({ question: 'x', answer: 'a2' }, 2),
      row({ question: 'x', answer: 'a3' }, 3),
    ]
    const r = validateRows(rows, [])
    expect(r.filter((x) => x.status === 'ok').map((x) => x.answer)).toEqual(['a3'])
    expect(r.filter((x) => x.status === 'warning')).toHaveLength(2)
  })

  test('an error row (empty answer) does not participate in dedup collapse', () => {
    const rows = [
      row({ question: 'x', answer: '' }, 1), // error
      row({ question: 'x', answer: 'good' }, 2), // ok
    ]
    const r = validateRows(rows, [])
    expect(r[0].status).toBe('error')
    expect(r[1].status).toBe('ok')
  })
})
