import { describe, expect, test } from 'vitest'
import { parsePastedText } from './text'

// D-3: テキスト貼り付けが Q:/A: 形式 (半角/全角コロン・複数行答え) と TSV を判定して行配列にする
describe('parsePastedText — Q&A mode', () => {
  test('parses half-width "Q:" / "A:" pairs', () => {
    const r = parsePastedText('Q: 営業時間は？\nA: 平日10時〜19時です。')
    expect(r.mode).toBe('qa')
    expect(r.rows).toEqual([{ question: '営業時間は？', answer: '平日10時〜19時です。' }])
  })

  test('parses full-width colon "Q：" / "A："', () => {
    const r = parsePastedText('Q：駐車場は？\nA：裏に3台あります。')
    expect(r.mode).toBe('qa')
    expect(r.rows).toEqual([{ question: '駐車場は？', answer: '裏に3台あります。' }])
  })

  test('captures multi-line answers (A: up to next Q:)', () => {
    const text = 'Q: 時間は？\nA: 平日10時\n土日11時\n\nQ: 場所は？\nA: 駅前です'
    const r = parsePastedText(text)
    expect(r.mode).toBe('qa')
    expect(r.rows).toEqual([
      { question: '時間は？', answer: '平日10時\n土日11時' },
      { question: '場所は？', answer: '駅前です' },
    ])
  })

  test('accepts "質問:" / "答え:" as aliases', () => {
    const r = parsePastedText('質問: 時間は？\n答え: 10時です')
    expect(r.mode).toBe('qa')
    expect(r.rows).toEqual([{ question: '時間は？', answer: '10時です' }])
  })
})

describe('parsePastedText — TSV mode', () => {
  test('detects tab-separated rows and returns a grid', () => {
    const r = parsePastedText('質問\t答え\n営業時間は？\t10時です')
    expect(r.mode).toBe('tsv')
    expect(r.grid).toEqual([
      ['質問', '答え'],
      ['営業時間は？', '10時です'],
    ])
  })

  test('TSV with multiple columns preserved', () => {
    const r = parsePastedText('質問\t言い換え\t答え\n時間？\t何時\t10時')
    expect(r.mode).toBe('tsv')
    expect(r.grid?.[1]).toEqual(['時間？', '何時', '10時'])
  })
})

describe('parsePastedText — ambiguity', () => {
  test('empty text yields empty result', () => {
    const r = parsePastedText('   \n  ')
    expect(r.rows ?? []).toEqual([])
    expect(r.grid ?? []).toEqual([])
  })

  test('text with tabs on majority of rows chooses tsv over qa', () => {
    const r = parsePastedText('a\tb\nc\td\ne\tf')
    expect(r.mode).toBe('tsv')
  })
})
