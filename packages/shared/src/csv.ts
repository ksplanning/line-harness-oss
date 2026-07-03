/**
 * CSV 生成の単一正典 (batch3 C1)。
 *
 * web (faq-bulk テンプレ DL) と worker (友だち/回答/予約の export) が共用する。
 * 「同じ処理を2箇所」= drift 罠 (batch2 validateFlex の教訓) を構造的に排除するため、
 * csvEscape / BOM / CRLF ロジックをここに 1 本化する。
 *
 * - Excel 互換: 先頭に UTF-8 BOM (U+FEFF)・改行は CRLF。
 * - RFC4180: カンマ・改行・引用符を含むセルは "" 囲み (内部 " は "" に倍化)。
 * - CSV injection 対策: `=`, `+`, `-`, `@`, TAB, CR で始まるセルは先頭に `'` を付けて
 *   Excel/Sheets の数式実行を無害化する (外部入力の友だち名・フォーム回答・予約メモ対策)。
 */

/** 先頭に付与する UTF-8 BOM (U+FEFF)。Excel で日本語が文字化けしないため。 */
export const CSV_BOM = '﻿';

/**
 * CSV injection を無害化する。`=`, `+`, `-`, `@`, TAB (0x09), CR (0x0D) で
 * 始まるセルは Excel / Google Sheets で数式として評価され得るため、先頭に `'`
 * を付けてテキストとして扱わせる。
 *
 * RFC4180 エスケープ (csvEscape) の *前* に適用する純関数。
 */
export function csvSanitizeCell(value: string): string {
  if (value.length > 0 && /^[=+\-@\t\r]/.test(value)) {
    return "'" + value;
  }
  return value;
}

/**
 * RFC4180 に沿った CSV フィールドのエスケープ。
 * カンマ・改行 (CR/LF)・引用符を含むセルは "" 囲みにし、内部の " は "" に倍化する。
 *
 * `sanitize` (既定 true) で csvSanitizeCell を先に適用し injection を無害化する。
 * FAQ テンプレの見本行のように内部固定文字列で injection の心配が無い呼び出しは
 * `sanitize=false` を渡して従来挙動 (無害化なし) を保てる。
 */
export function csvEscape(value: string, sanitize = true): string {
  const v = sanitize ? csvSanitizeCell(value) : value;
  if (/[",\r\n]/.test(v)) {
    return '"' + v.replace(/"/g, '""') + '"';
  }
  return v;
}

/** null / undefined / number / boolean を CSV セル文字列へ正規化する。 */
function cellToString(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  return String(cell);
}

export interface ToCsvOptions {
  /** 先頭に UTF-8 BOM を付ける (既定 true / Excel 互換)。 */
  bom?: boolean;
  /** CSV injection 無害化を適用する (既定 true)。 */
  sanitize?: boolean;
}

/**
 * headers + rows を CSV テキストへ組み立てる。
 * - 先頭に BOM (既定)・改行は CRLF・末尾にも CRLF を 1 つ付ける。
 * - 各セルは csvSanitizeCell → csvEscape (RFC4180) の順で処理する。
 */
export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
  options: ToCsvOptions = {},
): string {
  const bom = options.bom ?? true;
  const sanitize = options.sanitize ?? true;
  const lines: string[] = [];
  // ヘッダは内部固定ラベルだが、統一のため同じエスケープを通す (sanitize 適用可)。
  lines.push(headers.map((h) => csvEscape(h, sanitize)).join(','));
  for (const row of rows) {
    lines.push(row.map((cell) => csvEscape(cellToString(cell), sanitize)).join(','));
  }
  const body = lines.join('\r\n') + '\r\n';
  return bom ? CSV_BOM + body : body;
}
