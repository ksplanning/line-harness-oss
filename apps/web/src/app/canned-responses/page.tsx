'use client'

import { useState, useEffect, useCallback } from 'react'
import { api, type CannedResponseData } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import Header from '@/components/layout/header'
import CannedResponseModal from '@/components/canned-responses/canned-response-modal'
import { previewContent } from '@/lib/canned-responses/canned-form'

function formatDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[1]}/${m[2]}/${m[3]}` : iso.slice(0, 10)
}

export default function CannedResponsesPage() {
  const { selectedAccountId } = useAccount()
  const [items, setItems] = useState<CannedResponseData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // 行内確認: 対象 id を pin。別 id を押すと自動で切替 (window.confirm 不使用)。
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null)
  const [modal, setModal] = useState<{ mode: 'create' | 'edit'; item?: CannedResponseData } | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!selectedAccountId) {
      setItems([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      const res = await api.cannedResponses.list(selectedAccountId)
      if (res.success) setItems(res.data)
      else setError('定型文の読み込みに失敗しました')
    } catch {
      setError('定型文の読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [selectedAccountId])

  useEffect(() => {
    load()
  }, [load])

  const handleSubmit = async (data: { title: string; content: string }) => {
    setSaving(true)
    try {
      if (modal?.mode === 'edit' && modal.item) {
        await api.cannedResponses.update(modal.item.id, data, selectedAccountId)
      } else {
        await api.cannedResponses.create({ ...data, accountId: selectedAccountId })
      }
      setModal(null)
      await load()
    } catch {
      setError('保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await api.cannedResponses.remove(id, selectedAccountId)
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
        title="チャット定型文"
        description="1:1チャットの返信に差し込む文章です。"
        action={
          selectedAccountId ? (
            <button
              onClick={() => setModal({ mode: 'create' })}
              className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
              style={{ backgroundColor: '#06C755' }}
            >
              ＋ 新規定型文
            </button>
          ) : undefined
        }
      />

      <p className="-mt-6 mb-6 text-xs text-gray-400">
        ※ 一斉配信の「テンプレート」とは別物です。ここは個別チャットの返信専用です。
      </p>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
      )}

      {!selectedAccountId ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 px-4 py-8 text-center text-gray-400 text-sm">
          上部でアカウントを選んでください。
        </div>
      ) : loading ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 px-4 py-8 text-center text-gray-400 text-sm">
          読み込み中...
        </div>
      ) : items.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <svg className="mx-auto h-12 w-12 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          <h3 className="mt-4 text-lg font-semibold text-gray-800">まだチャット定型文がありません</h3>
          <p className="mt-2 text-sm text-gray-500 leading-relaxed">
            例:「営業時間のご案内」「よくある質問への返信」など、<br />
            よく使う返信を登録しておけます。「＋ 新規定型文」から作れます。
          </p>
          <button
            onClick={() => setModal({ mode: 'create' })}
            className="mt-5 px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            ＋ 最初の定型文を作る
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px]">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">タイトル</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">本文プレビュー</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">更新日</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider sticky right-0 z-10 bg-gray-50 border-l border-gray-200">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((item) => (
                  <tr key={item.id} className="group hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">{item.title}</td>
                    <td className="px-4 py-3 text-sm text-gray-500 max-w-xs truncate">{previewContent(item.content)}</td>
                    <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">{formatDate(item.updatedAt)}</td>
                    <td className="px-4 py-3 text-right sticky right-0 z-10 bg-white group-hover:bg-gray-50 border-l border-gray-100">
                      {pendingRemoveId === item.id ? (
                        <span className="inline-flex items-center gap-1 justify-end">
                          <span className="hidden sm:inline text-xs text-gray-600">「{item.title}」を削除しますか？</span>
                          <span className="sm:hidden text-xs text-gray-600">削除しますか？</span>
                          <button
                            onClick={() => handleDelete(item.id)}
                            className="min-h-[36px] px-3 rounded-md text-xs font-medium text-white bg-red-600 hover:bg-red-700 whitespace-nowrap"
                          >
                            はい
                          </button>
                          <button
                            onClick={() => setPendingRemoveId(null)}
                            className="min-h-[36px] px-3 rounded-md text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 whitespace-nowrap"
                          >
                            いいえ
                          </button>
                        </span>
                      ) : (
                        <span className="inline-flex items-center justify-end">
                          <button
                            onClick={() => setModal({ mode: 'edit', item })}
                            className="px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-md"
                          >
                            編集
                          </button>
                          <button
                            onClick={() => setPendingRemoveId(item.id)}
                            className="ml-1 px-2.5 py-1 text-xs font-medium text-red-500 hover:bg-red-50 rounded-md"
                          >
                            削除
                          </button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {modal && (
        <CannedResponseModal
          mode={modal.mode}
          initialTitle={modal.item?.title ?? ''}
          initialContent={modal.item?.content ?? ''}
          saving={saving}
          onClose={() => setModal(null)}
          onSubmit={handleSubmit}
        />
      )}
    </div>
  )
}
