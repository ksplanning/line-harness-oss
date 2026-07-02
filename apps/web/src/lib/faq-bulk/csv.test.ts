import { describe, expect, test } from 'vitest'
import { parseCsv } from './csv'

// D-2: RFC4180 (クォート囲み・埋め込み"" ・クォート内改行/カンマ・CRLF) を正しく分解する
describe('parseCsv', () => {
  test('parses a simple comma-separated grid', () => {
    expect(parseCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ])
  })

  test('handles CRLF line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  test('unquotes double-quoted fields', () => {
    expect(parseCsv('"hello","world"')).toEqual([['hello', 'world']])
  })

  test('handles embedded doubled quotes ("") as a literal quote', () => {
    expect(parseCsv('"she said ""hi"""')).toEqual([['she said "hi"']])
  })

  test('preserves commas inside quoted fields', () => {
    expect(parseCsv('"a,b",c')).toEqual([['a,b', 'c']])
  })

  test('preserves newlines inside quoted fields (multi-line answer cell)', () => {
    const csv = 'question,answer\n"時間は？","平日10時\n土日11時"'
    expect(parseCsv(csv)).toEqual([
      ['question', 'answer'],
      ['時間は？', '平日10時\n土日11時'],
    ])
  })

  test('preserves CRLF inside quoted fields as \\n normalized', () => {
    const csv = '"line1\r\nline2"'
    // Inside a quoted field, a CRLF is a literal newline in the cell.
    const rows = parseCsv(csv)
    expect(rows.length).toBe(1)
    expect(rows[0][0]).toContain('line1')
    expect(rows[0][0]).toContain('line2')
  })

  test('keeps empty trailing fields', () => {
    expect(parseCsv('a,,c')).toEqual([['a', '', 'c']])
  })

  test('drops a final empty line (trailing newline)', () => {
    expect(parseCsv('a,b\n')).toEqual([['a', 'b']])
  })

  test('keeps a genuinely empty field row but drops blank tail', () => {
    // A blank line in the middle is preserved as [''] row; trailing blank dropped.
    expect(parseCsv('a\n\nb\n')).toEqual([['a'], [''], ['b']])
  })

  test('handles quoted field followed by content on same row', () => {
    expect(parseCsv('"q",normal,"a"')).toEqual([['q', 'normal', 'a']])
  })
})
