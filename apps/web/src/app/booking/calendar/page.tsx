'use client'

import { useState, useEffect, useCallback } from 'react'
import { api, type CalendarConnection } from '@/lib/api'
import Header from '@/components/layout/header'
import { validateConnectForm } from '@/lib/calendar/connect-form'

function formatDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : iso.slice(0, 10)
}

export default function CalendarSettingsPage() {
  const [connections, setConnections] = useState<CalendarConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [showConnect, setShowConnect] = useState(false)
  const [connectForm, setConnectForm] = useState<{ calendarId: string; authType: string; apiKey: string }>({
    calendarId: '',
    authType: 'api_key',
    apiKey: '',
  })
  const [connectError, setConnectError] = useState('')
  const [connecting, setConnecting] = useState(false)

  const [pendingDisconnectId, setPendingDisconnectId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.calendar.list()
      if (res.success) setConnections(res.data)
      else setError('カレンダーの連携状態を読み込めませんでした')
    } catch {
      setError('カレンダーの連携状態を読み込めませんでした')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const openConnect = () => {
    setConnectForm({ calendarId: '', authType: 'api_key', apiKey: '' })
    setConnectError('')
    setShowConnect(true)
  }

  const handleConnect = async () => {
    const err = validateConnectForm(connectForm)
    if (err) {
      setConnectError(err)
      return
    }
    setConnectError('')
    setConnecting(true)
    try {
      const body: { calendarId: string; authType: string; apiKey?: string } = {
        calendarId: connectForm.calendarId.trim(),
        authType: connectForm.authType,
      }
      if (connectForm.authType === 'api_key') body.apiKey = connectForm.apiKey.trim()
      const res = await api.calendar.connect(body)
      if (res.success) {
        setShowConnect(false)
        await load()
      } else {
        setConnectError('連携に失敗しました')
      }
    } catch {
      setConnectError('連携に失敗しました')
    } finally {
      setConnecting(false)
    }
  }

  const handleDisconnect = async (id: string) => {
    try {
      await api.calendar.disconnect(id)
      setPendingDisconnectId(null)
      await load()
    } catch {
      setError('解除に失敗しました')
      setPendingDisconnectId(null)
    }
  }

  const connected = connections.length > 0

  return (
    <div>
      <Header
        title="カレンダー連携"
        description="Google カレンダーと連携すると、予約の空き枠を自動で取得できます。"
      />

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm max-w-2xl">
          {error}
        </div>
      )}

      <div className="max-w-2xl">
        {loading ? (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 px-4 py-8 text-center text-gray-400 text-sm">
            読み込み中...
          </div>
        ) : connected ? (
          <div className="space-y-4">
            {connections.map((conn) => (
              <div key={conn.id} className="bg-white border border-gray-200 rounded-lg p-6">
                <div className="flex items-center gap-2 mb-3">
                  <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-green-100">
                    <svg className="w-3 h-3 text-green-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  </span>
                  <h3 className="text-sm font-semibold text-gray-900">Google カレンダー連携中</h3>
                </div>
                <dl className="text-sm text-gray-600 space-y-1 mb-4">
                  <div className="flex gap-2">
                    <dt className="text-gray-400 w-24 shrink-0">カレンダー</dt>
                    <dd className="font-mono break-all">{conn.calendarId}</dd>
                  </div>
                  <div className="flex gap-2">
                    <dt className="text-gray-400 w-24 shrink-0">連携日</dt>
                    <dd>{formatDate(conn.createdAt)}</dd>
                  </div>
                </dl>
                {pendingDisconnectId === conn.id ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-gray-600">
                      カレンダー連携を解除しますか？予約の空き枠取得が停止されます。
                    </span>
                    <button
                      onClick={() => handleDisconnect(conn.id)}
                      className="min-h-[36px] px-3 rounded-md text-xs font-medium text-white bg-red-600 hover:bg-red-700"
                    >
                      はい
                    </button>
                    <button
                      onClick={() => setPendingDisconnectId(null)}
                      className="min-h-[36px] px-3 rounded-md text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200"
                    >
                      いいえ
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setPendingDisconnectId(conn.id)}
                    className="px-3 py-1.5 min-h-[44px] text-xs font-medium text-red-500 hover:text-red-700 bg-red-50 hover:bg-red-100 rounded-md transition-colors"
                  >
                    解除する
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : showConnect ? (
          <div className="bg-white border border-gray-200 rounded-lg p-6">
            <h3 className="text-sm font-semibold text-gray-800 mb-4">カレンダーを連携する</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  カレンダー ID <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={connectForm.calendarId}
                  onChange={(e) => setConnectForm((f) => ({ ...f, calendarId: e.target.value }))}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  placeholder="your-calendar@gmail.com"
                />
                <p className="text-xs text-gray-400 mt-1">Google カレンダーの設定から確認できます。</p>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">認証方法</label>
                <select
                  value={connectForm.authType}
                  onChange={(e) => setConnectForm((f) => ({ ...f, authType: e.target.value }))}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
                >
                  <option value="api_key">API キー</option>
                  <option value="oauth">OAuth（連携済みアカウント）</option>
                </select>
              </div>
              {connectForm.authType === 'api_key' && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    API キー <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={connectForm.apiKey}
                    onChange={(e) => setConnectForm((f) => ({ ...f, apiKey: e.target.value }))}
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                    placeholder="AIza..."
                  />
                </div>
              )}

              {connectError && <p className="text-xs text-red-600">{connectError}</p>}

              <div className="flex gap-2">
                <button
                  onClick={handleConnect}
                  disabled={connecting}
                  className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
                  style={{ backgroundColor: '#06C755' }}
                >
                  {connecting ? '連携中...' : '連携する'}
                </button>
                <button
                  onClick={() => { setShowConnect(false); setConnectError('') }}
                  className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                >
                  キャンセル
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
            <svg className="mx-auto h-12 w-12 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <h3 className="mt-4 text-lg font-semibold text-gray-800">Google カレンダーが連携されていません</h3>
            <p className="mt-2 text-sm text-gray-500 leading-relaxed">
              連携すると、予約を受けたとき空き枠を自動で確認できます。
            </p>
            <button
              onClick={openConnect}
              className="mt-5 px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
              style={{ backgroundColor: '#06C755' }}
            >
              ＋ カレンダーを連携する
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
