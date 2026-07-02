'use client'

/**
 * リンク設定 (F6 / ui-design §5)。ボタンと画像タップで共有。
 * 「押したときどこに行きますか？」を日本語ラジオで選び、種類ごとに入力欄が切り替わる。
 * tracked (計測リンク) は api.trackedLinks.list() から選び trackingUrl を uri 化 (A6/D-12)。
 */
import { useEffect, useState } from 'react'
import { api, type TrackedLinkListItem } from '@/lib/api'
import { urlLink, trackedLink, telLink, bookingLink } from '@/lib/flex-builder/link'
import type { LinkSpec } from '@/lib/flex-builder/types'

interface Props {
  value: LinkSpec
  onChange: (link: LinkSpec) => void
}

const KINDS: { type: LinkSpec['type']; icon: string; label: string }[] = [
  { type: 'url', icon: '🌐', label: 'ウェブページ' },
  { type: 'tracked', icon: '📊', label: '計測リンクから選ぶ' },
  { type: 'tel', icon: '📞', label: '電話をかける' },
  { type: 'booking', icon: '📅', label: '予約ページ' },
]

const inputCls =
  'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500'

export default function LinkPicker({ value, onChange }: Props) {
  const [tracked, setTracked] = useState<TrackedLinkListItem[]>([])
  const [trackedLoaded, setTrackedLoaded] = useState(false)

  useEffect(() => {
    if (value.type !== 'tracked' || trackedLoaded) return
    let alive = true
    api.trackedLinks
      .list()
      .then((res) => {
        if (alive && res.success && res.data) setTracked(res.data)
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setTrackedLoaded(true)
      })
    return () => {
      alive = false
    }
  }, [value.type, trackedLoaded])

  const pickKind = (type: LinkSpec['type']) => {
    switch (type) {
      case 'url':
        onChange(urlLink(value.type === 'url' ? value.uri : ''))
        break
      case 'tracked':
        onChange({ type: 'tracked', trackedLinkId: '', uri: '' })
        break
      case 'tel':
        onChange(telLink(value.type === 'tel' ? value.phone : ''))
        break
      case 'booking':
        onChange(bookingLink(value.type === 'booking' ? value.uri : ''))
        break
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-600">このボタンを押すとどこに行きますか？</p>
      <div className="grid grid-cols-2 gap-2">
        {KINDS.map((k) => (
          <button
            key={k.type}
            type="button"
            onClick={() => pickKind(k.type)}
            className={`flex items-center gap-1.5 min-h-[44px] px-3 rounded-md border text-sm ${
              value.type === k.type
                ? 'border-green-500 text-green-700 bg-green-50'
                : 'border-gray-300 text-gray-600'
            }`}
          >
            <span aria-hidden>{k.icon}</span>
            {k.label}
          </button>
        ))}
      </div>

      {value.type === 'url' && (
        <input
          type="text"
          value={value.uri}
          onChange={(e) => onChange(urlLink(e.target.value))}
          className={inputCls}
          placeholder="https://..."
        />
      )}

      {value.type === 'tracked' && (
        <div>
          {tracked.length > 0 ? (
            <select
              value={value.trackedLinkId}
              onChange={(e) => {
                const choice = tracked.find((t) => t.id === e.target.value)
                if (choice) onChange(trackedLink(choice))
              }}
              className={inputCls}
            >
              <option value="">計測リンクを選んでください</option>
              {tracked.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-xs text-gray-500">
              {trackedLoaded
                ? 'まだ計測リンクがありません。計測リンク画面で作ってから、また選んでください。'
                : '読み込み中...'}
            </p>
          )}
        </div>
      )}

      {value.type === 'tel' && (
        <input
          type="tel"
          value={value.phone}
          onChange={(e) => onChange(telLink(e.target.value))}
          className={inputCls}
          placeholder="例: 090-1234-5678"
        />
      )}

      {value.type === 'booking' && (
        <input
          type="text"
          value={value.uri}
          onChange={(e) => onChange(bookingLink(e.target.value))}
          className={inputCls}
          placeholder="予約ページのリンク (https://...)"
        />
      )}
    </div>
  )
}
