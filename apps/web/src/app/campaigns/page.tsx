'use client'

import { useState, useEffect, useCallback } from 'react'
import { api, type CampaignSummary, type CampaignDetail, type ApiBroadcast } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import Header from '@/components/layout/header'
import {
  openRate,
  clickRate,
  formatCount,
  formatRate,
  broadcastDisplayName,
  validateCampaignName,
} from '@/lib/campaigns/aggregate-view'

function formatDate(iso: string | null): string {
  if (!iso) return '-'
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[1]}/${m[2]}/${m[3]}` : iso.slice(0, 10)
}

export default function CampaignsPage() {
  const { selectedAccountId } = useAccount()
  const [items, setItems] = useState<CampaignSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null)
  const [modal, setModal] = useState<{ mode: 'create' | 'edit'; item?: CampaignSummary } | null>(null)
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState('')
  const [saving, setSaving] = useState(false)

  // 詳細 (?id=) — 選択中キャンペーンの集計 + 紐付き配信。
  const [detailId, setDetailId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!selectedAccountId) {
      setItems([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      const res = await api.campaigns.list(selectedAccountId)
      if (res.success) setItems(res.data)
      else setError('キャンペーンの読み込みに失敗しました')
    } catch {
      setError('キャンペーンの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [selectedAccountId])

  useEffect(() => {
    load()
  }, [load])

  const openCreate = () => {
    setName('')
    setNameError('')
    setModal({ mode: 'create' })
  }
  const openEdit = (item: CampaignSummary) => {
    setName(item.name)
    setNameError('')
    setModal({ mode: 'edit', item })
  }

  const handleSubmit = async () => {
    const v = validateCampaignName(name)
    if (!v.ok) {
      setNameError(v.error)
      return
    }
    if (!selectedAccountId) return
    setSaving(true)
    try {
      if (modal?.mode === 'edit' && modal.item) {
        await api.campaigns.rename(modal.item.id, name.trim(), selectedAccountId)
      } else {
        await api.campaigns.create(selectedAccountId, name.trim())
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
    if (!selectedAccountId) return
    try {
      await api.campaigns.remove(id, selectedAccountId)
      setPendingRemoveId(null)
      if (detailId === id) setDetailId(null)
      await load()
    } catch {
      setError('削除に失敗しました')
      setPendingRemoveId(null)
    }
  }

  if (detailId && selectedAccountId) {
    return (
      <CampaignDetailView
        campaignId={detailId}
        accountId={selectedAccountId}
        onBack={() => {
          setDetailId(null)
          void load()
        }}
      />
    )
  }

  return (
    <div>
      <Header
        title="キャンペーン（成果まとめ）"
        description="複数の配信をひとまとめにして、キャンペーン単位で成果を見られます。たとえば『春の販促』というキャンペーンに5本の配信を紐付けると、5本の合計をまとめて確認できます。"
        action={
          selectedAccountId ? (
            <button
              onClick={openCreate}
              className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
              style={{ backgroundColor: '#06C755' }}
            >
              ＋ キャンペーンを作成
            </button>
          ) : undefined
        }
      />

      <p className="-mt-6 mb-6 text-xs text-gray-400">
        ※ 合計は「このキャンペーンに紐付いた配信」のみの集計です。紐付いていない配信は含まれません。
      </p>

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
      )}

      {!selectedAccountId ? (
        <EmptyBox>上部でアカウントを選んでください。</EmptyBox>
      ) : loading ? (
        <EmptyBox>読み込み中...</EmptyBox>
      ) : items.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <h3 className="text-lg font-semibold text-gray-800">まだキャンペーンがありません</h3>
          <p className="mt-2 text-sm text-gray-500 leading-relaxed">
            例:『春の販促』『新商品告知』などの名前でキャンペーンを作り、<br />
            配信を紐付けると成果をまとめて確認できます。
          </p>
          <button
            onClick={openCreate}
            className="mt-5 px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            ＋ 最初のキャンペーンを作る
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">キャンペーン名</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">作成日</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider sticky right-0 z-10 bg-gray-50 border-l border-gray-200">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((item) => (
                  <tr key={item.id} className="group hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">{item.name}</td>
                    <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">{formatDate(item.createdAt)}</td>
                    <td className="px-4 py-3 text-right sticky right-0 z-10 bg-white group-hover:bg-gray-50 border-l border-gray-100">
                      {pendingRemoveId === item.id ? (
                        <span className="inline-flex items-center gap-1 justify-end">
                          <span className="hidden sm:inline text-xs text-gray-600">「{item.name}」を削除しますか？</span>
                          <span className="sm:hidden text-xs text-gray-600">削除しますか？</span>
                          <button onClick={() => handleDelete(item.id)} className="min-h-[36px] px-3 rounded-md text-xs font-medium text-white bg-red-600 hover:bg-red-700 whitespace-nowrap">はい</button>
                          <button onClick={() => setPendingRemoveId(null)} className="min-h-[36px] px-3 rounded-md text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 whitespace-nowrap">いいえ</button>
                        </span>
                      ) : (
                        <span className="inline-flex items-center justify-end">
                          <button onClick={() => setDetailId(item.id)} className="px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-md">詳細</button>
                          <button onClick={() => openEdit(item)} className="ml-1 px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-md">編集</button>
                          <button onClick={() => setPendingRemoveId(item.id)} className="ml-1 px-2.5 py-1 text-xs font-medium text-red-500 hover:bg-red-50 rounded-md">削除</button>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setModal(null)}>
          <div className="w-full max-w-lg bg-white rounded-xl shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h2 className="text-base font-semibold text-gray-900">{modal.mode === 'edit' ? 'キャンペーンを編集' : 'キャンペーンを作成'}</h2>
              <button onClick={() => setModal(null)} className="text-gray-400 hover:text-gray-600" aria-label="閉じる">✕</button>
            </div>
            <div className="px-5 py-4">
              <label className="block text-xs font-medium text-gray-600 mb-1">キャンペーン名 <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={name}
                onChange={(e) => { setName(e.target.value); setNameError('') }}
                placeholder="例: 春の販促キャンペーン"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              />
              {nameError && <p className="mt-1 text-xs text-red-500">{nameError}</p>}
              <p className="mt-2 text-xs text-gray-500">※ あとで配信を紐付けると成果をまとめて確認できます。</p>
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-gray-100">
              <button onClick={() => setModal(null)} className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg">キャンセル</button>
              <button
                onClick={handleSubmit}
                disabled={saving}
                className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: '#06C755' }}
              >
                {saving ? '保存中...' : '保存'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function EmptyBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 px-4 py-8 text-center text-gray-400 text-sm">
      {children}
    </div>
  )
}

// ---- 詳細ビュー (集計カード + 紐付き配信 + 紐付け導線) ----

function CampaignDetailView({ campaignId, accountId, onBack }: { campaignId: string; accountId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<CampaignDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pendingUnlinkId, setPendingUnlinkId] = useState<string | null>(null)
  // 紐付け候補 (同 account の未紐付け配信)。
  const [linkOpen, setLinkOpen] = useState(false)
  const [candidates, setCandidates] = useState<ApiBroadcast[]>([])
  const [candLoading, setCandLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.campaigns.get(campaignId, accountId)
      if (res.success) setDetail(res.data)
      else setError('キャンペーンの読み込みに失敗しました')
    } catch {
      setError('キャンペーンの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [campaignId, accountId])

  useEffect(() => {
    load()
  }, [load])

  const openLink = async () => {
    setLinkOpen(true)
    setCandLoading(true)
    try {
      const res = await api.broadcasts.list({ accountId })
      // 未紐付けの配信のみ候補に (campaignId が無い/このキャンペーン以外)。
      const linkedIds = new Set((detail?.aggregate.broadcasts ?? []).map((b) => b.broadcastId))
      const list = (res.success ? res.data : []).filter((b) => !linkedIds.has(b.id))
      setCandidates(list)
    } catch {
      setCandidates([])
    } finally {
      setCandLoading(false)
    }
  }

  const linkBroadcast = async (broadcastId: string) => {
    try {
      await api.campaigns.linkBroadcast(campaignId, broadcastId, true, accountId)
      setLinkOpen(false)
      await load()
    } catch {
      setError('配信の紐付けに失敗しました')
    }
  }

  const unlink = async (broadcastId: string) => {
    try {
      await api.campaigns.linkBroadcast(campaignId, broadcastId, false, accountId)
      setPendingUnlinkId(null)
      await load()
    } catch {
      setError('紐付け解除に失敗しました')
      setPendingUnlinkId(null)
    }
  }

  const agg = detail?.aggregate

  return (
    <div>
      <button onClick={onBack} className="mb-4 text-sm text-gray-500 hover:text-gray-700">← キャンペーン一覧</button>
      <h1 className="text-xl font-bold text-gray-900 mb-4">{detail?.name ?? '...'}</h1>

      {error && <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

      {loading || !agg ? (
        <EmptyBox>読み込み中...</EmptyBox>
      ) : (
        <>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-3 mb-2">
            <Stat label="配信本数" value={formatCount(agg.broadcastCount, '本')} />
            <Stat label="合計対象" value={formatCount(agg.totalTarget, '人')} />
            <Stat label="合計開封" value={formatCount(agg.totalOpened, '人')} />
            <Stat label="合計クリック" value={formatCount(agg.totalClicked, '人')} />
            <Stat label="開封率" value={formatRate(openRate(agg))} />
            <Stat label="クリック率" value={formatRate(clickRate(agg))} />
          </div>
          <p className="mb-6 text-xs text-gray-400">
            ※ 開封・クリックは LINE 側の反映に〜30分かかる場合があります。紐付いていない配信は含まれません。
          </p>

          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-gray-700">紐付いた配信（{agg.broadcasts.length}本）</h2>
            <button
              onClick={openLink}
              className="px-3 py-1.5 text-xs font-medium text-white rounded-lg transition-opacity hover:opacity-90"
              style={{ backgroundColor: '#06C755' }}
            >
              配信を紐付ける
            </button>
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px]">
                <thead className="bg-gray-50 border-b border-gray-200">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">配信名</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">対象</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">開封</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">クリック</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">送信日</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider sticky right-0 z-10 bg-gray-50 border-l border-gray-200">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {agg.broadcasts.length === 0 ? (
                    <tr><td colSpan={6} className="px-4 py-8 text-center text-sm text-gray-400">まだ配信が紐付いていません。「配信を紐付ける」から追加してください。</td></tr>
                  ) : (
                    agg.broadcasts.map((b) => (
                      <tr key={b.broadcastId} className="group hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm font-medium text-gray-900">{broadcastDisplayName(b)}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{formatCount(b.targetCount, '人')}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{formatCount(b.opened, '人')}</td>
                        <td className="px-4 py-3 text-sm text-gray-600">{formatCount(b.clicked, '人')}</td>
                        <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">{formatDate(b.sentAt)}</td>
                        <td className="px-4 py-3 text-right sticky right-0 z-10 bg-white group-hover:bg-gray-50 border-l border-gray-100">
                          {pendingUnlinkId === b.broadcastId ? (
                            <span className="inline-flex items-center gap-1 justify-end">
                              <span className="text-xs text-gray-600">解除しますか？</span>
                              <button onClick={() => unlink(b.broadcastId)} className="min-h-[36px] px-3 rounded-md text-xs font-medium text-white bg-red-600 hover:bg-red-700 whitespace-nowrap">はい</button>
                              <button onClick={() => setPendingUnlinkId(null)} className="min-h-[36px] px-3 rounded-md text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 whitespace-nowrap">いいえ</button>
                            </span>
                          ) : (
                            <button onClick={() => setPendingUnlinkId(b.broadcastId)} className="px-2.5 py-1 text-xs font-medium text-red-500 hover:bg-red-50 rounded-md whitespace-nowrap">紐付け解除</button>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <p className="mt-2 text-xs text-gray-400">※ 解除するとこのキャンペーンの集計から外れます（配信自体は消えません）。</p>
        </>
      )}

      {linkOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setLinkOpen(false)}>
          <div className="w-full max-w-lg bg-white rounded-xl shadow-xl max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h2 className="text-base font-semibold text-gray-900">配信を紐付ける</h2>
              <button onClick={() => setLinkOpen(false)} className="text-gray-400 hover:text-gray-600" aria-label="閉じる">✕</button>
            </div>
            <div className="px-5 py-4 overflow-y-auto">
              {candLoading ? (
                <p className="text-sm text-gray-400 text-center py-6">読み込み中...</p>
              ) : candidates.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-6">紐付けできる配信がありません。</p>
              ) : (
                <ul className="divide-y divide-gray-100">
                  {candidates.map((b) => (
                    <li key={b.id} className="flex items-center justify-between py-2.5">
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{broadcastDisplayName({ title: b.title, broadcastId: b.id })}</p>
                        <p className="text-xs text-gray-400">{formatDate(b.sentAt ?? b.scheduledAt ?? null)}</p>
                      </div>
                      <button onClick={() => linkBroadcast(b.id)} className="ml-2 px-3 py-1.5 text-xs font-medium text-white rounded-lg shrink-0" style={{ backgroundColor: '#06C755' }}>紐付ける</button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-50 rounded-lg p-3 text-center">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="mt-1 text-lg font-bold text-gray-900 tabular-nums">{value}</p>
    </div>
  )
}
