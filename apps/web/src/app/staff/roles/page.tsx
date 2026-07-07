'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { api } from '@/lib/api'
import { ROLE_TEMPLATES, FEATURE_KEYS, FEATURE_LABELS } from '@line-crm/shared'
import type { Role } from '@line-crm/shared'
import { PermissionMatrix, featuresToRecord } from '@/components/roles/permission-matrix'

type Mode = { kind: 'list' } | { kind: 'create' } | { kind: 'edit'; role: Role }

const EMPTY: Record<string, boolean> = Object.fromEntries(FEATURE_KEYS.map((f) => [f, false]))

export default function RolesPage() {
  const [roles, setRoles] = useState<Role[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<Mode>({ kind: 'list' })

  // editor state
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [matrix, setMatrix] = useState<Record<string, boolean>>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [editorError, setEditorError] = useState('')

  // delete/reassign state
  const [deleting, setDeleting] = useState<Role | null>(null)
  const [reassignTo, setReassignTo] = useState<string>('') // '' = built-in 復帰(null)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.roles.list()
      if (res.success) setRoles(res.data)
      else setError(res.error ?? 'ロールの読み込みに失敗しました')
    } catch {
      setError('ロールの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const startCreate = () => {
    setName('')
    setDescription('')
    setMatrix({ ...EMPTY })
    setEditorError('')
    setMode({ kind: 'create' })
  }

  const applyTemplate = (templateId: string) => {
    const tpl = ROLE_TEMPLATES.find((t) => t.id === templateId)
    if (!tpl) return
    if (!name) setName(tpl.name)
    setMatrix(featuresToRecord(tpl.features))
  }

  const startEdit = (role: Role) => {
    setName(role.name)
    setDescription(role.description ?? '')
    setMatrix(featuresToRecord(role.features))
    setEditorError('')
    setMode({ kind: 'edit', role })
  }

  const toggle = (feature: string, allowed: boolean) =>
    setMatrix((m) => ({ ...m, [feature]: allowed }))

  const handleSave = async () => {
    if (!name.trim()) {
      setEditorError('ロール名を入力してください')
      return
    }
    setSaving(true)
    setEditorError('')
    try {
      if (mode.kind === 'create') {
        const res = await api.roles.create({ name: name.trim(), description, permissions: matrix })
        if (!res.success) {
          setEditorError(res.error ?? '作成に失敗しました')
          setSaving(false)
          return
        }
      } else if (mode.kind === 'edit') {
        const upd = await api.roles.update(mode.role.id, { name: name.trim(), description })
        if (!upd.success) {
          setEditorError(upd.error ?? '更新に失敗しました')
          setSaving(false)
          return
        }
        const perm = await api.roles.setPermissions(mode.role.id, matrix)
        if (!perm.success) {
          setEditorError(perm.error ?? '権限の保存に失敗しました')
          setSaving(false)
          return
        }
      }
      setMode({ kind: 'list' })
      await load()
    } catch {
      setEditorError('保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleting) return
    try {
      const res = await api.roles.delete(deleting.id, reassignTo || null)
      if (!res.success) {
        setError(res.error ?? '削除に失敗しました')
      }
      setDeleting(null)
      setReassignTo('')
      await load()
    } catch {
      setError('削除に失敗しました')
    }
  }

  // ─── エディタ (作成/編集) ───
  if (mode.kind === 'create' || mode.kind === 'edit') {
    const onCount = FEATURE_KEYS.filter((f) => matrix[f]).length
    return (
      <div>
        <Header title={mode.kind === 'create' ? 'ロールを作る' : 'ロールを編集'} />
        <div className="max-w-2xl space-y-5">
          {mode.kind === 'create' && (
            <div className="p-4 bg-white border border-gray-200 rounded-lg">
              <p className="text-sm font-semibold text-gray-900 mb-3">テンプレートから作る（後で調整できます）</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {ROLE_TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => applyTemplate(t.id)}
                    className="text-left px-3 py-2 border border-gray-200 rounded-lg hover:border-green-400 hover:bg-green-50 transition-colors"
                  >
                    <span className="block text-sm font-medium text-gray-900">{t.name}</span>
                    <span className="block text-xs text-gray-400 mt-0.5">{t.description}</span>
                  </button>
                ))}
              </div>
              <p className="text-xs text-gray-400 mt-2">白紙から作る場合は下のトグルを直接操作してください。</p>
            </div>
          )}

          <div className="p-4 bg-white border border-gray-200 rounded-lg space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">ロール名 *</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例: チャット対応のみ"
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">説明（任意）</label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="例: お客様対応だけの外注さん"
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-semibold text-gray-900">できることを選ぶ</p>
              <span className="text-xs text-gray-400">{onCount} / 19 機能ON</span>
            </div>
            <PermissionMatrix value={matrix} onChange={toggle} disabled={saving} />
          </div>

          {editorError && <p className="text-sm text-red-600">{editorError}</p>}

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !name.trim()}
              className="px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity hover:opacity-90"
              style={{ backgroundColor: '#06C755' }}
            >
              {saving ? '保存中...' : '保存'}
            </button>
            <button
              type="button"
              onClick={() => setMode({ kind: 'list' })}
              className="px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              キャンセル
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ─── 一覧 ───
  return (
    <div>
      <Header
        title="ロール（権限）管理"
        action={
          <div className="flex items-center gap-2">
            <Link
              href="/staff"
              className="px-3 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
            >
              スタッフ一覧へ
            </Link>
            <button
              onClick={startCreate}
              className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
              style={{ backgroundColor: '#06C755' }}
            >
              + ロールを作る
            </button>
          </div>
        }
      />

      <p className="mb-4 text-sm text-gray-500">
        役割（ロール）を作って、スタッフごとに「できること」を機能単位で ON/OFF できます。
        設定した権限は、画面から隠すだけでなくサーバー側でも拒否されます。
      </p>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
      )}

      {loading ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-8 text-center text-sm text-gray-400">
          読み込み中...
        </div>
      ) : roles.length === 0 ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
          <p className="text-gray-500 text-sm">
            まだロールがありません。「+ ロールを作る」からテンプレートを選んで作れます。
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {roles.map((role) => (
            <div key={role.id} className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900">{role.name}</p>
                  {role.description && <p className="text-xs text-gray-400 mt-0.5">{role.description}</p>}
                  <p className="text-xs text-gray-500 mt-1">
                    {role.assignedCount ?? 0} 名に割り当て・{role.features.length} 機能ON
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {role.features.slice(0, 8).map((f) => (
                      <span key={f} className="inline-block px-1.5 py-0.5 text-[11px] bg-gray-100 text-gray-600 rounded">
                        {FEATURE_LABELS[f as keyof typeof FEATURE_LABELS] ?? f}
                      </span>
                    ))}
                    {role.features.length > 8 && (
                      <span className="text-[11px] text-gray-400">+{role.features.length - 8}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => startEdit(role)}
                    className="px-2.5 py-1 text-xs font-medium text-green-700 bg-white border border-green-300 rounded hover:bg-green-50 transition-colors"
                  >
                    編集
                  </button>
                  <button
                    onClick={() => { setDeleting(role); setReassignTo('') }}
                    className="px-2.5 py-1 text-xs font-medium text-red-600 bg-white border border-red-200 rounded hover:bg-red-50 transition-colors"
                  >
                    削除
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 削除 + 再割当 (行内確認 / native confirm 不使用 / M-16) */}
      {deleting && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setDeleting(null) }}
        >
          <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-6">
            <h2 className="text-base font-semibold text-gray-900 mb-1">ロールを削除</h2>
            <p className="text-xs text-gray-500 mb-4">「{deleting.name}」を削除します。</p>
            {(deleting.assignedCount ?? 0) > 0 && (
              <div className="mb-4">
                <p className="text-xs text-gray-700 mb-1">
                  このロールは {deleting.assignedCount} 名に割り当てられています。付け替え先を選んでください。
                </p>
                <select
                  value={reassignTo}
                  onChange={(e) => setReassignTo(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
                >
                  <option value="">元の役割（オーナー/管理者/スタッフ）に戻す</option>
                  {roles.filter((r) => r.id !== deleting.id).map((r) => (
                    <option key={r.id} value={r.id}>{r.name} に付け替える</option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex items-center gap-3">
              <button
                onClick={handleDelete}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 transition-colors"
              >
                削除する
              </button>
              <button
                onClick={() => setDeleting(null)}
                className="px-4 py-2 text-sm font-medium text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
