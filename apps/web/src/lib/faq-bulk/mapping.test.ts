import { describe, expect, test } from 'vitest'
import { autoDetectColumns, isMappingComplete, applyMapping } from './mapping'

// D-5: 見出し自動推定が日本語/英語/表記ゆれを論理列に割当て、質問・答え未割当なら保存不可
describe('autoDetectColumns', () => {
  test('detects Japanese headers 質問/言い換え/答え/有効', () => {
    const m = autoDetectColumns(['質問', '言い換え', '答え', '有効'])
    expect(m).toEqual({ question: 0, variants: 1, answer: 2, isActive: 3 })
  })

  test('detects English headers question/variants/answer/active', () => {
    const m = autoDetectColumns(['question', 'variants', 'answer', 'active'])
    expect(m).toEqual({ question: 0, variants: 1, answer: 2, isActive: 3 })
  })

  test('detects short forms Q / A', () => {
    const m = autoDetectColumns(['Q', 'A'])
    expect(m.question).toBe(0)
    expect(m.answer).toBe(1)
  })

  test('tolerates case and surrounding whitespace', () => {
    const m = autoDetectColumns([' Question ', 'ANSWER'])
    expect(m.question).toBe(0)
    expect(m.answer).toBe(1)
  })

  test('recognizes 回答 as answer and 別の言い方 as variants', () => {
    const m = autoDetectColumns(['お客さまの質問', '別の言い方', '回答'])
    expect(m).toEqual({ question: 0, variants: 1, answer: 2, isActive: null })
  })

  test('leaves unknown headers unmapped (null)', () => {
    const m = autoDetectColumns(['備考', 'メモ'])
    expect(m).toEqual({ question: null, variants: null, answer: null, isActive: null })
  })

  test('does not map two headers to the same logical column (first wins)', () => {
    const m = autoDetectColumns(['質問', 'question'])
    expect(m.question).toBe(0)
  })
})

describe('isMappingComplete', () => {
  test('requires both question and answer to be mapped', () => {
    expect(isMappingComplete({ question: 0, variants: null, answer: 1, isActive: null })).toBe(true)
    expect(isMappingComplete({ question: 0, variants: null, answer: null, isActive: null })).toBe(false)
    expect(isMappingComplete({ question: null, variants: null, answer: 1, isActive: null })).toBe(false)
  })
})

// D-5: applyMapping が行を FAQ 候補へ変換 (variants 分割 / isActive 解釈)
describe('applyMapping', () => {
  const mapping = { question: 0, variants: 1, answer: 2, isActive: 3 }

  test('maps header+data grid to MappedRow[] (header skipped)', () => {
    const grid = [
      ['質問', '言い換え', '答え', '有効'],
      ['営業時間は？', '何時から,開店', '10時です', '有効'],
    ]
    const rows = applyMapping(grid, mapping, { hasHeader: true })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      sourceLine: 1,
      question: '営業時間は？',
      variants: ['何時から', '開店'],
      answer: '10時です',
      isActive: true,
    })
  })

  test('splits variants on comma / semicolon / fullwidth pipe / ideographic comma', () => {
    const grid = [['q', 'v', 'a'], ['質問', 'A;B｜C、D', '答え']]
    const rows = applyMapping(grid, { question: 0, variants: 1, answer: 2, isActive: null }, { hasHeader: true })
    expect(rows[0].variants).toEqual(['A', 'B', 'C', 'D'])
  })

  test('interprets isActive tokens: 有効/1/true/ON = true, 無効/0/false/OFF = false, empty = null', () => {
    const grid = [
      ['q', 'a', 'active'],
      ['q1', 'a1', '無効'],
      ['q2', 'a2', 'ON'],
      ['q3', 'a3', ''],
    ]
    const rows = applyMapping(grid, { question: 0, variants: null, answer: 1, isActive: 2 }, { hasHeader: true })
    expect(rows[0].isActive).toBe(false)
    expect(rows[1].isActive).toBe(true)
    expect(rows[2].isActive).toBeNull()
  })

  test('treats missing variants column as empty array', () => {
    const grid = [['q', 'a'], ['質問', '答え']]
    const rows = applyMapping(grid, { question: 0, variants: null, answer: 1, isActive: null }, { hasHeader: true })
    expect(rows[0].variants).toEqual([])
  })

  test('supports headerless grids (hasHeader: false)', () => {
    const grid = [['質問', '答え']]
    const rows = applyMapping(grid, { question: 0, variants: null, answer: 1, isActive: null }, { hasHeader: false })
    expect(rows).toHaveLength(1)
    expect(rows[0].sourceLine).toBe(1)
  })
})
