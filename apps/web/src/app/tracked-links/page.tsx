'use client'

import { useState, useEffect, useCallback } from 'react'
import { api, type TrackedLinkItem } from '@/lib/api'
import type { Tag } from '@line-crm/shared'
import Header from '@/components/layout/header'
import { validateLinkName, validateOriginalUrl } from '@/lib/tracked-links/link-form'

export default function TrackedLinksPage() {
  const [links, setLinks] = useState<TrackedLinkItem[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // null=閉 / 'new'=作成 / TrackedLinkItem=編集
  const [editing, setEditing] = useState<TrackedLinkItem | 'new' | null>(null)
  const [form, setForm] = useState<{ name: string; originalUrl: string; tagId: string }>({
    name: '',
    originalUrl: '',
    tagId: '',
  })
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)

  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [linkRes, tagRes] = await Promise.all([api.trackedLinks.list(), api.tags.list()])
      if (linkRes.success) setLinks(linkRes.data)
      else setError('計測リンクの読み込みに失敗しました')
      if (tagRes.success) setTags(tagRes.data)
    } catch {
      setError('計測リンクの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const openCreate = () => {
    setForm({ name: '', originalUrl: '', tagId: '' })
    setFormError('')
    setEditing('new')
  }

  const openEdit = (link: TrackedLinkItem) => {
    setForm({ name: link.name, originalUrl: link.originalUrl, tagId: link.tagId ?? '' })
    setFormError('')
    setEditing(link)
  }

  const handleSave = async () => {
    const nameError = validateLinkName(form.name)
    if (nameError) {
      setFormError(nameError)
      return
    }
    // 遷移先 URL 検証は作成時のみ (編集では readOnly で変更不可 = R1-I1)。
    if (editing === 'new') {
      const urlError = validateOriginalUrl(form.originalUrl)
      if (urlError) {
        setFormError(urlError)
        return
      }
    }
    setFormError('')
    setSaving(true)
    try {
      const res =
        editing === 'new'
          ? await api.trackedLinks.create({
              name: form.name.trim(),
              originalUrl: form.originalUrl.trim(),
              tagId: form.tagId || null,
            })
          : editing
            ? // worker PATCH は original_url 非対応。originalUrl は送らない (silent-success 罠回避)。
              await api.trackedLinks.patch(editing.id, {
                name: form.name.trim(),
                tagId: form.tagId || null,
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
      await api.trackedLinks.delete(id)
      setPendingRemoveId(null)
      await load()
    } catch {
      setError('削除に失敗しました')
      setPendingRemoveId(null)
    }
  }

  const handleCopy = async (link: TrackedLinkItem) => {
    try {
      await navigator.clipboard.writeText(link.trackingUrl)
      setCopiedId(link.id)
      setTimeout(() => setCopiedId(null), 1200)
    } catch {
      // silent
    }
  }

  const shortPath = (url: string): string => {
    try {
      return new URL(url).pathname
    } catch {
      return url
    }
  }

  return (
    <div>
      <Header
        title="計測リンク"
        description="クリック数を計測できるリンクを発行します。配信メッセージや SNS に貼ってどこから来たか追えます。"
        action={
          <button
            onClick={openCreate}
            className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            + 新規リンク
          </button>
        }
      />

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* 作成/編集フォーム (inline card) */}
      {editing !== null && (
        <div className="mb-4 bg-white border border-gray-200 rounded-lg p-5">
          <h3 className="text-sm font-semibold text-gray-800 mb-4">
            {editing === 'new' ? '新しい計測リンクを作る' : '計測リンクを編集'}
          </h3>
          <div className="space-y-4 max-w-lg">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                リンク名 <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                placeholder="例: 春キャンペーン"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">
                遷移先 URL {editing === 'new' && <span className="text-red-500">*</span>}
              </label>
              <input
                type="text"
                value={form.originalUrl}
                onChange={(e) => setForm((f) => ({ ...f, originalUrl: e.target.value }))}
                readOnly={editing !== 'new'}
                className={`w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 ${
                  editing !== 'new' ? 'bg-gray-100 text-gray-500 cursor-not-allowed' : ''
                }`}
                placeholder="https://example.com"
              />
              {editing !== 'new' && (
                <p className="text-xs text-gray-400 mt-1">
                  遷移先URLは作成後に変更できません。変える場合は新しいリンクを作成してください。
                </p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">タグを付ける</label>
              <select
                value={form.tagId}
                onChange={(e) => setForm((f) => ({ ...f, tagId: e.target.value }))}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
              >
                <option value="">— タグなし</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>

            {formError && <p className="text-xs text-red-600">{formError}</p>}

            <div className="flex gap-2">
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
                style={{ backgroundColor: '#06C755' }}
              >
                {saving ? '保存中...' : '保存'}
              </button>
              <button
                onClick={() => { setEditing(null); setFormError('') }}
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
      ) : links.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <svg className="mx-auto h-12 w-12 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
          <h3 className="mt-4 text-lg font-semibold text-gray-800">まだ計測リンクがありません</h3>
          <p className="mt-2 text-sm text-gray-500 leading-relaxed">
            配信メッセージや SNS 投稿に貼るリンクを作ると、<br />
            どこから何人クリックしたか追えるようになります。
          </p>
          <button
            onClick={openCreate}
            className="mt-5 px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            ＋ 最初の計測リンクを作る
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px]">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">リンク名</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">遷移先 URL</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">クリック数</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">タグ</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">短縮 URL（クリック計測あり）</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider sticky right-0 z-10 bg-gray-50 border-l border-gray-200">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {links.map((link) => {
                  const tag = link.tagId ? tags.find((t) => t.id === link.tagId) : null
                  return (
                    <tr key={link.id} className="group hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">{link.name}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 max-w-[240px] truncate" title={link.originalUrl}>
                        {link.originalUrl}
                      </td>
                      <td className="px-4 py-3 text-sm text-right tabular-nums text-gray-900">{link.clickCount}</td>
                      <td className="px-4 py-3 text-sm">
                        {tag ? (
                          <span
                            className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium"
                            style={{ backgroundColor: `${tag.color}22`, color: tag.color }}
                          >
                            {tag.name}
                          </span>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-blue-600">{shortPath(link.trackingUrl)}</span>
                          <button
                            onClick={() => handleCopy(link)}
                            className="text-xs text-blue-500 hover:text-blue-700"
                          >
                            {copiedId === link.id ? 'コピー済' : 'コピー'}
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap sticky right-0 z-10 bg-white group-hover:bg-gray-50 border-l border-gray-100">
                        {pendingRemoveId === link.id ? (
                          <span className="inline-flex items-center gap-1 justify-end">
                            <span className="text-xs text-gray-600">「{link.name}」を削除しますか？</span>
                            <button
                              onClick={() => handleDelete(link.id)}
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
                          <>
                            <button
                              onClick={() => openEdit(link)}
                              className="px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-md"
                            >
                              編集
                            </button>
                            <button
                              onClick={() => setPendingRemoveId(link.id)}
                              className="ml-1 px-2.5 py-1 text-xs font-medium text-red-500 hover:bg-red-50 rounded-md"
                            >
                              削除
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
