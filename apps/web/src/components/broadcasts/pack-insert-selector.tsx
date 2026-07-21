'use client'

import { useState, useEffect } from 'react'
import { api, type TemplatePackListItem, type TemplatePackItem } from '@/lib/api'
import {
  itemToFormPatch,
  packOptionLabel,
  isInsertablePack,
  packToFormMessages,
  packFitsRemaining,
  type FormBubblePatch,
} from '@/lib/template-packs/pack-insert'
import { messageTypeLabels } from '@/lib/broadcast-labels'

function packItemSummary(item: TemplatePackItem): string {
  if (item.message_type === 'text') return item.message_content.slice(0, 30)
  return `(${messageTypeLabels[item.message_type]})`
}

interface Props {
  accountId: string | null
  /** 追加できる残りメッセージ枠 (最大5 − 現在のブロック数)。0 なら全ボタン無効。 */
  remainingSlots: number
  /** 選んだ吹き出しをフォームのメッセージ列に**追加**する (置換でない・送信はしない)。 */
  onAppend: (patches: FormBubblePatch[]) => void
}

/**
 * broadcast-form のパック挿入導線 (G16 → combo messages Batch 2 で「追加」化)。
 * パックを選ぶと吹き出し一覧が出て、「パック全体を追加」でパックの全吹き出しを順序どおり
 * まとめてメッセージ列に append する (owner「テンプレート通りに追加する」)。個別「追加」で
 * 1件ずつ足すこともできる。残枠不足時は全体追加を無効化し不足を明示 (silent 切り詰めしない)。
 * 挿入のみ・送信しない。
 */
export default function PackInsertSelector({ accountId, remainingSlots, onAppend }: Props) {
  const [packs, setPacks] = useState<TemplatePackListItem[]>([])
  const [selectedPackId, setSelectedPackId] = useState('')
  const [items, setItems] = useState<TemplatePackItem[] | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    // account 切替時は前 account の選択/展開を完全リセット (stale-state で別 account の
    // pack items がフォームに挿入されるのを防ぐ・batch5 loadPickerItems の取得前クリア方式)。
    setPacks([])
    setSelectedPackId('')
    setItems(null)
    if (!accountId) return
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
      <p className="mt-1 text-xs text-gray-500">※ 選んだ吹き出しをフォームのメッセージ列に追加するだけです。この操作では送信しません。</p>

      {selectedPackId && (
        loading ? (
          <p className="mt-2 text-xs text-gray-400">読み込み中...</p>
        ) : items && items.length > 0 ? (
          (() => {
            const wholeFits = packFitsRemaining(items.length, remainingSlots)
            return (
              <div className="mt-2 space-y-2">
                {/* パック全体を追加 (owner「テンプレート通りに追加する」)。残枠不足なら無効化 + 不足表示。 */}
                <div>
                  <button
                    type="button"
                    disabled={!wholeFits}
                    onClick={() => onAppend(packToFormMessages(items))}
                    className="w-full min-h-[40px] px-3 py-2 text-xs font-medium text-white rounded-md disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{ backgroundColor: '#06C755' }}
                  >
                    パック全体を追加（{items.length}吹き出し）
                  </button>
                  {!wholeFits && (
                    <p className="mt-1 text-xs text-red-600">
                      残り枠が足りません（このパックは{items.length}件・残り{remainingSlots}件／最大5通）。個別に必要な分だけ追加してください。
                    </p>
                  )}
                </div>

                <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
                  {items.map((it, i) => (
                    <li key={it.id} className="flex items-center justify-between gap-2 px-3 py-2">
                      <div className="min-w-0 flex items-center gap-2">
                        <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${it.message_type === 'flex' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-700'}`}>
                          {messageTypeLabels[it.message_type]}
                        </span>
                        <span className="text-xs text-gray-600 truncate">
                          #{i + 1} {packItemSummary(it)}
                        </span>
                      </div>
                      <button
                        type="button"
                        disabled={remainingSlots <= 0}
                        onClick={() => onAppend([itemToFormPatch(it)])}
                        className="shrink-0 px-3 py-1 text-xs font-medium text-white rounded-md disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{ backgroundColor: '#06C755' }}
                      >
                        追加
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })()
        ) : (
          <p className="mt-2 text-xs text-gray-400">このパックには吹き出しがありません。</p>
        )
      )}
    </div>
  )
}
