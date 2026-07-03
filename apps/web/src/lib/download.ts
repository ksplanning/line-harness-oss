/**
 * ブラウザ側のファイルダウンロード補助 (batch3 C6 で faq-bulk から lib 昇格)。
 *
 * downloadBlob は Blob をファイル名付きで保存する DOM ヘルパ。CSV エクスポート
 * (downloadCsv / api.ts) と FAQ テンプレ DL (faq-bulk/template.ts) が共用する。
 */

/** Blob をファイル名付きでダウンロードする (クライアント only)。 */
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
