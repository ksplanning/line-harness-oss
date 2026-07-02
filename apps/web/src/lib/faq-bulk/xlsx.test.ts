import { describe, expect, test } from 'vitest'
import { buildXlsxTemplateBuffer, parseXlsxBuffer } from './xlsx'

// D-8: Excel は .xlsx でテンプレ生成でき roundtrip(生成→再読込)で列一致・先頭シートのみ・セル値は文字列
describe('xlsx template roundtrip', () => {
  test('buildXlsxTemplateBuffer produces a buffer that parseXlsxBuffer reads back with the 4 headers', async () => {
    const buf = await buildXlsxTemplateBuffer()
    const grid = await parseXlsxBuffer(buf)
    expect(grid[0]).toEqual(['質問', '言い換え', '答え', '有効'])
  })

  test('template contains sample data rows', async () => {
    const buf = await buildXlsxTemplateBuffer()
    const grid = await parseXlsxBuffer(buf)
    expect(grid.length).toBeGreaterThanOrEqual(3)
  })
})

describe('parseXlsxBuffer', () => {
  test('reads only the first sheet when multiple sheets exist', async () => {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['質問', '答え'], ['Q1', 'A1']]), 'First')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['別', 'シート'], ['X', 'Y']]), 'Second')
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer

    const grid = await parseXlsxBuffer(buf)
    expect(grid[0]).toEqual(['質問', '答え'])
    expect(grid[1]).toEqual(['Q1', 'A1'])
    // 2枚目 (別/シート) は取り込まれない
    expect(grid.flat()).not.toContain('別')
  })

  test('coerces numeric/date cells to display strings (raw:false)', async () => {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['質問', '答え'], ['番号', 123]]), 'S')
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer

    const grid = await parseXlsxBuffer(buf)
    // 数値 123 は文字列 '123' として返る
    expect(grid[1][1]).toBe('123')
    expect(typeof grid[1][1]).toBe('string')
  })

  test('returns empty grid for an empty workbook sheet', async () => {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([]), 'Empty')
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    const grid = await parseXlsxBuffer(buf)
    expect(Array.isArray(grid)).toBe(true)
  })
})
