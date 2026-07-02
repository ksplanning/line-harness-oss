'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { Tag } from '@line-crm/shared'
import Header from '@/components/layout/header'
import { TAG_COLOR_PALETTE, DEFAULT_TAG_COLOR, validateTagName } from '@/lib/tags/tag-form'

function formatDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[1]}/${m[2]}/${m[3]}` : iso.slice(0, 10)
}

export default function TagsPage() {
  const [tags, setTags] = useState<Tag[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState<{ name: string; color: string }>({ name: '', color: DEFAULT_TAG_COLOR })
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)

  // 行内確認: 対象 id を pin。別 id を押すと自動で切替 (window.confirm 不使用)。
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.tags.list()
      if (res.success) setTags(res.data)
      else setError('タグの読み込みに失敗しました')
    } catch {
      setError('タグの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const openCreate = () => {
    setForm({ name: '', color: DEFAULT_TAG_COLOR })
    setFormError('')
    setShowCreate(true)
  }

  const handleCreate = async () => {
    const nameError = validateTagName(form.name)
    if (nameError) {
      setFormError(nameError)
      return
    }
    setFormError('')
    setSaving(true)
    try {
      const res = await api.tags.create({ name: form.name.trim(), color: form.color })
      if (res.success) {
        setShowCreate(false)
        setForm({ name: '', color: DEFAULT_TAG_COLOR })
        await load()
      } else {
        setFormError('作成に失敗しました')
      }
    } catch {
      setFormError('作成に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await api.tags.delete(id)
      setPendingRemoveId(null)
      await load()
    } catch {
      setError('削除に失敗しました')
      setPendingRemoveId(null)
    }
  }

  return (
    <div>
      <Header
        title="タグ管理"
        description="友だちに付けるラベルを管理します。タグで絞り込み配信や分析ができます。"
        action={
          <button
            onClick={openCreate}
            className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            + 新規タグ
          </button>
        }
      />

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* 作成フォーム (インライン展開) */}
      {showCreate && (
        <div className="mb-4 bg-white border border-gray-200 rounded-lg p-5">
          <h3 className="text-sm font-semibold text-gray-800 mb-4">新しいタグを作る</h3>
          <div className="space-y-4 max-w-lg">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                タグ名 <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                placeholder="例: 新規客、VIP、問い合わせ中"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-2">色</label>
              <div className="flex flex-wrap gap-2">
                {TAG_COLOR_PALETTE.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, color: c }))}
                    aria-label={`色 ${c}`}
                    className={`w-6 h-6 rounded-full border-2 transition-colors ${
                      form.color === c ? 'border-gray-900' : 'border-transparent hover:border-gray-400'
                    }`}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </div>

            {formError && <p className="text-xs text-red-600">{formError}</p>}

            <div className="flex gap-2">
              <button
                onClick={handleCreate}
                disabled={saving}
                className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
                style={{ backgroundColor: '#06C755' }}
              >
                {saving ? '作成中...' : '作成'}
              </button>
              <button
                onClick={() => { setShowCreate(false); setFormError('') }}
                className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 一覧 */}
      {loading ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 px-4 py-8 text-center text-gray-400 text-sm">
          読み込み中...
        </div>
      ) : tags.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <svg className="mx-auto h-12 w-12 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a2 2 0 012-2z" />
          </svg>
          <h3 className="mt-4 text-lg font-semibold text-gray-800">まだタグがありません</h3>
          <p className="mt-2 text-sm text-gray-500 leading-relaxed">
            友だちをグループ分けするラベルです。<br />
            例:「新規客」「VIP」「問い合わせ中」など、運用に合わせて作れます。
          </p>
          <button
            onClick={openCreate}
            className="mt-5 px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            ＋ 最初のタグを作る
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <table className="w-full">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">タグ名</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">色</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">作成日</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {tags.map((tag) => (
                <tr key={tag.id}>
                  <td className="px-4 py-3 text-sm font-medium text-gray-900">{tag.name}</td>
                  <td className="px-4 py-3">
                    <span
                      className="inline-block w-4 h-4 rounded-full shrink-0 align-middle"
                      style={{ backgroundColor: tag.color }}
                    />
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-500">{formatDate(tag.createdAt)}</td>
                  <td className="px-4 py-3 text-right">
                    {pendingRemoveId === tag.id ? (
                      <span className="inline-flex items-center gap-1 justify-end">
                        <span className="text-xs text-gray-600">
                          「{tag.name}」を削除しますか？友だちに付いているタグも外れます。
                        </span>
                        <button
                          onClick={() => handleDelete(tag.id)}
                          className="min-h-[36px] px-3 rounded-md text-xs font-medium text-white bg-red-600 hover:bg-red-700"
                        >
                          はい
                        </button>
                        <button
                          onClick={() => setPendingRemoveId(null)}
                          className="min-h-[36px] px-3 rounded-md text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200"
                        >
                          いいえ
                        </button>
                      </span>
                    ) : (
                      <button
                        onClick={() => setPendingRemoveId(tag.id)}
                        className="ml-1 px-2.5 py-1 text-xs font-medium text-red-500 hover:bg-red-50 rounded-md"
                      >
                        削除
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
