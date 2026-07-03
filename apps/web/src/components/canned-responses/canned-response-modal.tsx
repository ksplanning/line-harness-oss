'use client'

import { useEffect, useState } from 'react'
import { validateCannedResponse } from '@/lib/canned-responses/canned-form'

interface Props {
  mode: 'create' | 'edit'
  initialTitle?: string
  initialContent?: string
  saving: boolean
  onClose: () => void
  onSubmit: (data: { title: string; content: string }) => void
}

// 骨格は AccountEditModal を踏襲 (overlay / panel / header× / scroll lock / footer)。
// 中身がタイトル+本文の 2 項目のみなので幅だけ max-w-lg に縮小 (骨格は同一)。
export default function CannedResponseModal({
  mode,
  initialTitle = '',
  initialContent = '',
  saving,
  onClose,
  onSubmit,
}: Props) {
  const [title, setTitle] = useState(initialTitle)
  const [content, setContent] = useState(initialContent)

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  const canSave = !validateCannedResponse({ title, content }) && !saving

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (validateCannedResponse({ title, content })) return
    onSubmit({ title: title.trim(), content: content.trim() })
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-start sm:items-center justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg my-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-base font-bold text-gray-900">{mode === 'create' ? '新規定型文' : '定型文を編集'}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
            aria-label="閉じる"
          >
            ×
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">タイトル</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              placeholder="例: 営業時間のご案内"
            />
            {!title.trim() && <p className="mt-1 text-xs text-red-500">タイトルを入力してください</p>}
          </div>

          <div>
            <label className="block text-xs font-medium text-gray-700 mb-1">本文</label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={5}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              placeholder="チャットに差し込む文章を入力します"
            />
            {!content.trim() && <p className="mt-1 text-xs text-red-500">本文を入力してください</p>}
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 hover:bg-gray-50"
            >
              キャンセル
            </button>
            <button
              type="submit"
              disabled={!canSave}
              className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
              style={{ backgroundColor: '#06C755' }}
            >
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
