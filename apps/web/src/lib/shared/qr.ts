/**
 * G35 QR — 純ロジック (QR 画像 URL 組立 / DL ファイル名生成)。
 * QrDialog から import。worker /api/qr は public proxy (認証不要)。
 */

/**
 * QR 画像の URL を組み立てる。
 * `${base}/api/qr?size=240x240&data=<encodeURIComponent(url)>`。base 末尾の / は除去。
 */
export function buildQrImageUrl(base: string, url: string): string {
  const trimmedBase = base.replace(/\/+$/, '')
  return `${trimmedBase}/api/qr?size=240x240&data=${encodeURIComponent(url)}`
}

/**
 * DL ファイル名を生成。英数字・ひらがな・カタカナ・漢字以外を - に置換し `qr-<name>.png`。
 */
export function qrDownloadFilename(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9ぁ-んァ-ン一-龯]/g, '-')
  return `qr-${safe}.png`
}
