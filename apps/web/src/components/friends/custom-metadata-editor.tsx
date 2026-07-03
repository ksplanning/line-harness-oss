'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'

interface CustomMetadataEditorProps {
  /** 対象の友だち ID。expander が開いたときに metadata を fetch する。 */
  friendId: string
}

/**
 * G9 カスタム項目 (friend metadata) の閲覧 + 追加 + 値編集 UI。
 *
 * worker PUT /api/friends/:id/metadata は {...existing, ...patch} の pure merge で削除経路が無い
 * (独立チェック発見)。したがって:
 *  - 削除ボタン・削除確認・削除 API 呼び出しは一切実装しない (真のキー削除は不能なため)。
 *  - 保存は「変更したキーのみ」を送る (merge 保証 / T-A4)。UI 非表示の他キーは worker 側に残る。
 *  - 既存 key と同名の追加は merge の自然な動作で値が上書きされる → ラベルを「上書き更新」に切替えて明示。
 * 送信ゼロ: metadata 更新は friends 行の JSON 列更新のみ。broadcast/push/multicast/reply を叩かない。
 */
export default function CustomMetadataEditor({ friendId }: CustomMetadataEditorProps) {
  const [metadata, setMetadata] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  // 追加フォーム
  const [adding, setAdding] = useState(false)
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')
  const [addError, setAddError] = useState('')

  // インライン編集
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editingValue, setEditingValue] = useState('')

  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      const res = await api.friends.get(friendId)
      if (res.success) {
        // serializeFriend が JSON.parse 済 object を返す。値は文字列表示 (非文字列は String 化)。
        const raw = (res.data.metadata ?? {}) as Record<string, unknown>
        const normalized: Record<string, string> = {}
        for (const [k, v] of Object.entries(raw)) {
          normalized[k] = v == null ? '' : String(v)
        }
        setMetadata(normalized)
      } else {
        setLoadError('カスタム項目の読み込みに失敗しました。')
      }
    } catch {
      setLoadError('カスタム項目の読み込みに失敗しました。')
    } finally {
      setLoading(false)
    }
  }, [friendId])

  useEffect(() => {
    load()
  }, [load])

  // 変更キーのみ merge 送信 (他キー消失防止 / T-A4)。
  const saveKey = async (key: string, value: string): Promise<boolean> => {
    setSaving(true)
    try {
      const res = await api.friends.updateMetadata(friendId, { [key]: value })
      if (res.success) {
        setMetadata((prev) => ({ ...prev, [key]: value }))
        return true
      }
      return false
    } catch {
      return false
    } finally {
      setSaving(false)
    }
  }

  const keys = Object.keys(metadata)
  const isDuplicateNewKey = newKey.trim() !== '' && keys.includes(newKey.trim())

  const handleAdd = async () => {
    const key = newKey.trim()
    if (key === '') {
      setAddError('項目名を入力してください')
      return
    }
    setAddError('')
    const ok = await saveKey(key, newValue)
    if (ok) {
      setNewKey('')
      setNewValue('')
      setAdding(false)
    } else {
      setAddError('保存に失敗しました。もう一度お試しください。')
    }
  }

  const startEdit = (key: string) => {
    setEditingKey(key)
    setEditingValue(metadata[key] ?? '')
  }

  const handleSaveEdit = async () => {
    if (editingKey == null) return
    const ok = await saveKey(editingKey, editingValue)
    if (ok) setEditingKey(null)
  }

  return (
    <div>
      <p className="text-[11px] font-medium text-gray-500 mb-2">カスタム項目</p>

      {loading ? (
        <p className="text-[11px] text-gray-400">読み込み中...</p>
      ) : loadError ? (
        <p className="text-[11px] text-red-600">{loadError}</p>
      ) : keys.length === 0 && !adding ? (
        <p className="text-[11px] text-gray-400 leading-relaxed">
          まだカスタム項目はありません。<br />
          会社名・担当者・契約プランなど、このシステムにない情報を自由に記録できます。
        </p>
      ) : (
        <div className="space-y-1.5">
          {keys.map((key) => (
            <div key={key} className="flex items-center gap-2 flex-wrap">
              {editingKey === key ? (
                <>
                  <span className="text-xs font-medium text-gray-600 min-w-[6rem] break-all">{key}</span>
                  <input
                    type="text"
                    value={editingValue}
                    onChange={(e) => setEditingValue(e.target.value)}
                    className="flex-1 min-w-[8rem] border border-gray-300 rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                  <button
                    onClick={handleSaveEdit}
                    disabled={saving}
                    className="px-2.5 py-1 text-xs font-medium rounded-md text-white disabled:opacity-50 transition-opacity"
                    style={{ backgroundColor: '#06C755' }}
                  >
                    保存
                  </button>
                  <button
                    onClick={() => setEditingKey(null)}
                    className="px-2.5 py-1 text-xs font-medium rounded-md text-gray-600 bg-gray-200 hover:bg-gray-300 transition-colors"
                  >
                    キャンセル
                  </button>
                </>
              ) : (
                <>
                  <span className="text-xs font-medium text-gray-600 min-w-[6rem] break-all">{key}</span>
                  <span className="flex-1 text-xs text-gray-800 break-all">{metadata[key] || '（未入力）'}</span>
                  <button
                    onClick={() => startEdit(key)}
                    className="text-xs font-medium text-green-600 hover:text-green-700 px-2 py-1 rounded-md hover:bg-green-50 transition-colors"
                  >
                    編集
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 追加フォーム */}
      {adding ? (
        <div className="mt-3 space-y-2 border-t border-gray-100 pt-3">
          <div>
            <label className="block text-xs text-gray-600 mb-1">項目名 <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={newKey}
              onChange={(e) => { setNewKey(e.target.value); setAddError('') }}
              className="w-full border border-gray-300 rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-green-500"
              placeholder="例: 会社名"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">値</label>
            <input
              type="text"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-green-500"
              placeholder="例: 株式会社〇〇"
            />
          </div>
          {isDuplicateNewKey && (
            <p className="text-[11px] text-gray-500">この項目はすでに存在します。上書きします。</p>
          )}
          {addError && <p className="text-[11px] text-red-600">{addError}</p>}
          <div className="flex gap-2">
            <button
              onClick={handleAdd}
              disabled={saving}
              className="px-3 py-1 text-xs font-medium rounded-md text-white disabled:opacity-50 transition-opacity"
              style={{ backgroundColor: '#06C755' }}
            >
              {isDuplicateNewKey ? '上書き更新' : '保存'}
            </button>
            <button
              onClick={() => { setAdding(false); setNewKey(''); setNewValue(''); setAddError('') }}
              className="px-3 py-1 text-xs font-medium rounded-md text-gray-600 bg-gray-200 hover:bg-gray-300 transition-colors"
            >
              キャンセル
            </button>
          </div>
        </div>
      ) : (
        !loading && !loadError && (
          <button
            onClick={() => setAdding(true)}
            className="text-xs font-medium text-green-600 hover:text-green-700 flex items-center gap-1 mt-3 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            項目を追加
          </button>
        )
      )}
    </div>
  )
}
