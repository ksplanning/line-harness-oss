/**
 * Phase B B-4 (T-D1) — ファイル形式の純関数判定 (node で単体テスト可 / hollow completion 回避)。
 * マジックバイト (先頭数 byte) だけで判定し、パーサ (pdf.js/mammoth) を起動しない = 拒否判定を安く決定的に。
 */
import type { FileFormat } from './types';

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // "%PDF"
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // "PK\x03\x04" (docx/xlsx 等 OOXML の ZIP コンテナ)
const OLE2_MAGIC = [0xd0, 0xcf, 0x11, 0xe0]; // 旧 Office (.doc/.xls) の OLE2 複合ドキュメント

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  for (let i = 0; i < sig.length; i += 1) {
    if (bytes[i] !== sig[i]) return false;
  }
  return true;
}

/**
 * 先頭マジックバイトで形式を判定。ZIP(OOXML) は docx として扱う (取込 UI は Word を対象とするため。
 * 万一 xlsx を渡されても docx 抽出で空 → empty 拒否に落ちる = 安全)。OLE2 は 'doc' (旧形式 = 拒否対象)。
 */
export function detectFileFormat(bytes: Uint8Array): FileFormat {
  if (startsWith(bytes, PDF_MAGIC)) return 'pdf';
  if (startsWith(bytes, ZIP_MAGIC)) return 'docx';
  if (startsWith(bytes, OLE2_MAGIC)) return 'doc';
  return 'unknown';
}

/** scanned 判定の実文字数下限 (空白除去後)。chunk 最小 20 字より小さめに置き、極端に文字のない PDF のみ弾く。 */
const SCANNED_MIN_NONSPACE_CHARS = 10;

/**
 * 抽出テキストがテキスト層なし (スキャン画像 PDF) かのヒューリスティック。pdf.js は画像だけの PDF に対し
 * ほぼ空 or 空白のみのテキストを返すため、空白除去後の実文字数が下限未満なら scanned とみなす (OCR は範囲外)。
 */
export function isLikelyScanned(text: string): boolean {
  const nonSpace = text.replace(/\s/g, '');
  return nonSpace.length < SCANNED_MIN_NONSPACE_CHARS;
}
