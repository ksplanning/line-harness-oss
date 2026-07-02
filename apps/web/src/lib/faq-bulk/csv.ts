/**
 * RFC4180 準拠の軽量 CSV パーサ (依存追加なし / spec §形式1 CSV)。
 *
 * 対応:
 *  - ダブルクォート囲み "..." / 埋め込み "" のエスケープ
 *  - クォート内の改行 (セル内改行 = 複数行の答え)
 *  - クォート内のカンマ
 *  - 行区切り \r\n / \n 両対応
 *
 * 出力: string[][] (見出し行含む全行のセル配列)。末尾の空行 (trailing newline) は落とす。
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  let i = 0
  const n = input.length

  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
  }

  while (i < n) {
    const ch = input[i]

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      // クォート内の \r\n はセル内改行として \n に正規化
      if (ch === '\r' && input[i + 1] === '\n') {
        field += '\n'
        i += 2
        continue
      }
      field += ch
      i++
      continue
    }

    if (ch === '"') {
      inQuotes = true
      i++
      continue
    }
    if (ch === ',') {
      pushField()
      i++
      continue
    }
    if (ch === '\r' && input[i + 1] === '\n') {
      pushRow()
      i += 2
      continue
    }
    if (ch === '\n' || ch === '\r') {
      pushRow()
      i++
      continue
    }
    field += ch
    i++
  }

  // 最終フィールド / 行を確定 (末尾に改行が無いケース)
  // 直前が行区切りで終わっていた場合 (field='' かつ row=[]) は空行を足さない = trailing newline を落とす。
  if (field !== '' || row.length > 0) {
    pushRow()
  }

  return rows
}
