'use client'

import { useState, useEffect } from 'react'
import { api, type TemplatePackListItem, type TemplatePackItem } from '@/lib/api'
import { itemToFormPatch, packOptionLabel, isInsertablePack, type FormBubblePatch } from '@/lib/template-packs/pack-insert'

interface Props {
  accountId: string | null
  /** 選んだ吹き出しをフォームに反映する (messageType/messageContent を差し替え)。送信はしない。 */
  onInsert: (patch: FormBubblePatch) => void
}

/**
 * broadcast-form のパック挿入導線 (G16)。パックを選ぶと吹き出し一覧が出て、1件ずつ
 * 「フォームに入れる」で messageType/messageContent に反映する (挿入のみ・送信しない)。
 * 単一 messageContent の broadcast-form に安全に載せるためのフォールバック方式。
 */
export default function PackInsertSelector({ accountId, onInsert }: Props) {
  const [packs, setPacks] = useState<TemplatePackListItem[]>([])
  const [selectedPackId, setSelectedPackId] = useState('')
  const [items, setItems] = useState<TemplatePackItem[] | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!accountId) {
      setPacks([])
      return
    }
    let cancelled = false
    api.templatePacks
      .list(accountId)
      .then((r) => {
        if (!cancelled && r.success) setPacks(r.data.filter((p) => isInsertablePack(p.itemCount)))
      })
      .catch(() => { /* silent — 挿入導線は任意機能 */ })
    return () => { cancelled = true }
  }, [accountId])

  const loadItems = async (packId: string) => {
    setSelectedPackId(packId)
    setItems(null)
    if (!packId || !accountId) return
    setLoading(true)
    try {
      const r = await api.templatePacks.get(packId, accountId)
      if (r.success) setItems(r.data.items)
    } catch {
      setItems([])
    } finally {
      setLoading(false)
    }
  }

  if (!accountId) return null

  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">配信セット（テンプレパック）から入れる</label>
      <select
        value={selectedPackId}
        onChange={(e) => loadItems(e.target.value)}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
      >
        <option value="">— パックを選ぶ —</option>
        {packs.map((p) => (
          <option key={p.id} value={p.id}>{packOptionLabel(p.name, p.itemCount)}</option>
        ))}
      </select>
      <p className="mt-1 text-xs text-gray-500">※ 選んだ吹き出しをフォームに展開するだけです。この操作では送信しません。</p>

      {selectedPackId && (
        loading ? (
          <p className="mt-2 text-xs text-gray-400">読み込み中...</p>
        ) : items && items.length > 0 ? (
          <ul className="mt-2 divide-y divide-gray-100 border border-gray-200 rounded-lg">
            {items.map((it, i) => (
              <li key={it.id} className="flex items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0 flex items-center gap-2">
                  <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${it.message_type === 'flex' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-700'}`}>
                    {it.message_type === 'flex' ? 'Flex' : 'テキスト'}
                  </span>
                  <span className="text-xs text-gray-600 truncate">
                    #{i + 1} {it.message_type === 'flex' ? '(Flexメッセージ)' : it.message_content.slice(0, 30)}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => onInsert(itemToFormPatch(it))}
                  className="shrink-0 px-3 py-1 text-xs font-medium text-white rounded-md"
                  style={{ backgroundColor: '#06C755' }}
                >
                  フォームに入れる
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-gray-400">このパックには吹き出しがありません。</p>
        )
      )}
    </div>
  )
}
