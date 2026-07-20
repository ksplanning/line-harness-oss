'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'

interface Friend {
  id: string
  displayName: string
  pictureUrl: string | null
}

interface TestRecipientsSettingProps {
  accountId: string
}

export default function TestRecipientsSetting({ accountId }: TestRecipientsSettingProps) {
  const [recipients, setRecipients] = useState<Friend[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<Friend[]>([])
  const [searching, setSearching] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.accountSettings.getTestRecipients(accountId)
      if (res.success) {
        setRecipients(res.data)
      } else {
        setRecipients([])
        setError(res.error || 'テスト送信先を読み込めませんでした')
      }
    } catch {
      setRecipients([])
      setError('テスト送信先を読み込めませんでした')
    }
    finally { setLoading(false) }
  }, [accountId])

  useEffect(() => { load() }, [load])

  // Debounced friend search
  useEffect(() => {
    const query = search.trim()
    if (query.length < 2) {
      setSearchResults([])
      setSearching(false)
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      setSearching(true)
      setError('')
      try {
        // The worker now ranks friends by match quality (exact > prefix >
        // word-start > generic substring) before created_at DESC. So
        // `limit: 10` here gives 10 best matches across the entire account,
        // not "10 newest containing the substring". Fixes the long-standing
        // issue where the operator's own friend record (day-one) was buried
        // by recently-added friends sharing the same substring.
        // includeTags=false: tags not rendered here; skipping the per-row
        // tag fetch turns ~11 D1 reads/keystroke into 2 (count + list).
        const res = await api.friends.list({ search: query, accountId, limit: 10, includeTags: false })
        if (cancelled) return
        if (res.success) {
          const existing = new Set(recipients.map(r => r.id))
          const items = (res.data as unknown as { items: Friend[] }).items ?? []
          setSearchResults(
            items
              .filter((f: Friend) => !existing.has(f.id))
              .map((f: Friend) => ({ id: f.id, displayName: f.displayName, pictureUrl: f.pictureUrl }))
          )
        } else {
          setSearchResults([])
          setError(res.error || '友だちを検索できませんでした')
        }
      } catch {
        if (!cancelled) {
          setSearchResults([])
          setError('友だちを検索できませんでした')
        }
      } finally {
        if (!cancelled) setSearching(false)
      }
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [search, accountId, recipients])

  const saveRecipients = async (updated: Friend[], previous: Friend[]) => {
    if (saving) return false
    setRecipients(updated)
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      const response = await api.accountSettings.updateTestRecipients(accountId, updated.map(r => r.id))
      if (!response.success) throw new Error(response.error || 'テスト送信先を保存できませんでした')
      setSaved(true)
      return true
    } catch (saveError) {
      setRecipients(previous)
      setError(saveError instanceof Error && saveError.message
        ? saveError.message
        : 'テスト送信先を保存できませんでした')
      return false
    } finally {
      setSaving(false)
    }
  }

  const addRecipient = async (friend: Friend) => {
    const previous = recipients
    const updated = [...previous, friend]
    setSearch('')
    setSearchResults([])
    await saveRecipients(updated, previous)
  }

  const removeRecipient = async (friendId: string) => {
    const previous = recipients
    const updated = previous.filter(r => r.id !== friendId)
    await saveRecipients(updated, previous)
  }

  if (loading) return <p className="text-xs text-gray-400">読み込み中...</p>

  return (
    <div className="mt-3 pt-3 border-t border-gray-100">
      <h4 className="text-xs font-semibold text-gray-600 mb-2">テスト送信先</h4>
      <p className="text-xs text-gray-400 mb-2">
        テスト送信は、ここで選んだ自分のアカウントだけに届きます。
      </p>

      {/* Current recipients */}
      {recipients.length > 0 ? (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {recipients.map(r => (
            <span key={r.id} className="inline-flex items-center gap-1 px-2 py-1 bg-blue-50 text-blue-700 rounded-full text-xs">
              {r.pictureUrl && <img src={r.pictureUrl} alt="" className="w-4 h-4 rounded-full" />}
              {r.displayName}
              <button
                type="button"
                aria-label={`${r.displayName}を解除`}
                onClick={() => void removeRecipient(r.id)}
                disabled={saving}
                className="text-blue-400 hover:text-blue-600 ml-0.5 disabled:opacity-50"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-xs text-amber-600 mb-2">テスト送信先はまだ設定されていません</p>
      )}

      {error && <p role="alert" className="text-xs text-red-600 mb-2">{error}</p>}
      {saved && !error && <p role="status" className="text-xs text-green-600 mb-2">保存しました</p>}

      {/* Search to add */}
      <div className="relative">
        <input
          type="text"
          aria-label="テスト送信先を検索"
          placeholder="友だちを検索して追加..."
          value={search}
          onChange={e => { setSearch(e.target.value); setSaved(false) }}
          disabled={saving}
          className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-400 disabled:bg-gray-50"
        />
        {searching && <span className="absolute right-2 top-1.5 text-xs text-gray-400">検索中...</span>}
        {saving && <span className="absolute right-2 top-1.5 text-xs text-green-500">保存中...</span>}

        {searchResults.length > 0 && (
          <ul className="absolute z-10 top-full left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-40 overflow-y-auto">
            {searchResults.map(f => (
              <li key={f.id}>
                <button
                  type="button"
                  aria-label={`${f.displayName}を追加`}
                  onClick={() => void addRecipient(f)}
                  disabled={saving}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 text-left text-xs disabled:opacity-50"
                >
                  {f.pictureUrl ? (
                    <img src={f.pictureUrl} alt="" className="w-5 h-5 rounded-full" />
                  ) : (
                    <div className="w-5 h-5 rounded-full bg-gray-200" />
                  )}
                  {f.displayName}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
