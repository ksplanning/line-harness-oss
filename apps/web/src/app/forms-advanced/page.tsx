'use client'

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { formsAdvancedApi, type AdvancedForm } from '@/lib/formaloo-advanced-api'

const LINE_GREEN = '#06C755'

function statusBadge(status: AdvancedForm['builderStatus']) {
  if (status === 'published') return { label: '公開中', color: LINE_GREEN }
  if (status === 'in_review') return { label: 'レビュー中', color: '#F59E0B' }
  return { label: '下書き', color: '#9CA3AF' }
}

export default function FormsAdvancedListPage() {
  const router = useRouter()
  const [forms, setForms] = useState<AdvancedForm[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setForms(await formsAdvancedApi.list())
    } catch {
      setForms([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const form = await formsAdvancedApi.create({ title: '新しいフォーム' })
      router.push(`/forms-advanced/detail?id=${form.id}`)
    } catch {
      setCreating(false)
    }
  }

  return (
    <div>
      <Header title="高機能フォーム" description="ドラッグ&ドロップで条件分岐・ファイル添付・埋め込み対応の高機能フォームを作れます" />

      <div className="flex justify-end mb-4">
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating}
          className="px-4 py-2 rounded-lg text-sm text-white disabled:opacity-50"
          style={{ backgroundColor: LINE_GREEN }}
        >
          {creating ? '作成中...' : '＋ 新規フォーム'}
        </button>
      </div>

      <section>
        {loading ? (
          <div className="text-sm text-gray-400">読み込み中...</div>
        ) : forms.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400 text-sm">
            高機能フォームはまだありません。「＋ 新規フォーム」から作成してください。
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {forms.map((form) => {
              const badge = statusBadge(form.builderStatus)
              return (
                <div key={form.id} className="bg-white rounded-lg border border-gray-200 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs text-white px-2 py-0.5 rounded" style={{ backgroundColor: badge.color }}>{badge.label}</span>
                    <span className="text-[10px] text-gray-400">高機能</span>
                    {form.syncStatus === 'out_of_sync' && <span className="text-[10px] text-amber-600">未同期</span>}
                  </div>
                  <div className="text-sm font-bold mb-1 truncate">{form.title}</div>
                  <div className="text-xs text-gray-500 mb-3">回答 {form.submitCount} 件</div>
                  <div className="flex gap-2 text-xs">
                    <Link href={`/forms-advanced/detail?id=${form.id}`} className="px-2 py-1 rounded bg-gray-100 hover:bg-gray-200">編集</Link>
                    <Link href={`/forms-advanced/data?id=${form.id}`} className="px-2 py-1 rounded bg-gray-100 hover:bg-gray-200">データ</Link>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}
