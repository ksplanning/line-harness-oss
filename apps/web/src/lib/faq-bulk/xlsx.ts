/**
 * SheetJS (xlsx) の薄いラッパ (spec §形式2 Excel / plan §2)。
 *
 * SheetJS は **動的 import** で /faqs 初期表示のバンドルに載せない
 * (Excel を触った瞬間だけ chunk を取得 / D-8)。テンプレ生成も同 chunk を再利用。
 *
 * 多層防御 (plan §2 残余リスク緩和):
 *  - セル値を全て文字列として扱う (raw:false / defval:'')。
 *  - 列は index (0,1,2…) で扱い、untrusted 見出しをオブジェクトキーにしない
 *    (prototype pollution の主経路を断つ)。
 *  - 先頭シートのみ読む (複数シートは無視)。
 *  - Worker は xlsx を一切触らない (攻撃面はブラウザに限定・D1 に波及しない)。
 */

const TEMPLATE_HEADERS = ['質問', '言い換え', '答え', '有効'] as const

const TEMPLATE_ROWS: string[][] = [
  [...TEMPLATE_HEADERS],
  ['営業時間は何時からですか？', '何時から,開店時間', '平日は10時〜19時、土日は11時〜18時です。', '有効'],
  ['駐車場はありますか？', '駐車場,車', '店舗の裏に3台分ございます。', '有効'],
]

/**
 * 先頭シートを string[][] に変換 (ArrayBuffer 入力 = テスト/内部用)。
 * セル値は全て表示文字列。行内の空セルは '' で埋める。
 */
export async function parseXlsxBuffer(buffer: ArrayBuffer | Uint8Array): Promise<string[][]> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(buffer, { type: 'array' })
  const firstName = wb.SheetNames[0]
  if (!firstName) return []
  const ws = wb.Sheets[firstName]
  // header:1 で index ベースの2次元配列を得る。raw:false で表示文字列、defval:'' で欠損を空文字。
  const rows = XLSX.utils.sheet_to_json<string[]>(ws, {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  })
  // 各セルを文字列化 (raw:false でも稀に number が来るケースへの保険)。
  return rows.map((row) => (Array.isArray(row) ? row.map((c) => (c == null ? '' : String(c))) : []))
}

/**
 * ブラウザの File を先頭シート string[][] に変換 (UI から呼ぶ実体)。
 */
export async function parseXlsxFile(file: File): Promise<string[][]> {
  const buffer = await file.arrayBuffer()
  return parseXlsxBuffer(buffer)
}

/**
 * Excel テンプレ (.xlsx) を ArrayBuffer で生成 (テスト/内部用)。
 */
export async function buildXlsxTemplateBuffer(): Promise<ArrayBuffer> {
  const XLSX = await import('xlsx')
  const ws = XLSX.utils.aoa_to_sheet(TEMPLATE_ROWS)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, '質問')
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
}

/**
 * Excel テンプレ (.xlsx) を Blob で生成 (UI の DL ボタンから呼ぶ)。
 */
export async function buildXlsxTemplateBlob(): Promise<Blob> {
  const buf = await buildXlsxTemplateBuffer()
  return new Blob([buf], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

export { TEMPLATE_HEADERS as XLSX_TEMPLATE_HEADERS }
