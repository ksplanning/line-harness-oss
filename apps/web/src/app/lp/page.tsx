'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import Header from '@/components/layout/header'
import { lpApi, type LpPageItem, type LpViewRow } from '@/lib/lp/api'

export default function LpHostingPage() {
  const [items, setItems] = useState<LpPageItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // 登録フォーム
  const [newSlug, setNewSlug] = useState('')
  const [newTitle, setNewTitle] = useState('')
  const [creating, setCreating] = useState(false)

  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [uploadingSlug, setUploadingSlug] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [viewRows, setViewRows] = useState<LpViewRow[]>([])

  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await lpApi.list()
      if (res.success) setItems(res.data.items)
      else setError('LP の読み込みに失敗しました')
    } catch {
      setError('LP の読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const handleCreate = async () => {
    const slug = newSlug.trim().toLowerCase()
    const title = newTitle.trim()
    if (!slug || !title) {
      setError('slug と名前を入力してください')
      return
    }
    setCreating(true)
    setError('')
    try {
      const res = await lpApi.create({ slug, title })
      if (res.success) {
        setNewSlug('')
        setNewTitle('')
        await load()
      } else {
        setError(res.error || '登録に失敗しました')
      }
    } catch {
      setError('登録に失敗しました')
    } finally {
      setCreating(false)
    }
  }

  const handleUpload = async (slug: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (e.target) e.target.value = ''
    if (!file) return
    setUploadingSlug(slug)
    setError('')
    try {
      const res = await lpApi.uploadFile(slug, file)
      if (res.success) await load()
      else setError(res.error || 'アップロードに失敗しました')
    } catch {
      setError('アップロードに失敗しました')
    } finally {
      setUploadingSlug(null)
    }
  }

  const handleSetStatus = async (slug: string, status: 'active' | 'stopped') => {
    try {
      const res = await lpApi.setStatus(slug, status)
      if (res.success) await load()
      else setError('状態の変更に失敗しました')
    } catch {
      setError('状態の変更に失敗しました')
    }
  }

  const handleDelete = async (slug: string) => {
    try {
      const res = await lpApi.remove(slug)
      if (res.success) setItems((prev) => prev.filter((i) => i.slug !== slug))
      else setError('削除に失敗しました')
    } catch {
      setError('削除に失敗しました')
    } finally {
      setPendingDelete(null)
    }
  }

  const handleCopy = async (url: string, slug: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(slug)
      setTimeout(() => setCopied(null), 1200)
    } catch {
      // silent
    }
  }

  const toggleViews = async (slug: string) => {
    if (expanded === slug) {
      setExpanded(null)
      return
    }
    setExpanded(slug)
    setViewRows([])
    try {
      const res = await lpApi.views(slug)
      if (res.success) setViewRows(res.data.views)
    } catch {
      // silent
    }
  }

  const createForm = (
    <div className="flex flex-wrap items-center gap-2">
      <input
        value={newSlug}
        onChange={(e) => setNewSlug(e.target.value)}
        placeholder="slug（英小文字・数字・ハイフン）"
        className="px-3 py-2 min-h-[44px] text-sm border border-gray-300 rounded-lg"
      />
      <input
        value={newTitle}
        onChange={(e) => setNewTitle(e.target.value)}
        placeholder="LPの名前（タイトル）"
        className="px-3 py-2 min-h-[44px] text-sm border border-gray-300 rounded-lg"
      />
      <button
        onClick={handleCreate}
        disabled={creating}
        className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90 disabled:opacity-50"
        style={{ backgroundColor: '#06C755' }}
      >
        {creating ? '登録中...' : '＋ LPを登録'}
      </button>
    </div>
  )

  return (
    <div>
      <Header
        title="LP置き場"
        description="作ったLP（ランディングページ）をここに置くと、ハーネス内のURLで公開できます。フォーム送信後の飛び先にも選べます。"
        action={createForm}
      />

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 px-4 py-8 text-center text-gray-400 text-sm">
          読み込み中...
        </div>
      ) : items.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <h3 className="text-lg font-semibold text-gray-800">まだLPがありません</h3>
          <p className="mt-2 text-sm text-gray-500 leading-relaxed">
            上の「LPを登録」からslugと名前を決めて登録し、<br />
            index.html などのファイルをアップロードすると公開できます。
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <div key={item.slug} className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-semibold text-gray-800 truncate">{item.title}</h3>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full ${
                        item.status === 'active' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                      }`}
                    >
                      {item.status === 'active' ? '公開中' : '停止中'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-gray-400 font-mono break-all">{item.url}</p>
                  <div className="mt-2 flex items-center gap-4 text-xs text-gray-600">
                    <span>閲覧 {item.views.total}</span>
                    <span>紐付き {item.views.friendBound}</span>
                    {!item.entry_key && <span className="text-amber-600">※ index.html 未アップロード</span>}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => handleCopy(item.url, item.slug)}
                    className="min-h-[36px] px-3 rounded-md text-xs font-medium text-gray-700 bg-gray-100 hover:bg-gray-200"
                  >
                    {copied === item.slug ? 'コピー済' : 'URLをコピー'}
                  </button>

                  <input
                    ref={(el) => {
                      fileRefs.current[item.slug] = el
                    }}
                    type="file"
                    onChange={(e) => handleUpload(item.slug, e)}
                    className="hidden"
                  />
                  <button
                    onClick={() => fileRefs.current[item.slug]?.click()}
                    disabled={uploadingSlug === item.slug}
                    className="min-h-[36px] px-3 rounded-md text-xs font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 disabled:opacity-50"
                  >
                    {uploadingSlug === item.slug ? 'アップロード中...' : 'ファイルを追加'}
                  </button>

                  {item.status === 'active' ? (
                    <button
                      onClick={() => handleSetStatus(item.slug, 'stopped')}
                      className="min-h-[36px] px-3 rounded-md text-xs font-medium text-amber-700 bg-amber-50 hover:bg-amber-100"
                    >
                      停止する
                    </button>
                  ) : (
                    <button
                      onClick={() => handleSetStatus(item.slug, 'active')}
                      className="min-h-[36px] px-3 rounded-md text-xs font-medium text-green-700 bg-green-50 hover:bg-green-100"
                    >
                      再開する
                    </button>
                  )}

                  <button
                    onClick={() => toggleViews(item.slug)}
                    className="min-h-[36px] px-3 rounded-md text-xs font-medium text-gray-700 bg-gray-100 hover:bg-gray-200"
                  >
                    閲覧
                  </button>

                  {pendingDelete === item.slug ? (
                    <span className="flex items-center gap-1">
                      <button
                        onClick={() => handleDelete(item.slug)}
                        className="min-h-[36px] px-3 rounded-md text-xs font-medium text-white bg-red-600 hover:bg-red-700"
                      >
                        はい
                      </button>
                      <button
                        onClick={() => setPendingDelete(null)}
                        className="min-h-[36px] px-3 rounded-md text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200"
                      >
                        いいえ
                      </button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setPendingDelete(item.slug)}
                      className="min-h-[36px] px-3 rounded-md text-xs font-medium text-red-500 hover:bg-red-50"
                    >
                      削除
                    </button>
                  )}
                </div>
              </div>

              {expanded === item.slug && (
                <div className="mt-3 border-t border-gray-100 pt-3">
                  <p className="text-xs text-gray-500 mb-2">直近の閲覧</p>
                  {viewRows.length === 0 ? (
                    <p className="text-xs text-gray-400">まだ閲覧はありません</p>
                  ) : (
                    <ul className="space-y-1">
                      {viewRows.map((v) => (
                        <li key={v.id} className="text-xs text-gray-600 flex items-center gap-2">
                          <span>{v.friend_name ?? '（匿名）'}</span>
                          <span className="text-gray-400">{v.viewed_at}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
