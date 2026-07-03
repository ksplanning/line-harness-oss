/**
 * ブラウザ側のファイルダウンロード補助 (batch3 C6 で faq-bulk から lib 昇格)。
 *
 * downloadBlob は Blob をファイル名付きで保存する DOM ヘルパ。CSV エクスポート
 * (downloadCsv / api.ts) と FAQ テンプレ DL (faq-bulk/template.ts) が共用する。
 */

/** CSV ファイル名用の JST 日付スタンプ (YYYYMMDD)。 */
export function csvDateStamp(): string {
  const jst = new Date(Date.now() + 9 * 60 * 60_000)
  return jst.toISOString().slice(0, 10).replace(/-/g, '')
}

/** ファイル名に使えない文字を除去する (フォーム名などをファイル名に埋める用)。 */
export function safeFilenamePart(name: string): string {
  return name.replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 60)
}

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
