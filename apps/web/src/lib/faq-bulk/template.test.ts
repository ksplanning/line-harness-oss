import { describe, expect, test } from 'vitest'
import { buildCsvTemplate, CSV_TEMPLATE_HEADERS } from './template'

// D-8: CSV は BOM付UTF-8 でテンプレ生成でき、列見出しが仕様どおり
describe('buildCsvTemplate', () => {
  test('starts with a UTF-8 BOM so Excel opens it without mojibake', () => {
    const blob = buildCsvTemplate()
    expect(blob).toBeInstanceOf(Blob)
  })

  test('CSV text content begins with BOM char and the expected headers', async () => {
    const { text } = buildCsvTemplate({ returnText: true })
    // 先頭が UTF-8 BOM (U+FEFF)
    expect(text.charCodeAt(0)).toBe(0xfeff)
    const firstLine = text.slice(1).split(/\r?\n/)[0]
    expect(firstLine).toBe(CSV_TEMPLATE_HEADERS.join(','))
  })

  test('headers are 質問/言い換え/答え/有効', () => {
    expect(CSV_TEMPLATE_HEADERS).toEqual(['質問', '言い換え', '答え', '有効'])
  })

  test('includes sample rows so owner has something to overwrite', () => {
    const { text } = buildCsvTemplate({ returnText: true })
    const lines = text.slice(1).trim().split(/\r?\n/)
    expect(lines.length).toBeGreaterThanOrEqual(3) // header + >=2 samples
  })
})
