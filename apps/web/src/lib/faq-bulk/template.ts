/**
 * テンプレート生成 + ダウンロード (spec §テンプレート DL)。
 *
 * CSV は **BOM付き UTF-8** で生成 (Excel で開いても文字化けしない)。
 * Excel テンプレは xlsx.ts の buildXlsxTemplateBlob (動的 import / 同 chunk 再利用)。
 * DL はクライアントで Blob + URL.createObjectURL (サーバ不要 = static export 互換)。
 */

// CSV エスケープ / BOM / CRLF は packages/shared の単一正典を使う (batch3 C1・drift 排除)。
// web 独自の csvEscape 実装は撤去済 (「同じ処理を2箇所」= drift 罠 / batch2 validateFlex の教訓)。
import { toCsv } from '@line-crm/shared'
// downloadBlob は lib/download.ts に昇格 (batch3 C6)。CSV エクスポートと共用。
import { downloadBlob } from '../download'

export { downloadBlob }

export const CSV_TEMPLATE_HEADERS = ['質問', '言い換え', '答え', '有効'] as const

const CSV_SAMPLE_ROWS: string[][] = [
  ['営業時間は何時からですか？', '何時から,開店時間', '平日は10時〜19時、土日は11時〜18時です。', '有効'],
  ['駐車場はありますか？', '駐車場,車', '店舗の裏に3台分ございます。', '有効'],
]

function toCsvText(): string {
  // 先頭に UTF-8 BOM・CRLF 改行 (Excel 互換)。見本セルは固定文字列で injection の
  // 心配が無いため sanitize=false で従来出力 (byte-identical) を維持する。
  return toCsv(CSV_TEMPLATE_HEADERS, CSV_SAMPLE_ROWS, { sanitize: false })
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
