'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { api, type CannedResponseData } from '@/lib/api'
import { previewContent } from '@/lib/canned-responses/canned-form'
import { loadPickerItems } from '@/lib/canned-responses/picker-load'

interface Props {
  accountId: string | null
  onSelect: (content: string) => void
  compact?: boolean
}

// composer 上に開く定型文ピッカー。行選択で onSelect(content) を呼ぶ "だけ"。
// 送信系 (api.chats.send / handleSendMessage / triggerLoadingAnimation) を import しない
// = 構造的に送信不能 (failure_observable 筆頭を構造で潰す)。
export default function CannedResponsePicker({ accountId, onSelect, compact = false }: Props) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<CannedResponseData[]>([])
  const [loading, setLoading] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // 外側クリックで閉じる (sidebar AccountSwitcher と同一流儀)。
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const toggle = async () => {
    if (open) {
      setOpen(false)
      return
    }
    setOpen(true)
    if (accountId) {
      setLoading(true)
      try {
        // loadPickerItems が取得前に必ず setItems([]) でクリアするため、
        // reload 失敗時に旧 (別 account の) 定型文が残らない (Codex P2)。
        await loadPickerItems(accountId, setItems, (id) => api.cannedResponses.list(id))
      } finally {
        setLoading(false)
      }
    }
  }

  return (
    <div ref={ref} className="relative shrink-0">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={toggle}
          disabled={!accountId}
          aria-label={compact ? '定型文を選ぶ' : undefined}
          aria-expanded={open}
          aria-haspopup="dialog"
          title={compact ? '定型文を選ぶ' : undefined}
          className={compact
            ? `inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border transition-colors focus:outline-none focus:ring-2 focus:ring-green-500 disabled:cursor-not-allowed disabled:opacity-50 ${
                open
                  ? 'border-green-500 bg-green-50 text-green-700'
                  : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
              }`
            : 'min-h-[36px] whitespace-nowrap rounded-md border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50'}
        >
          {compact ? (
            <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5h6m-6 4h6m-6 4h4m-6 7h10a2 2 0 002-2V6a2 2 0 00-2-2h-1.5a2.5 2.5 0 00-5 0H7a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          ) : '📋 定型文'}
        </button>
        {!compact && (
          <span className="text-[11px] text-gray-400">選ぶと下の入力欄に入ります（送信されません）</span>
        )}
      </div>

      {open && (
        <div
          role="dialog"
          aria-label="定型文を選ぶ"
          className="absolute bottom-full left-0 z-30 mb-2 max-h-64 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg"
        >
          <div className="px-3 py-2 text-[11px] text-gray-500 border-b border-gray-100 sticky top-0 bg-white">
            選ぶと下の入力欄に貼り付けます（送信されません）
          </div>
          {loading ? (
            <div className="px-3 py-4 text-xs text-gray-400 text-center">読み込み中...</div>
          ) : items.length === 0 ? (
            <div className="px-3 py-4 text-xs text-gray-500 text-center leading-relaxed">
              <p className="mb-1">定型文がありません。</p>
              <span>
                <Link href="/canned-responses" className="text-green-600 hover:underline">
                  設定＞チャット定型文
                </Link>
                <span> から作れます。</span>
              </span>
            </div>
          ) : (
            <ul>
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(item.content)
                      setOpen(false)
                    }}
                    className="w-full text-left px-3 py-2 min-h-[44px] hover:bg-gray-50"
                  >
                    <p className="text-sm font-medium text-gray-900 truncate">{item.title}</p>
                    <p className="text-xs text-gray-400 truncate">{previewContent(item.content)}</p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
