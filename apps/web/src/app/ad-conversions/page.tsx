'use client'

import { useState, useEffect, useCallback } from 'react'
import { api, type AdPlatformItem, type AdConversionLogItem } from '@/lib/api'
import Header from '@/components/layout/header'
import {
  PLATFORM_FIELDS,
  PLATFORM_OPTIONS,
  buildConfigForSave,
  platformDisplay,
  type PlatformName,
} from '@/lib/ad-conversions/config-form'

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
  } catch {
    return iso
  }
}

export default function AdConversionsPage() {
  const [platforms, setPlatforms] = useState<AdPlatformItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // モーダル状態: null=閉 / 'new'=登録 / AdPlatformItem=編集
  const [editing, setEditing] = useState<AdPlatformItem | 'new' | null>(null)
  const [selectedPlatform, setSelectedPlatform] = useState<PlatformName>('meta')
  const [displayName, setDisplayName] = useState('')
  const [configValues, setConfigValues] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)

  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null)

  // テスト送信モーダル
  const [testing, setTesting] = useState<AdPlatformItem | null>(null)
  const [testEventName, setTestEventName] = useState('')
  const [testFriendId, setTestFriendId] = useState('')
  const [testResult, setTestResult] = useState('')
  const [testSending, setTestSending] = useState(false)

  // ログモーダル
  const [logsFor, setLogsFor] = useState<AdPlatformItem | null>(null)
  const [logs, setLogs] = useState<AdConversionLogItem[]>([])
  const [logsLoading, setLogsLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.adPlatforms.list()
      if (res.success) setPlatforms(res.data)
      else setError('広告連携先の読み込みに失敗しました')
    } catch {
      setError('広告連携先の読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const openCreate = () => {
    setSelectedPlatform('meta')
    setDisplayName('')
    setConfigValues({})
    setFormError('')
    setEditing('new')
  }

  const openEdit = (p: AdPlatformItem) => {
    // 編集は platform 変更不可・config 欄は全て空欄スタート (空欄=今のまま維持でマスク破壊を防ぐ)。
    setSelectedPlatform((PLATFORM_OPTIONS as readonly string[]).includes(p.name) ? (p.name as PlatformName) : 'meta')
    setDisplayName(p.displayName ?? '')
    setConfigValues({})
    setFormError('')
    setEditing(p)
  }

  const handleSave = async () => {
    setFormError('')
    const isNew = editing === 'new'
    const config = buildConfigForSave(selectedPlatform, configValues, isNew)
    if (config === null) {
      setFormError('必須の項目をすべて入力してください')
      return
    }
    setSaving(true)
    try {
      const res = isNew
        ? await api.adPlatforms.create({
            name: selectedPlatform,
            displayName: displayName.trim() || undefined,
            config,
          })
        : editing
          ? // 編集: config は入力があった欄だけ (空なら送らず既存維持)。空オブジェクトなら config を省く。
            await api.adPlatforms.update(editing.id, {
              displayName: displayName.trim() || null,
              ...(Object.keys(config).length > 0 ? { config } : {}),
            })
          : null
      if (res && res.success) {
        setEditing(null)
        await load()
      } else {
        setFormError('保存に失敗しました')
      }
    } catch {
      setFormError('保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      const res = await api.adPlatforms.remove(id)
      if (res.success) setPlatforms((prev) => prev.filter((p) => p.id !== id))
      else setError('削除に失敗しました')
      setPendingRemoveId(null)
    } catch {
      setError('削除に失敗しました')
      setPendingRemoveId(null)
    }
  }

  const openTest = (p: AdPlatformItem) => {
    setTestEventName('')
    setTestFriendId('')
    setTestResult('')
    setTesting(p)
  }

  const handleTestSend = async () => {
    if (!testing) return
    if (!testEventName.trim()) {
      setTestResult('イベント名を入力してください')
      return
    }
    setTestSending(true)
    setTestResult('')
    try {
      const res = await api.adPlatforms.test({
        platform: testing.name,
        eventName: testEventName.trim(),
        friendId: testFriendId.trim() || undefined,
      })
      setTestResult(res.success ? res.data.message : 'テスト送信に失敗しました')
    } catch {
      setTestResult('テスト送信に失敗しました')
    } finally {
      setTestSending(false)
    }
  }

  const openLogs = async (p: AdPlatformItem) => {
    setLogsFor(p)
    setLogs([])
    setLogsLoading(true)
    try {
      const res = await api.adPlatforms.logs(p.id)
      if (res.success) setLogs(res.data)
    } catch {
      // silent
    } finally {
      setLogsLoading(false)
    }
  }

  const fields = PLATFORM_FIELDS[selectedPlatform]

  return (
    <div>
      <Header
        title="広告連携"
        description="LINEに登録してくれた人を、Meta（Facebook/Instagram）やGoogleの広告の“成果”として自動で知らせる設定です。広告の管理画面で発行した接続情報を登録します。"
        action={
          <button
            onClick={openCreate}
            className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            ＋ 接続先を追加
          </button>
        }
      />

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
      )}

      {loading ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 px-4 py-8 text-center text-gray-400 text-sm">
          読み込み中...
        </div>
      ) : platforms.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <svg className="mx-auto h-12 w-12 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z" />
          </svg>
          <h3 className="mt-4 text-lg font-semibold text-gray-800">まだ広告連携がありません</h3>
          <p className="mt-2 text-sm text-gray-500 leading-relaxed">
            Meta や Google の広告に、LINE登録を&quot;成果&quot;として<br />
            知らせたいときに接続先を登録します。
          </p>
          <button
            onClick={openCreate}
            className="mt-5 px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            ＋ 最初の接続先を追加
          </button>
        </div>
      ) : (
        <>
          {/* デスクトップ/タブレット: table (sm 以上)。mobile375 では下の card を使う (横溢れ回避 / S-1)。 */}
          <div className="hidden sm:block bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px]">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">広告プラットフォーム</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">表示名</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">状態</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">最終更新</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider sticky right-0 z-10 bg-gray-50 border-l border-gray-200">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {platforms.map((p) => (
                    <tr key={p.id} className="group hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">{platformDisplay(p.name)}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">{p.displayName || <span className="text-gray-400">—</span>}</td>
                      <td className="px-4 py-3 text-sm">
                        {p.isActive ? (
                          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-green-50 text-green-700">有効</span>
                        ) : (
                          <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-500">無効</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-500 tabular-nums">{formatDate(p.updatedAt)}</td>
                      <td className="px-4 py-3 text-right whitespace-nowrap sticky right-0 z-10 bg-white group-hover:bg-gray-50 border-l border-gray-100">
                        {pendingRemoveId === p.id ? (
                          <span className="inline-flex items-center gap-1 justify-end">
                            <span className="text-xs text-gray-600">「{platformDisplay(p.name, p.displayName)}」の連携を消しますか？</span>
                            <button onClick={() => handleDelete(p.id)} className="min-h-[36px] px-3 rounded-md text-xs font-medium text-white bg-red-600 hover:bg-red-700">はい</button>
                            <button onClick={() => setPendingRemoveId(null)} className="min-h-[36px] px-3 rounded-md text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200">いいえ</button>
                          </span>
                        ) : (
                          <>
                            <button onClick={() => openLogs(p)} className="px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-md">ログ</button>
                            <button onClick={() => openTest(p)} className="ml-1 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-md">テスト送信</button>
                            <button onClick={() => openEdit(p)} className="ml-1 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-md">編集</button>
                            <button onClick={() => setPendingRemoveId(p.id)} className="ml-1 px-2.5 py-1 text-xs font-medium text-red-500 hover:bg-red-50 rounded-md">削除</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* mobile375: 縦積みカード (sm 未満)。table の横溢れを構造的に回避 (S-1 / /media と同じ card 方針)。 */}
          <div className="sm:hidden space-y-3">
            {platforms.map((p) => (
              <div key={p.id} className="bg-white rounded-lg shadow-sm border border-gray-200 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 break-words">{platformDisplay(p.name)}</p>
                    {p.displayName && <p className="text-xs text-gray-500 mt-0.5 break-words">{p.displayName}</p>}
                  </div>
                  {p.isActive ? (
                    <span className="shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-green-50 text-green-700">有効</span>
                  ) : (
                    <span className="shrink-0 inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-500">無効</span>
                  )}
                </div>
                <p className="text-xs text-gray-400 mt-2">最終更新 {formatDate(p.updatedAt)}</p>

                {pendingRemoveId === p.id ? (
                  <div className="mt-3 pt-3 border-t border-gray-100">
                    <p className="text-xs text-gray-600 mb-2">「{platformDisplay(p.name, p.displayName)}」の連携を消しますか？</p>
                    <div className="flex gap-2">
                      <button onClick={() => handleDelete(p.id)} className="flex-1 min-h-[36px] rounded-md text-xs font-medium text-white bg-red-600 hover:bg-red-700">はい</button>
                      <button onClick={() => setPendingRemoveId(null)} className="flex-1 min-h-[36px] rounded-md text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200">いいえ</button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-3 pt-3 border-t border-gray-100 grid grid-cols-2 gap-2">
                    <button onClick={() => openLogs(p)} className="min-h-[36px] rounded-md text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200">ログ</button>
                    <button onClick={() => openTest(p)} className="min-h-[36px] rounded-md text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200">テスト送信</button>
                    <button onClick={() => openEdit(p)} className="min-h-[36px] rounded-md text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200">編集</button>
                    <button onClick={() => setPendingRemoveId(p.id)} className="min-h-[36px] rounded-md text-xs font-medium text-red-500 bg-red-50 hover:bg-red-100">削除</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* 登録/編集モーダル */}
      {editing !== null && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" onClick={() => setEditing(null)}>
          <div className="bg-white rounded-lg w-full max-w-lg p-6 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-medium">{editing === 'new' ? '接続先を追加' : '接続先を編集'}</h2>

            {formError && (
              <div className="p-2 rounded bg-red-50 border border-red-200 text-red-700 text-xs">{formError}</div>
            )}

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">広告プラットフォーム <span className="text-red-500">*</span></label>
              {editing === 'new' ? (
                <select
                  value={selectedPlatform}
                  onChange={(e) => { setSelectedPlatform(e.target.value as PlatformName); setConfigValues({}) }}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
                >
                  {PLATFORM_OPTIONS.map((name) => (
                    <option key={name} value={name}>{platformDisplay(name)}</option>
                  ))}
                </select>
              ) : (
                <input value={platformDisplay(selectedPlatform)} readOnly className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm bg-gray-100 text-gray-500" />
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">表示名（任意）</label>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                placeholder="例: 本番用 / テスト用"
              />
            </div>

            {editing !== 'new' && (
              <p className="text-xs text-gray-500">既に設定済みです。変えるときだけ新しい値を入力してください（空欄なら今のまま）。</p>
            )}

            {fields.map((f) => (
              <div key={f.key}>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  {f.label} {editing === 'new' && !f.optional && <span className="text-red-500">*</span>}
                </label>
                <input
                  type={f.secret ? 'password' : 'text'}
                  value={configValues[f.key] ?? ''}
                  onChange={(e) => setConfigValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  placeholder={editing !== 'new' && f.secret ? '●●●●（設定済み）' : ''}
                  autoComplete="off"
                />
                <p className="text-xs text-gray-400 mt-1">{f.hint}</p>
              </div>
            ))}

            <div className="flex gap-2 pt-2">
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50"
                style={{ backgroundColor: '#06C755' }}
              >
                {saving ? '保存中...' : '保存'}
              </button>
              <button onClick={() => setEditing(null)} className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg">キャンセル</button>
            </div>
          </div>
        </div>
      )}

      {/* テスト送信モーダル */}
      {testing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" onClick={() => setTesting(null)}>
          <div className="bg-white rounded-lg w-full max-w-md p-6 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-medium">テスト送信 — {platformDisplay(testing.name, testing.displayName)}</h2>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">イベント名 <span className="text-red-500">*</span></label>
              <input
                value={testEventName}
                onChange={(e) => setTestEventName(e.target.value)}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                placeholder="例: 友だち追加"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">友だちID（任意）</label>
              <input
                value={testFriendId}
                onChange={(e) => setTestFriendId(e.target.value)}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                placeholder="空なら接続が有効かだけ確認します"
              />
              <p className="text-xs text-amber-600 mt-1">友だちIDを入れると、その人が実際に広告の成果として送られます。テストは慎重に。</p>
            </div>
            {testResult && (
              <div className="p-3 rounded bg-gray-50 border border-gray-200 text-sm text-gray-700">{testResult}</div>
            )}
            <div className="flex gap-2 pt-2">
              <button onClick={handleTestSend} disabled={testSending} className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50" style={{ backgroundColor: '#06C755' }}>
                {testSending ? '送信中...' : 'テスト送信'}
              </button>
              <button onClick={() => setTesting(null)} className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg">閉じる</button>
            </div>
          </div>
        </div>
      )}

      {/* 送信ログモーダル */}
      {logsFor && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50" onClick={() => setLogsFor(null)}>
          <div className="bg-white rounded-lg w-full max-w-2xl p-6 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-medium">送信ログ — {platformDisplay(logsFor.name, logsFor.displayName)}</h2>
            {logsLoading ? (
              <div className="py-8 text-center text-gray-400 text-sm">読み込み中...</div>
            ) : logs.length === 0 ? (
              <div className="py-8 text-center text-gray-500 text-sm">まだ送信ログがありません</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[480px] text-sm">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500">時刻</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500">イベント</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500">状態</th>
                      <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500">エラー内容</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {logs.map((l) => (
                      <tr key={l.id}>
                        <td className="px-3 py-2 text-gray-500 tabular-nums whitespace-nowrap">{l.createdAt}</td>
                        <td className="px-3 py-2 text-gray-900">{l.eventName}</td>
                        <td className="px-3 py-2">
                          {l.status === 'success' || l.status === 'sent' ? (
                            <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-green-50 text-green-700">成功</span>
                          ) : (
                            <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-red-50 text-red-600">失敗</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-gray-500">{l.errorMessage || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex justify-end pt-2">
              <button onClick={() => setLogsFor(null)} className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg">閉じる</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
