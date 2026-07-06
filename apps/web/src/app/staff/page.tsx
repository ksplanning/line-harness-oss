'use client'
import { useState, useEffect } from 'react'
import Header from '@/components/layout/header'
import { fetchApi } from '@/lib/api'
import type { ApiResponse } from '@line-crm/shared'
import type { StaffMember } from '@line-crm/shared'
import { LockIcon, EyeIcon, EyeOffIcon } from '@/components/shared/icons'

type NewApiKey = { apiKey: string; staffId: string }

function RoleBadge({ role }: { role: string }) {
  const styles =
    role === 'owner'
      ? 'bg-yellow-100 text-yellow-800'
      : role === 'admin'
        ? 'bg-blue-100 text-blue-800'
        : 'bg-gray-100 text-gray-600'
  const label =
    role === 'owner' ? 'オーナー' : role === 'admin' ? '管理者' : 'スタッフ'
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${styles}`}>
      {label}
    </span>
  )
}

function maskKey(key: string): string {
  if (!key || key.length <= 8) return '••••••••'
  return key.slice(0, 4) + '••••••••' + key.slice(-4)
}

export default function StaffPage() {
  const [members, setMembers] = useState<StaffMember[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // New API key banner
  const [newKey, setNewKey] = useState<NewApiKey | null>(null)
  const [copied, setCopied] = useState(false)

  // Create form
  const [showForm, setShowForm] = useState(false)
  const [formName, setFormName] = useState('')
  const [formEmail, setFormEmail] = useState('')
  const [formRole, setFormRole] = useState<'admin' | 'staff'>('staff')
  const [formLoading, setFormLoading] = useState(false)
  const [formError, setFormError] = useState('')

  // ID/PASS 設定モーダル (batch F)
  const [credStaff, setCredStaff] = useState<StaffMember | null>(null)
  const [credLoginId, setCredLoginId] = useState('')
  const [credPassword, setCredPassword] = useState('')
  const [credPassword2, setCredPassword2] = useState('')
  const [credShowPw, setCredShowPw] = useState(false)
  const [credLoading, setCredLoading] = useState(false)
  const [credError, setCredError] = useState('')

  const loadMembers = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetchApi<ApiResponse<StaffMember[]>>('/api/staff')
      if (res.success) {
        setMembers(res.data)
      } else {
        setError(res.error ?? 'スタッフの読み込みに失敗しました')
      }
    } catch {
      setError('スタッフの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadMembers()
  }, [])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormLoading(true)
    setFormError('')
    try {
      const body: { name: string; role: 'admin' | 'staff'; email?: string } = {
        name: formName,
        role: formRole,
      }
      if (formEmail) body.email = formEmail

      const res = await fetchApi<ApiResponse<StaffMember & { apiKey?: string }>>('/api/staff', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      if (res.success) {
        if (res.data.apiKey) {
          setNewKey({ apiKey: res.data.apiKey, staffId: res.data.id })
        }
        setFormName('')
        setFormEmail('')
        setFormRole('staff')
        setShowForm(false)
        await loadMembers()
      } else {
        setFormError(res.error ?? '作成に失敗しました')
      }
    } catch {
      setFormError('作成に失敗しました')
    } finally {
      setFormLoading(false)
    }
  }

  const handleToggleActive = async (member: StaffMember) => {
    try {
      await fetchApi<ApiResponse<StaffMember>>(`/api/staff/${member.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: !member.isActive }),
      })
      await loadMembers()
    } catch {
      setError('更新に失敗しました')
    }
  }

  const handleRegenerateKey = async (member: StaffMember) => {
    if (!confirm(`${member.name} のAPIキーを再生成しますか？\n現在のキーは無効になります。`)) return
    try {
      const res = await fetchApi<ApiResponse<{ apiKey: string }>>(`/api/staff/${member.id}/regenerate-key`, {
        method: 'POST',
      })
      if (res.success) {
        setNewKey({ apiKey: res.data.apiKey, staffId: member.id })
      } else {
        setError(res.error ?? 'キー再生成に失敗しました')
      }
    } catch {
      setError('キー再生成に失敗しました')
    }
  }

  const handleDelete = async (member: StaffMember) => {
    if (!confirm(`${member.name} を削除しますか？\nこの操作は元に戻せません。`)) return
    try {
      await fetchApi<ApiResponse<null>>(`/api/staff/${member.id}`, { method: 'DELETE' })
      await loadMembers()
    } catch {
      setError('削除に失敗しました')
    }
  }

  const handleCopy = async () => {
    if (!newKey) return
    await navigator.clipboard.writeText(newKey.apiKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  // ── ID/PASS 設定 (batch F) ──
  const openCred = (member: StaffMember) => {
    setCredStaff(member)
    setCredLoginId(member.loginId ?? '')
    setCredPassword('')
    setCredPassword2('')
    setCredShowPw(false)
    setCredError('')
  }

  const handleSaveCred = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!credStaff) return
    setCredError('')
    // パスワードを入れる場合は確認一致 + 8文字以上。
    if (credPassword || credPassword2) {
      if (credPassword.length < 8) { setCredError('パスワードは8文字以上にしてください'); return }
      if (credPassword !== credPassword2) { setCredError('パスワード（確認）が一致しません'); return }
    }
    setCredLoading(true)
    try {
      // ログインID を変更したときだけ更新。
      const nextId = credLoginId.trim()
      if (nextId && nextId !== (credStaff.loginId ?? '')) {
        const r = await fetchApi<ApiResponse<StaffMember>>(`/api/staff/${credStaff.id}/login-id`, {
          method: 'PUT',
          body: JSON.stringify({ loginId: nextId }),
        })
        if (!r.success) { setCredError(r.error ?? 'ログインIDの設定に失敗しました'); setCredLoading(false); return }
      }
      // パスワードを入れたときだけ更新。
      if (credPassword) {
        const r = await fetchApi<ApiResponse<{ id: string }>>(`/api/staff/${credStaff.id}/password`, {
          method: 'PUT',
          body: JSON.stringify({ password: credPassword }),
        })
        if (!r.success) { setCredError(r.error ?? 'パスワードの設定に失敗しました'); setCredLoading(false); return }
      }
      setCredStaff(null)
      await loadMembers()
    } catch {
      setCredError('設定に失敗しました')
    } finally {
      setCredLoading(false)
    }
  }

  const handleUnlock = async (member: StaffMember) => {
    try {
      await fetchApi<ApiResponse<StaffMember>>(`/api/staff/${member.id}/unlock`, { method: 'POST' })
      await loadMembers()
    } catch {
      setError('ロック解除に失敗しました')
    }
  }

  return (
    <div>
      <Header
        title="スタッフ管理"
        action={
          <button
            onClick={() => setShowForm(!showForm)}
            className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            + スタッフを追加
          </button>
        }
      />

      {/* New API key banner */}
      {newKey && (
        <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg">
          <p className="text-sm font-medium text-green-800 mb-2">
            APIキーが発行されました。このキーは一度しか表示されません。
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-white border border-green-200 rounded px-3 py-2 font-mono break-all">
              {newKey.apiKey}
            </code>
            <button
              onClick={handleCopy}
              className="shrink-0 px-3 py-2 text-xs font-medium text-green-700 bg-white border border-green-300 rounded-lg hover:bg-green-50 transition-colors"
            >
              {copied ? 'コピー済み' : 'コピー'}
            </button>
            <button
              onClick={() => setNewKey(null)}
              className="shrink-0 px-3 py-2 text-xs font-medium text-gray-500 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
            >
              閉じる
            </button>
          </div>
        </div>
      )}

      {/* Create form */}
      {showForm && (
        <div className="mb-6 p-5 bg-white border border-gray-200 rounded-lg shadow-sm">
          <h2 className="text-sm font-semibold text-gray-900 mb-4">新しいスタッフを追加</h2>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">名前 *</label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  required
                  placeholder="田中 太郎"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">メールアドレス</label>
                <input
                  type="email"
                  value={formEmail}
                  onChange={(e) => setFormEmail(e.target.value)}
                  placeholder="taro@example.com"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">ロール *</label>
                <select
                  value={formRole}
                  onChange={(e) => setFormRole(e.target.value as 'admin' | 'staff')}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
                >
                  <option value="staff">スタッフ</option>
                  <option value="admin">管理者</option>
                </select>
              </div>
            </div>
            {formError && (
              <p className="text-sm text-red-600">{formError}</p>
            )}
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={formLoading || !formName}
                className="px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity hover:opacity-90"
                style={{ backgroundColor: '#06C755' }}
              >
                {formLoading ? '作成中...' : '作成'}
              </button>
              <button
                type="button"
                onClick={() => { setShowForm(false); setFormError('') }}
                className="px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                キャンセル
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Staff list */}
      {loading ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="px-4 py-4 border-b border-gray-100 flex items-center gap-4 animate-pulse">
              <div className="flex-1 space-y-2">
                <div className="h-3 bg-gray-200 rounded w-32" />
                <div className="h-2 bg-gray-100 rounded w-48" />
              </div>
              <div className="h-5 bg-gray-100 rounded-full w-16" />
              <div className="h-5 bg-gray-100 rounded w-24" />
              <div className="h-8 bg-gray-100 rounded w-20" />
            </div>
          ))}
        </div>
      ) : members.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
          <p className="text-gray-500 text-sm">スタッフがいません。「+ スタッフを追加」から追加してください。</p>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">名前</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider hidden sm:table-cell">メール</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">ロール</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider hidden md:table-cell">APIキー</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">状態</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {members.map((member) => (
                <tr key={member.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-4 py-3 font-medium text-gray-900">
                    {member.name}
                    <span className="block text-xs font-normal text-gray-400">
                      {member.loginId ? `ID: ${member.loginId}` : 'ログインID未設定'}
                      {member.hasPassword ? '・パスワード設定済み' : '・パスワード未設定'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-500 hidden sm:table-cell">{member.email ?? '—'}</td>
                  <td className="px-4 py-3">
                    <RoleBadge role={member.role} />
                  </td>
                  <td className="px-4 py-3 text-gray-400 font-mono text-xs hidden md:table-cell">
                    {maskKey(member.apiKey ?? '')}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center gap-1.5 text-xs ${member.isActive ? 'text-green-700' : 'text-gray-400'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${member.isActive ? 'bg-green-500' : 'bg-gray-300'}`} />
                      {member.isActive ? '有効' : '無効'}
                    </span>
                    {member.locked && (
                      <span className="mt-1 inline-flex items-center gap-1 text-xs text-red-600">
                        <LockIcon /> ログインロック中
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2 flex-wrap">
                      <button
                        onClick={() => openCred(member)}
                        className="px-2.5 py-1 text-xs font-medium text-green-700 bg-white border border-green-300 rounded hover:bg-green-50 transition-colors"
                      >
                        ログイン設定
                      </button>
                      {member.locked && (
                        <button
                          onClick={() => handleUnlock(member)}
                          className="px-2.5 py-1 text-xs font-medium text-orange-600 bg-white border border-orange-200 rounded hover:bg-orange-50 transition-colors"
                        >
                          ロック解除
                        </button>
                      )}
                      {member.role !== 'owner' && (
                        <>
                          <button
                            onClick={() => handleToggleActive(member)}
                            className="px-2.5 py-1 text-xs font-medium text-gray-600 bg-white border border-gray-300 rounded hover:bg-gray-50 transition-colors"
                          >
                            {member.isActive ? '無効化' : '有効化'}
                          </button>
                          <button
                            onClick={() => handleRegenerateKey(member)}
                            className="px-2.5 py-1 text-xs font-medium text-blue-600 bg-white border border-blue-200 rounded hover:bg-blue-50 transition-colors"
                          >
                            キー再生成
                          </button>
                          <button
                            onClick={() => handleDelete(member)}
                            className="px-2.5 py-1 text-xs font-medium text-red-600 bg-white border border-red-200 rounded hover:bg-red-50 transition-colors"
                          >
                            削除
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ID/PASS 設定モーダル (batch F)。ログインID + パスワードを設定/再設定する。平文は保存も表示もしない。 */}
      {credStaff && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setCredStaff(null) }}
        >
          <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-1">ログイン設定</h2>
            <p className="text-xs text-gray-500 mb-4">{credStaff.name} さんのログインIDとパスワード</p>
            <form onSubmit={handleSaveCred} className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">ログインID</label>
                <input
                  type="text"
                  value={credLoginId}
                  onChange={(e) => setCredLoginId(e.target.value)}
                  placeholder="半角英数字と . _ -（3文字以上）"
                  autoComplete="off"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  新しいパスワード{credStaff.hasPassword ? '（変えるときだけ入力）' : ''}
                </label>
                <div className="relative">
                  <input
                    type={credShowPw ? 'text' : 'password'}
                    value={credPassword}
                    onChange={(e) => setCredPassword(e.target.value)}
                    placeholder="8文字以上を推奨"
                    autoComplete="new-password"
                    className="w-full px-3 py-2 pr-10 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                  <button
                    type="button"
                    onClick={() => setCredShowPw((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 inline-flex items-center justify-center text-gray-400 hover:text-gray-600"
                    aria-label={credShowPw ? 'パスワードを隠す' : 'パスワードを表示'}
                  >
                    {credShowPw ? <EyeOffIcon /> : <EyeIcon />}
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">パスワード（確認）</label>
                <input
                  type={credShowPw ? 'text' : 'password'}
                  value={credPassword2}
                  onChange={(e) => setCredPassword2(e.target.value)}
                  placeholder="もう一度入力"
                  autoComplete="new-password"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              {credError && <p className="text-sm text-red-600">{credError}</p>}
              <div className="flex items-center gap-3 pt-1">
                <button
                  type="submit"
                  disabled={credLoading}
                  className="px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity hover:opacity-90"
                  style={{ backgroundColor: '#06C755' }}
                >
                  {credLoading ? '保存中...' : '保存'}
                </button>
                <button
                  type="button"
                  onClick={() => setCredStaff(null)}
                  className="px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
                >
                  キャンセル
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
