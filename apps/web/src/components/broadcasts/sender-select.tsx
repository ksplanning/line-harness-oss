'use client'

import { useEffect, useState } from 'react'
import { api, type SenderPresetItem } from '@/lib/api'

/** 配信作成フォームの送信者選択 (G25)。account 登録済みプリセットから dropdown で選ぶだけ。
 *  任意の名前/アイコン URL の自由入力はできない = なりすまし防止の UI 側の核。 */
export default function SenderSelect({
  accountId,
  value,
  onChange,
}: {
  accountId: string | null
  value: string | null
  onChange: (id: string | null) => void
}) {
  const [presets, setPresets] = useState<SenderPresetItem[]>([])

  useEffect(() => {
    if (!accountId) {
      setPresets([])
      return
    }
    let cancelled = false
    api.senderPresets
      .list(accountId)
      .then((r) => {
        if (!cancelled && r.success) setPresets(r.data)
      })
      .catch(() => {
        /* silent */
      })
    return () => {
      cancelled = true
    }
  }, [accountId])

  const selected = presets.find((p) => p.id === value) ?? null

  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">送信者</label>
      <select
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">既定の送信者</option>
        {presets.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {selected && (
        <div className="flex items-center gap-2 mt-2">
          {selected.iconUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={selected.iconUrl} alt="" className="w-7 h-7 rounded-full object-cover border border-gray-200" />
          ) : (
            <div className="w-7 h-7 rounded-full bg-gray-200 flex items-center justify-center text-xs text-gray-500">{selected.name.slice(0, 1)}</div>
          )}
          <span className="text-xs text-gray-600">この送信者として届きます: {selected.name}</span>
        </div>
      )}
      <p className="text-xs text-gray-500 mt-1">
        送信者は「送信者の管理」で登録したものから選べます（自由入力はできません）。
      </p>
    </div>
  )
}
