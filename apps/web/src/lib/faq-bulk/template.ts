/**
 * テンプレート生成 + ダウンロード (spec §テンプレート DL)。
 *
 * CSV は **BOM付き UTF-8** で生成 (Excel で開いても文字化けしない)。
 * Excel テンプレは xlsx.ts の buildXlsxTemplateBlob (動的 import / 同 chunk 再利用)。
 * DL はクライアントで Blob + URL.createObjectURL (サーバ不要 = static export 互換)。
 */

export const CSV_TEMPLATE_HEADERS = ['質問', '言い換え', '答え', '有効'] as const

const CSV_SAMPLE_ROWS: string[][] = [
  ['営業時間は何時からですか？', '何時から,開店時間', '平日は10時〜19時、土日は11時〜18時です。', '有効'],
  ['駐車場はありますか？', '駐車場,車', '店舗の裏に3台分ございます。', '有効'],
]

// RFC4180 に沿った CSV フィールドのエスケープ (カンマ・改行・引用符を含むセルは "" 囲み)。
function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return '"' + value.replace(/"/g, '""') + '"'
  }
  return value
}

function toCsvText(): string {
  const lines = [
    CSV_TEMPLATE_HEADERS.map(csvEscape).join(','),
    ...CSV_SAMPLE_ROWS.map((row) => row.map(csvEscape).join(',')),
  ]
  // 先頭に UTF-8 BOM (U+FEFF)。CRLF 改行 (Excel 互換)。
  return '﻿' + lines.join('\r\n') + '\r\n'
}

export interface CsvTemplateOptions {
  /** テスト用: Blob でなく生テキストも返す。 */
  returnText?: boolean
}

/**
 * CSV テンプレを Blob (+ 任意で text) で生成。BOM付き UTF-8。
 */
export function buildCsvTemplate(options: { returnText: true }): { blob: Blob; text: string }
export function buildCsvTemplate(options?: { returnText?: false }): Blob
export function buildCsvTemplate(options?: CsvTemplateOptions): Blob | { blob: Blob; text: string } {
  const text = toCsvText()
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  if (options?.returnText) return { blob, text }
  return blob
}

/**
 * Blob をファイル名付きでダウンロード (クライアント only)。
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // メモリ解放 (次のイベントループで revoke)。
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/** CSV テンプレを「質問の見本.csv」でダウンロード。 */
export function downloadCsvTemplate(): void {
  downloadBlob(buildCsvTemplate(), '質問の見本.csv')
}

/** Excel テンプレを「質問の見本.xlsx」でダウンロード (xlsx を動的 import)。 */
export async function downloadXlsxTemplate(): Promise<void> {
  const { buildXlsxTemplateBlob } = await import('./xlsx')
  const blob = await buildXlsxTemplateBlob()
  downloadBlob(blob, '質問の見本.xlsx')
}
