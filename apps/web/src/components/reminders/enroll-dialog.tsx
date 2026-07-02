'use client'

import { useState, useEffect, useRef } from 'react'
import { api } from '@/lib/api'
import type { FriendListItem } from '@/lib/api'
import { validateEnrollForm } from '@/lib/reminders/enroll-form'

export interface EnrolledFriendRow {
  enrollmentId: string
  friendId: string
  displayName: string
  targetDate: string
  status: string
}

interface EnrollDialogProps {
  reminderId: string
  onClose: () => void
  onEnrolled: (row: EnrolledFriendRow) => void
}

export default function EnrollDialog({ reminderId, onClose, onEnrolled }: EnrollDialogProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<FriendListItem[]>([])
  const [searching, setSearching] = useState(false)
  const [selectedFriend, setSelectedFriend] = useState<FriendListItem | null>(null)
  const [targetDate, setTargetDate] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 友だち検索: 300ms debounce で friends.list({ search }) を叩く。
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
    const err = validateEnrollForm({ friendId: selectedFriend?.id ?? null, targetDate })
    if (err) {
      setError(err)
      return
    }
    if (!selectedFriend) return
    setError('')
    setSaving(true)
    try {
      const res = await api.reminders.enroll(reminderId, selectedFriend.id, { targetDate })
      if (res.success) {
        onEnrolled({
          enrollmentId: res.data.id,
          friendId: res.data.friendId,
          displayName: selectedFriend.displayName,
          targetDate: res.data.targetDate,
          status: res.data.status,
        })
        onClose()
      } else {
        setError('登録に失敗しました。もう一度お試しください。')
      }
    } catch {
      setError('登録に失敗しました。もう一度お試しください。')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h3 className="text-base font-semibold text-gray-900">友だちを手動で登録</h3>
          <button
            type="button"
            onClick={() => !saving && onClose()}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
            aria-label="閉じる"
          >
            ×
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">友だちを探す</label>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              placeholder="名前で検索"
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
                  {results.map((f) => (
                    <li key={f.id} className="flex items-center justify-between px-3 py-2">
                      <span className="text-sm text-gray-800 truncate">{f.displayName}</span>
                      <button
                        onClick={() => setSelectedFriend(f)}
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

          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">
              基準日 <span className="text-red-500">*</span>
            </label>
            <input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            <p className="text-xs text-gray-400 mt-1">
              ※ 基準日を起点に各ステップのメッセージが送信されます
            </p>
          </div>

          {error && <p className="text-xs text-red-600">{error}</p>}

          <div className="flex gap-2">
            <button
              onClick={handleEnroll}
              disabled={saving}
              className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
              style={{ backgroundColor: '#06C755' }}
            >
              {saving ? '登録中...' : '登録する'}
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
