import { describe, expect, test } from 'vitest'
import { fileAnswerSummary, fileSizeLabel, isFileAnswer } from './file-answer'

describe('isFileAnswer', () => {
  test('{key,name} を持つ object の非空配列を file 回答と判定する', () => {
    expect(isFileAnswer([
      { key: 'internal-form-submissions/f1/docs/u1.pdf', name: '見積書.pdf', size: 1024, type: 'application/pdf' },
    ])).toBe(true)
    expect(isFileAnswer([{ key: 'k', name: 'a.pdf' }])).toBe(true)
  })

  test('scalar・空配列・scalar 配列・shape 欠落は false', () => {
    expect(isFileAnswer('a.pdf')).toBe(false)
    expect(isFileAnswer(null)).toBe(false)
    expect(isFileAnswer(undefined)).toBe(false)
    expect(isFileAnswer([])).toBe(false)
    expect(isFileAnswer(['A', 'B'])).toBe(false)
    expect(isFileAnswer([{ name: 'a.pdf' }])).toBe(false)
    expect(isFileAnswer([{ key: 'k' }])).toBe(false)
    expect(isFileAnswer([{ key: 'k', name: 'a.pdf' }, 'b.pdf'])).toBe(false)
  })
})

describe('fileAnswerSummary', () => {
  test('1 件はファイル名そのまま', () => {
    expect(fileAnswerSummary([{ key: 'k', name: '見積書.pdf' }])).toBe('見積書.pdf')
  })

  test('複数はカンマ列挙', () => {
    expect(fileAnswerSummary([{ key: 'k1', name: 'a.pdf' }, { key: 'k2', name: 'b.png' }])).toBe('a.pdf, b.png')
  })

  test('長い列挙は先頭名+件数へ畳む', () => {
    const files = Array.from({ length: 6 }, (_, i) => ({ key: `k${i}`, name: `とても長いファイル名データ_${i}.pdf` }))
    expect(fileAnswerSummary(files)).toBe('とても長いファイル名データ_0.pdf ほか5件')
  })

  test('name 空のエントリは既定名で表示し [object Object] を出さない', () => {
    const summary = fileAnswerSummary([{ key: 'k', name: '' }])
    expect(summary).toBe('添付ファイル')
    expect(summary).not.toContain('[object Object]')
  })
})

describe('fileSizeLabel', () => {
  test('B / KB / MB を単位切替で出す', () => {
    expect(fileSizeLabel(500)).toBe('500 B')
    expect(fileSizeLabel(2048)).toBe('2.0 KB')
    expect(fileSizeLabel(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})
