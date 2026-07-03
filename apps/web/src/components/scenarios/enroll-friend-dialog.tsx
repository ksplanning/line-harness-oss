'use client'

import { useState, useEffect, useRef } from 'react'
import { api } from '@/lib/api'
import type { FriendListItem } from '@/lib/api'

interface EnrollFriendDialogProps {
  scenarioId: string
  onClose: () => void
  /** enroll 成功時に呼ぶ。呼び側 (scenario-detail) が stats を reload して登録件数を更新する。 */
  onEnrolled: (friend: { id: string; displayName: string }) => void
}

/**
 * G7 手動シナリオ登録モーダル (指名移動)。
 * reminders/enroll-dialog.tsx を骨格に流用。差分:
 *  - 日付入力なし (シナリオは登録時点で cron が拾うため基準日不要)
 *  - 選択 → 即「登録する」の 1 アクション完結
 *  - 安心文言の小帯 (「登録しても、今すぐメッセージは送信されません」)
 *  - 409 (already enrolled) を行内に「すでに登録されています」で表示 (握り潰さない)
 * 送信ゼロ: enroll は friend_scenarios 行の追加のみ。broadcast/push/multicast/reply を叩かない。
 */
export default function EnrollFriendDialog({ scenarioId, onClose, onEnrolled }: EnrollFriendDialogProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<FriendListItem[]>([])
  const [searching, setSearching] = useState(false)
  const [selectedFriend, setSelectedFriend] = useState<FriendListItem | null>(null)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 友だち検索: 300ms debounce で friends.list({ search }) を叩く (reminders と同一)。
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const q = query.trim()
    if (!q) {
      setResults([])
      setSearching(false)
      return
    }
    setSearching(true)
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await api.friends.list({ search: q, limit: 20, includeTags: false })
        if (res.success) setResults(res.data.items)
        else setResults([])
      } catch {
        setResults([])
      } finally {
        setSearching(false)
      }
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query])

  // Esc で閉じる。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [saving, onClose])

  const handleEnroll = async () => {
    if (!selectedFriend) {
      setError('登録する友だちを選んでください。')
      return
    }
    setError('')
    setSaving(true)
    try {
      const res = await api.scenarios.enroll(scenarioId, selectedFriend.id)
      if (res.success) {
        onEnrolled({ id: selectedFriend.id, displayName: selectedFriend.displayName })
        onClose()
      } else {
        setError('登録に失敗しました。もう一度お試しください。')
      }
    } catch (e) {
      // fetchApi は !res.ok で Error("API error: <status>") を throw する。
      // 409 = 既登録 → 日本語で伏せる。それ以外は汎用エラー。
      const msg = e instanceof Error ? e.message : ''
      if (msg.includes('409')) {
        setError('この友だちはすでにこのシナリオに登録されています。')
      } else {
        setError('登録に失敗しました。もう一度お試しください。')
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h3 className="text-base font-semibold text-gray-900">友だちをシナリオに登録する</h3>
          <button
            type="button"
            onClick={() => !saving && onClose()}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
            aria-label="閉じる"
          >
            ×
          </button>
        </div>

        {/* 安心文言の小帯 (誤解防止 三重ガードの 1 つ) */}
        <div className="px-5 py-2 bg-gray-50 text-xs text-gray-500 border-b">
          登録しても、今すぐメッセージは送信されません。
        </div>

        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">友だちを探す</label>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              placeholder="名前で友だちを探す"
            />
          </div>

          {query.trim() !== '' && (
            <div className="border border-gray-100 rounded-md max-h-52 overflow-y-auto">
              {searching ? (
                <p className="text-xs text-gray-400 px-3 py-3">検索中...</p>
              ) : results.length === 0 ? (
                <p className="text-xs text-gray-400 px-3 py-3">該当する友だちが見つかりません</p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {/* TODO: 既登録バッジは roster API (GET /api/scenarios/:id/friends) 実装後に追加。
                      本 batch は roster API 未実装のため既登録判定は 409 レスポンスで行う。 */}
                  {results.map((f) => (
                    <li key={f.id} className="flex items-center justify-between px-3 py-2">
                      <span className="text-sm text-gray-800 truncate">{f.displayName}</span>
                      <button
                        onClick={() => { setSelectedFriend(f); setError('') }}
                        className={`min-h-[36px] px-3 rounded-md text-xs font-medium transition-colors ${
                          selectedFriend?.id === f.id
                            ? 'bg-green-100 text-green-700'
                            : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                        }`}
                      >
                        {selectedFriend?.id === f.id ? '選択中' : '選択'}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {selectedFriend && (
            <p className="text-sm text-gray-700">
              選択中: <span className="font-medium">{selectedFriend.displayName}</span>
            </p>
          )}

          {error && <p className="text-xs text-red-600">{error}</p>}

          <div className="flex gap-2">
            <button
              onClick={handleEnroll}
              disabled={saving || !selectedFriend}
              className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
              style={{ backgroundColor: '#06C755' }}
            >
              {saving ? '登録中...' : '友だちを登録する'}
            </button>
            <button
              onClick={() => !saving && onClose()}
              className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
            >
              キャンセル
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
