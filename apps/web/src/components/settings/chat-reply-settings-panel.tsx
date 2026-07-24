'use client'

import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'

export interface ChatReplySettingsPanelProps {
  accountId: string | null
}

const GENERIC_ERROR = '設定を保存できませんでした。もう一度お試しください。'

export default function ChatReplySettingsPanel({
  accountId,
}: ChatReplySettingsPanelProps) {
  const [defaultReplyName, setDefaultReplyName] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const requestVersion = useRef(0)
  const activeAccount = useRef<string | null>(accountId)
  activeAccount.current = accountId

  const isCurrentRequest = (version: number, currentAccountId: string) => (
    requestVersion.current === version
    && activeAccount.current === currentAccountId
  )

  useEffect(() => {
    const version = ++requestVersion.current
    setDefaultReplyName('')
    setLoading(false)
    setSaving(false)
    setError(null)
    setNotice(null)

    if (!accountId) return

    setLoading(true)
    void api.accountSettings.getChatReplySettings(accountId)
      .then((response) => {
        if (!isCurrentRequest(version, accountId)) return
        if (!response.success) {
          setError(response.error || GENERIC_ERROR)
          return
        }
        setDefaultReplyName(response.data.defaultReplyName)
      })
      .catch(() => {
        if (isCurrentRequest(version, accountId)) setError(GENERIC_ERROR)
      })
      .finally(() => {
        if (isCurrentRequest(version, accountId)) setLoading(false)
      })
  }, [accountId])

  const save = async () => {
    const currentAccountId = accountId
    if (!currentAccountId || loading || saving) return
    const version = requestVersion.current
    setSaving(true)
    setError(null)
    setNotice(null)

    try {
      const updated = await api.accountSettings.updateChatReplySettings(
        currentAccountId,
        defaultReplyName,
      )
      if (!isCurrentRequest(version, currentAccountId)) return
      if (!updated.success) {
        setError(updated.error || GENERIC_ERROR)
        return
      }

      const refreshed = await api.accountSettings.getChatReplySettings(
        currentAccountId,
      )
      if (!isCurrentRequest(version, currentAccountId)) return
      if (!refreshed.success) {
        setError(refreshed.error || GENERIC_ERROR)
        return
      }
      setDefaultReplyName(refreshed.data.defaultReplyName)
      setNotice('返信者名を保存しました。')
    } catch {
      if (isCurrentRequest(version, currentAccountId)) setError(GENERIC_ERROR)
    } finally {
      if (isCurrentRequest(version, currentAccountId)) setSaving(false)
    }
  }

  if (!accountId) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        先に LINE アカウントを選択してください。
      </div>
    )
  }

  return (
    <div data-testid="chat-reply-settings-panel">
      <section className="rounded-lg border border-gray-200 bg-white p-4">
        <h2 className="text-base font-semibold text-gray-900">
          チャット返信の名乗り
        </h2>
        <p className="mt-1 text-sm text-gray-600">
          空欄で保存すると、返信文の先頭に名乗りを付けません。
        </p>

        {loading ? (
          <p className="mt-4 text-sm text-gray-500">設定を読み込んでいます...</p>
        ) : (
          <div className="mt-4 space-y-4">
            <div>
              <label
                htmlFor="chat-reply-default-name"
                className="mb-1 block text-sm font-medium text-gray-700"
              >
                既定の返信者名
              </label>
              <input
                id="chat-reply-default-name"
                type="text"
                value={defaultReplyName}
                onChange={(event) => {
                  setDefaultReplyName(event.target.value)
                  setNotice(null)
                }}
                placeholder="例：受付係"
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </div>

            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="rounded-lg bg-[#06C755] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {saving ? '保存中...' : '返信者名を保存'}
            </button>
          </div>
        )}

        {notice && <p role="status" className="mt-4 text-sm text-green-700">{notice}</p>}
        {error && <p role="alert" className="mt-4 text-sm text-red-600">{error}</p>}
      </section>
    </div>
  )
}
