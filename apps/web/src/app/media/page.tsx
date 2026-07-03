'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'

interface MediaItem {
  key: string
  url: string
  size: number
  uploaded: string
}

export default function MediaLibraryPage() {
  const [items, setItems] = useState<MediaItem[]>([])
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)

  const [pendingRemoveKey, setPendingRemoveKey] = useState<string | null>(null)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.images.list()
      if (res.success) {
        setItems(res.data.items)
        setCursor(res.data.cursor)
      } else {
        setError('メディアの読み込みに失敗しました')
      }
    } catch {
      setError('メディアの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const loadMore = async () => {
    if (!cursor) return
    setLoadingMore(true)
    try {
      const res = await api.images.list(cursor)
      if (res.success) {
        setItems((prev) => [...prev, ...res.data.items])
        setCursor(res.data.cursor)
      }
    } catch {
      // silent
    } finally {
      setLoadingMore(false)
    }
  }

  const handlePickFile = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // input を都度リセットして同じファイルの連続選択も onChange 発火させる
    if (e.target) e.target.value = ''
    if (!file) return
    setUploading(true)
    setError('')
    try {
      const res = await api.uploads.image(file)
      if (res.success) {
        await load()
      } else {
        setError(res.error || 'アップロードに失敗しました')
      }
    } catch {
      setError('アップロードに失敗しました')
    } finally {
      setUploading(false)
    }
  }

  const handleCopy = async (item: MediaItem) => {
    try {
      await navigator.clipboard.writeText(item.url)
      setCopiedKey(item.key)
      setTimeout(() => setCopiedKey(null), 1200)
    } catch {
      // silent
    }
  }

  const handleDelete = async (key: string) => {
    try {
      const res = await api.images.remove(key)
      if (res.success) {
        setItems((prev) => prev.filter((i) => i.key !== key))
      } else {
        setError('削除に失敗しました')
      }
      setPendingRemoveKey(null)
    } catch {
      setError('削除に失敗しました')
      setPendingRemoveKey(null)
    }
  }

  const uploadButton = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileChange}
        className="hidden"
      />
      <button
        onClick={handlePickFile}
        disabled={uploading}
        className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90 disabled:opacity-50"
        style={{ backgroundColor: '#06C755' }}
      >
        {uploading ? 'アップロード中...' : '＋ 画像を追加'}
      </button>
    </>
  )

  return (
    <div>
      <Header
        title="メディアライブラリ"
        description="配信やビルダーで使う画像を溜めておく場所です。ここにある画像はURLをコピーして何度でも使えます。"
        action={uploadButton}
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
          <svg className="mx-auto h-12 w-12 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <h3 className="mt-4 text-lg font-semibold text-gray-800">まだ素材がありません</h3>
          <p className="mt-2 text-sm text-gray-500 leading-relaxed">
            配信やビルダーで使う画像をここにアップしておくと、<br />
            URLをコピーして何度でも使えます。
          </p>
          <button
            onClick={handlePickFile}
            disabled={uploading}
            className="mt-5 px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90 disabled:opacity-50"
            style={{ backgroundColor: '#06C755' }}
          >
            {uploading ? 'アップロード中...' : '＋ 最初の画像をアップロード'}
          </button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {items.map((item) => (
              <div key={item.key} className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <div className="aspect-square bg-gray-50">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={item.url}
                    alt={item.key}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                </div>
                {pendingRemoveKey === item.key ? (
                  <div className="p-3 text-center">
                    <p className="text-xs text-gray-600 mb-2">この画像を消しますか？</p>
                    <div className="flex gap-2 justify-center">
                      <button
                        onClick={() => handleDelete(item.key)}
                        className="min-h-[36px] px-3 rounded-md text-xs font-medium text-white bg-red-600 hover:bg-red-700"
                      >
                        はい
                      </button>
                      <button
                        onClick={() => setPendingRemoveKey(null)}
                        className="min-h-[36px] px-3 rounded-md text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200"
                      >
                        いいえ
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="p-2 flex items-center justify-between gap-1">
                    <button
                      onClick={() => handleCopy(item)}
                      className="flex-1 min-h-[36px] px-2 rounded-md text-xs font-medium text-gray-700 bg-gray-100 hover:bg-gray-200"
                    >
                      {copiedKey === item.key ? 'コピー済' : 'URLをコピー'}
                    </button>
                    <button
                      onClick={() => setPendingRemoveKey(item.key)}
                      className="min-h-[36px] px-2 rounded-md text-xs font-medium text-red-500 hover:bg-red-50"
                    >
                      削除
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {cursor && (
            <div className="mt-6 text-center">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg disabled:opacity-50"
              >
                {loadingMore ? '読み込み中...' : 'もっと見る'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
