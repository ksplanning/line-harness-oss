'use client'

import { useState } from 'react'
import type { ShareInfo } from '@/lib/formaloo-advanced-api'

// =============================================================================
// SharePanel (F-5 / T-E1) — HP 埋め込みコード提示 + Google Sheets 連携 (presentational)。
//   埋め込みコード (iframe/script) は published のみ表示 (T-B3 publish gate 接続 / N-7)。
//   未公開は「公開すると使えます」案内。Sheets 連携ボタンは owner のみ (PII 外部出力 / N-9)。
//   owner 向け anti-generic: 既存管理画面トーン。コピーは navigator.clipboard (無い環境は select 促し)。
// =============================================================================

const LINE_GREEN = '#06C755'

export interface SharePanelProps {
  share: ShareInfo | null
  isOwner: boolean
  connecting?: boolean
  onConnectSheets: () => void
}

function CodeBox({ label, code, testid }: { label: string; code: string; testid: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard 不可環境: ユーザーが手動選択 */
    }
  }
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs text-gray-500">{label}</span>
        <button type="button" onClick={copy} className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50">
          {copied ? 'コピーしました' : 'コピー'}
        </button>
      </div>
      <textarea aria-label={label} data-testid={testid} readOnly value={code} rows={2} onFocus={(e) => e.currentTarget.select()} className="w-full rounded-lg border border-gray-300 bg-gray-50 p-2 font-mono text-xs" />
    </div>
  )
}

export default function SharePanel({ share, isOwner, connecting, onConnectSheets }: SharePanelProps) {
  if (!share) return null

  return (
    <div className="space-y-4 rounded-lg border border-gray-200 bg-white p-4" data-testid="share-panel">
      <h3 className="text-sm font-bold text-gray-900">共有・連携</h3>

      {/* LINE 配信用 URL (順方向 prefill / fr_id・fr_name / T-A5) */}
      {share.published && share.lineDistUrl && (
        <section className="space-y-1">
          <div className="text-xs font-medium text-gray-700">LINE 配信用 URL</div>
          <div className="text-xs text-gray-500" data-testid="line-dist-url">
            配信URL：<a href={share.lineDistUrl} target="_blank" rel="noreferrer" className="text-blue-600 underline break-all">{share.lineDistUrl}</a>
          </div>
          <p className="text-[11px] leading-relaxed text-gray-400" data-testid="line-dist-note">
            LINE の配信・導線ではこの URL を使ってください。開いた友だちの識別変数（fr_id / fr_name）が自動で付き、
            スプレッドシートに「どの LINE アカウントの回答か」が並びます。
            <br />
            ※ Formaloo フォーム側に alias「fr_id」「fr_name」の hidden field と Google スプレッドシート連携の設定が必要です。
          </p>
        </section>
      )}

      {/* HP 埋め込み */}
      <section className="space-y-2 border-t border-gray-100 pt-3">
        <div className="text-xs font-medium text-gray-700">ホームページに埋め込む</div>
        {share.published ? (
          <>
            {share.publicUrl && (
              <div className="text-xs text-gray-500" data-testid="hp-public-url">
                HP公開URL：<a href={share.publicUrl} target="_blank" rel="noreferrer" className="text-blue-600 underline break-all">{share.publicUrl}</a>
              </div>
            )}
            {share.iframeCode && <CodeBox label="iframe（枠で埋め込み）" code={share.iframeCode} testid="iframe-code" />}
            {share.scriptCode && <CodeBox label="script（1行タグで埋め込み）" code={share.scriptCode} testid="script-code" />}
          </>
        ) : (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" data-testid="unpublished-note">
            フォームを公開すると、埋め込みコードが発行されます（誤配信防止のため下書き中は無効です）。
          </div>
        )}
      </section>

      {/* Google Sheets 連携 */}
      <section className="space-y-2 border-t border-gray-100 pt-3">
        <div className="text-xs font-medium text-gray-700">スプレッドシート連携</div>
        {share.gsheetConnected ? (
          <div className="flex items-center gap-2 text-xs text-gray-600" data-testid="gsheet-connected">
            <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: LINE_GREEN }} />
            連携済み
            {share.gsheetUrl && <a href={share.gsheetUrl} target="_blank" rel="noreferrer" className="text-blue-600 underline">シートを開く</a>}
          </div>
        ) : (
          <div className="text-xs text-gray-500">未連携</div>
        )}
        {isOwner && (
          <button type="button" onClick={onConnectSheets} disabled={connecting} className="min-h-[40px] rounded-lg border border-gray-300 px-3 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50">
            {connecting ? '連携中…' : share.gsheetConnected ? '再同期する' : 'Googleスプレッドシートと連携'}
          </button>
        )}
      </section>
    </div>
  )
}
