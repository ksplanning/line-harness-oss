'use client'

import { useState } from 'react'

interface ExportCsvButtonProps {
  /** 実際の CSV ダウンロードを行う (downloadCsv 呼び出し)。例外は Error として投げること。 */
  onExport: () => Promise<void>
  /** エラー文言を画面の error banner に出すためのコールバック (空文字で clear)。 */
  onError?: (message: string) => void
  /** 対象 0 件など、出せないときは disabled にする。 */
  disabled?: boolean
  /**
   * 「Excel でそのまま開けます」安心文言の出し方。
   * `inline` = ボタン下に常設 1 行 (既定) / `tooltip` = title 属性 (狭い画面用)。
   */
  noteMode?: 'inline' | 'tooltip'
}

/**
 * CSV 出力ボタン (batch3 C8 / G39・3 画面で統一)。
 *
 * 破壊でない副次アクションなのでプライマリ緑ではなく ghost セカンダリ。処理中は
 * 「出力中…」+ disabled で二重押下を物理的に防ぐ。上限超過等のエラーは onError で
 * 画面の error banner に日常語で出す (「5万件」「絞り込んで」は worker が返す文言)。
 */
export default function ExportCsvButton({
  onExport,
  onError,
  disabled,
  noteMode = 'inline',
}: ExportCsvButtonProps) {
  const [exporting, setExporting] = useState(false)

  const handleClick = async () => {
    if (exporting || disabled) return
    setExporting(true)
    onError?.('')
    try {
      await onExport()
    } catch (e) {
      onError?.(e instanceof Error ? e.message : 'CSV の出力に失敗しました。もう一度お試しください。')
    } finally {
      setExporting(false)
    }
  }

  const button = (
    <button
      type="button"
      onClick={handleClick}
      disabled={exporting || disabled}
      title={noteMode === 'tooltip' ? 'Excel でそのまま開けます（日本語も文字化けしません）' : undefined}
      className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[44px] text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
        />
      </svg>
      {exporting ? '出力中…' : 'CSV 出力'}
    </button>
  )

  if (noteMode === 'tooltip') return button

  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      {button}
      <span className="text-xs text-gray-500">ⓘ Excel でそのまま開けます（文字化けしません）</span>
    </span>
  )
}
