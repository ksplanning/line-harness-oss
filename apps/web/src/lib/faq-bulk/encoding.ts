/**
 * CSV バイト列の文字コード判定 + デコード (spec §形式1 CSV)。
 *
 * 判定順 (黙って化けさせない = failure_observable 対応):
 *  (a) 先頭に UTF-8 BOM (EF BB BF) → UTF-8 (BOM は text から除去)
 *  (b) UTF-8 として fatal デコード試行 → 成功なら UTF-8
 *  (c) 失敗なら Shift_JIS として fatal デコード試行 → 成功なら shift_jis
 *  (d) どちらも失敗 → EncodingDetectionError (判別不能)
 *
 * 限界の明示 (spec §文字化け防止 / 独立レビュー #5):
 *   fatal:true は「不正バイト列」を検知するが、「UTF-8 としても Shift_JIS としても
 *   合法だが実際は別の文字」(機種依存文字・EUC-JP 等) は原理的に弾けない。
 *   最終的な化け防止はプレビュー表での人の目視 (必須 UX)。
 */
export class EncodingDetectionError extends Error {
  constructor(message = '文字コードを判別できませんでした') {
    super(message)
    this.name = 'EncodingDetectionError'
  }
}

export type DetectedEncoding = 'utf-8' | 'shift_jis'

export interface DecodeResult {
  text: string
  encoding: DetectedEncoding
}

const UTF8_BOM = [0xef, 0xbb, 0xbf]

function toUint8(buffer: ArrayBuffer | Uint8Array): Uint8Array {
  return buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
}

function hasUtf8Bom(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 3 &&
    bytes[0] === UTF8_BOM[0] &&
    bytes[1] === UTF8_BOM[1] &&
    bytes[2] === UTF8_BOM[2]
  )
}

function tryDecode(bytes: Uint8Array, label: string): string | null {
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

export function decodeCsvBuffer(buffer: ArrayBuffer | Uint8Array): DecodeResult {
  const bytes = toUint8(buffer)
  if (bytes.length === 0) return { text: '', encoding: 'utf-8' }

  // (a) UTF-8 BOM
  if (hasUtf8Bom(bytes)) {
    const body = bytes.subarray(3)
    const text = tryDecode(body, 'utf-8')
    if (text !== null) return { text, encoding: 'utf-8' }
    // BOM ありなのに本文が壊れている → 判別不能
    throw new EncodingDetectionError()
  }

  // (b) UTF-8 (fatal)
  const utf8 = tryDecode(bytes, 'utf-8')
  if (utf8 !== null) return { text: utf8, encoding: 'utf-8' }

  // (c) Shift_JIS (fatal)
  const sjis = tryDecode(bytes, 'shift_jis')
  if (sjis !== null) return { text: sjis, encoding: 'shift_jis' }

  // (d) 判別不能
  throw new EncodingDetectionError()
}
