'use client'

import { useState, useEffect, useCallback } from 'react'
import type { Tag } from '@line-crm/shared'
import { api, type SavedSearchData } from '@/lib/api'
import SegmentBuilder from '@/components/broadcasts/segment-builder'

interface SegmentCondition {
  operator: 'AND' | 'OR'
  rules: unknown[]
}

interface Props {
  accountId: string | null
  tags: Tag[]
  activeId: string | null
  onApply: (id: string | null) => void
}

/**
 * 保存済み検索パネル (G10) — /friends の検索バー内。既存 SegmentBuilder を再利用して
 * 条件を組み・件数プレビューを見て名前を付けて保存し、chip で適用/解除、行内確認で削除。
 * 適用中は activeId が親 (friends page) の savedSearchId として api.friends.list に渡る。
 */
export default function SavedSearchPanel({ accountId, tags, activeId, onApply }: Props) {
  const [items, setItems] = useState<SavedSearchData[]>([])
  const [showBuilder, setShowBuilder] = useState(false)
  const [pendingConditions, setPendingConditions] = useState<SegmentCondition | null>(null)
  const [newName, setNewName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await api.savedSearches.list(accountId || undefined)
      if (res.success) setItems(res.data)
    } catch {
      // non-blocking
    }
  }, [accountId])

  useEffect(() => {
    load()
  }, [load])

  const activeItem = items.find((s) => s.id === activeId) ?? null

  const resetBuilder = () => {
    setShowBuilder(false)
    setPendingConditions(null)
    setNewName('')
    setError('')
  }

  const handleSave = async () => {
    if (!pendingConditions || newName.trim() === '' || saving) return
    setSaving(true)
    setError('')
    try {
      const res = await api.savedSearches.create({
        name: newName.trim(),
        conditions: pendingConditions,
        accountId: accountId || null,
      })
      if (res.success) {
        resetBuilder()
        await load()
      } else {
        setError(res.error || '保存に失敗しました')
      }
    } catch {
      setError('保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const handleRename = async (id: string) => {
    if (renameValue.trim() === '') return
    await api.savedSearches.rename(id, renameValue.trim())
    setRenamingId(null)
    setRenameValue('')
    if (activeId === id) onApply(id) // keep active
    await load()
  }

  const handleDelete = async (id: string) => {
    await api.savedSearches.remove(id)
    setPendingRemoveId(null)
    if (activeId === id) onApply(null) // 適用中を削除したら解除
    await load()
  }

  return (
    <div className="mt-3 pt-3 border-t border-gray-100">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-gray-600 font-medium">保存済み検索</span>
        {!showBuilder && (
          <button
            type="button"
            onClick={() => setShowBuilder(true)}
            className="text-xs text-[#06C755] hover:underline"
          >
            ＋ 現在の条件を保存
          </button>
        )}
      </div>

      {/* 適用中バナー */}
      {activeItem && (
        <div className="flex items-center gap-2 mb-2 text-xs">
          <span className="text-gray-700">
            <strong>「{activeItem.name}」</strong>で絞り込み中
          </span>
          <button
            type="button"
            onClick={() => onApply(null)}
            className="px-2 py-0.5 rounded-md text-gray-600 bg-gray-100 hover:bg-gray-200"
          >
            解除
          </button>
        </div>
      )}

      {/* chip 一覧 */}
      {items.length === 0 && !showBuilder ? (
        <p className="text-xs text-gray-400">
          保存済み検索はまだありません。条件を組んで「現在の条件を保存」から作れます。
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {items.map((item) => (
            <div key={item.id} className="inline-flex items-center gap-1 rounded-full border border-gray-200 px-1 py-0.5">
              {renamingId === item.id ? (
                <>
                  <input
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    className="text-xs border border-gray-300 rounded px-2 py-0.5 min-h-[36px]"
                    aria-label="名前変更"
                  />
                  <button
                    type="button"
                    onClick={() => handleRename(item.id)}
                    className="text-xs text-white bg-[#06C755] rounded px-2 min-h-[36px]"
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    onClick={() => setRenamingId(null)}
                    className="text-xs text-gray-500 px-1 min-h-[36px]"
                  >
                    ×
                  </button>
                </>
              ) : pendingRemoveId === item.id ? (
                <span className="inline-flex items-center gap-1 px-1">
                  <span className="text-xs text-gray-600">「{item.name}」を削除しますか？</span>
                  <button
                    type="button"
                    onClick={() => handleDelete(item.id)}
                    className="min-h-[36px] px-3 rounded-md text-xs font-medium text-white bg-red-600 hover:bg-red-700"
                  >
                    はい
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingRemoveId(null)}
                    className="min-h-[36px] px-3 rounded-md text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200"
                  >
                    いいえ
                  </button>
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => onApply(activeId === item.id ? null : item.id)}
                    className={`text-xs px-3 min-h-[36px] rounded-full ${
                      activeId === item.id ? 'text-white bg-[#06C755]' : 'text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    {item.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRenamingId(item.id)
                      setRenameValue(item.name)
                    }}
                    className="text-xs text-gray-500 hover:text-gray-700 px-1 min-h-[36px]"
                  >
                    名前変更
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingRemoveId(item.id)}
                    className="text-xs text-red-500 hover:bg-red-50 rounded-md px-1 min-h-[36px]"
                  >
                    削除
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 現在の条件を保存 — SegmentBuilder 再利用 (無改変) */}
      {showBuilder && (
        <div className="mt-3 rounded-md border border-gray-200 p-3">
          <SegmentBuilder
            tags={tags}
            accountId={accountId}
            onApply={(conditions) => setPendingConditions(conditions as SegmentCondition)}
            onCancel={resetBuilder}
          />
          {pendingConditions && (
            <div className="mt-3 pt-3 border-t border-gray-100 flex flex-col sm:flex-row sm:items-center gap-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="例: フォロー30日以上・VIP"
                className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-2"
                aria-label="保存済み検索の名前"
              />
              <button
                type="button"
                onClick={handleSave}
                disabled={newName.trim() === '' || saving}
                className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
                style={{ backgroundColor: '#06C755' }}
              >
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          )}
          {error && <p className="text-xs text-red-500 mt-2">{error}</p>}
        </div>
      )}
    </div>
  )
}
