'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { formsAdvancedApi, type AdvancedForm } from '@/lib/formaloo-advanced-api'
import { formalooWorkspacesApi, type FormalooWorkspace } from '@/lib/formaloo-workspaces-api'
import { formalooAccountBindingsApi } from '@/lib/formaloo-account-bindings-api'
import { useAccount } from '@/contexts/account-context'
import { fetchApi } from '@/lib/api'

const LINE_GREEN = '#06C755'

function statusBadge(status: AdvancedForm['builderStatus']) {
  if (status === 'published') return { label: '公開中', color: LINE_GREEN }
  if (status === 'in_review') return { label: 'レビュー中', color: '#F59E0B' }
  return { label: '下書き', color: '#9CA3AF' }
}

export default function FormsAdvancedListPage() {
  const router = useRouter()
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const [forms, setForms] = useState<AdvancedForm[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [isOwner, setIsOwner] = useState(false)
  const [workspaces, setWorkspaces] = useState<FormalooWorkspace[]>([])
  // '' = 既定 (アカウント設定 binding / env)。owner が明示選択したときだけ workspaceId を送る。
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>('')
  // reviewer R1 P1: 作成先設定 (workspace/binding) がその account 用にロード完了するまで false。
  // account 切替の窓で「旧アカウント用に選んだ workspace 鍵」が新アカウントの form 作成に載る race を防ぐため、
  // ロード完了まで Create を disable する (併せて account 変更時に selectedWorkspaceId を即リセット)。
  const [settingsReady, setSettingsReady] = useState(false)
  // stale 応答破棄 (A 取得中に B へ切替→遅延 A 応答で B 画面を上書きしない / Codex M#9)。
  const reqToken = useRef(0)

  const load = useCallback(async (accountId: string) => {
    const token = ++reqToken.current
    setLoading(true)
    try {
      const data = await formsAdvancedApi.list(accountId)
      if (token !== reqToken.current) return // stale 応答は破棄
      setForms(data)
    } catch {
      if (token !== reqToken.current) return
      setForms([])
    } finally {
      if (token === reqToken.current) setLoading(false)
    }
  }, [])

  // account 文脈が確定してからロード (loading 中 / selectedAccountId=null は取得しない =
  // 初回に全アカウント一覧を一瞬でも出さない・作成で line_account_id=NULL の誤共通化を防ぐ / Codex M#8)。
  // reviewer R1 P3: account 消失 (zero-account / 選択解除) は進行中 A を invalidate して stale cards を消す。
  useEffect(() => {
    if (accountLoading) return
    if (!selectedAccountId) {
      reqToken.current++ // 進行中の list 応答を無効化 (stale cards 残存を防ぐ)
      setForms([])
      setLoading(false)
      return
    }
    void load(selectedAccountId)
  }, [accountLoading, selectedAccountId, load])

  // owner のみ: workspace セレクタ用に一覧 + 既定 binding を取得 (非 owner は server 解決に任せる / §3.1)。
  // reviewer R1 P1: account が変わったら即 selectedWorkspaceId='' にリセットし settingsReady=false にして、
  // 新 account 用のロードが完了 (or 失敗) するまで Create を disable する (旧 account の鍵混入を構造的に防ぐ)。
  useEffect(() => {
    let cancelled = false
    setSelectedWorkspaceId('') // 即リセット: 旧 account 用の選択を持ち越さない
    setSettingsReady(false)
    if (accountLoading || !selectedAccountId) {
      // account 未確定/未選択の間は作成不可 (ready にしない)。
      return
    }
    void (async () => {
      try {
        const me = await fetchApi<{ data: { role: string } }>('/api/staff/me')
        if (cancelled) return
        const owner = me.data.role === 'owner'
        setIsOwner(owner)
        if (!owner) {
          setSettingsReady(true) // 非 owner は workspace 送らない → ロード完了扱い
          return
        }
        const [ws, bindings] = await Promise.all([
          formalooWorkspacesApi.list().catch(() => [] as FormalooWorkspace[]),
          formalooAccountBindingsApi.list().catch(() => []),
        ])
        if (cancelled) return
        setWorkspaces(ws.filter((w) => w.isActive))
        const b = bindings.find((x) => x.lineAccountId === selectedAccountId)
        setSelectedWorkspaceId(b?.defaultWorkspaceId ?? '')
        setSettingsReady(true)
      } catch {
        // 失敗しても既定 ('') で作成できるよう ready にする (fail-soft / 非 owner 扱い)。
        if (!cancelled) setSettingsReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [accountLoading, selectedAccountId])

  const handleCreate = async () => {
    if (!selectedAccountId || !settingsReady) return
    setCreating(true)
    try {
      const form = await formsAdvancedApi.create({
        title: '新しいフォーム',
        lineAccountId: selectedAccountId,
        // workspace_id の確定は server 権威。owner が明示選択したときだけ送る (非 owner は送らない)。
        workspaceId: isOwner && selectedWorkspaceId ? selectedWorkspaceId : undefined,
      })
      router.push(`/forms-advanced/detail?id=${form.id}`)
    } catch {
      setCreating(false)
    }
  }

  // reviewer R1 P3: account discovery 完了後に選択が無い状態 (zero-account / 選択解除)。
  const noAccount = !accountLoading && !selectedAccountId
  const showLoading = accountLoading || (loading && !noAccount)

  return (
    <div>
      <Header title="高機能フォーム" description="ドラッグ&ドロップで条件分岐・ファイル添付・埋め込み対応の高機能フォームを作れます" />

      {/* N-17: 誠実な限界開示 — 表示フィルタ (画面の仕分け) であってアクセス強制ではない。 */}
      <p data-testid="scope-note" className="text-xs text-gray-400 mb-3">
        このアカウント（{selectedAccountId ? '選択中' : '未選択'}）向けのフォームと共通フォームだけを表示しています。
        ※URL を直接開くと他アカウントのフォームも見えます（アクセス制限は今後の対応です）。
      </p>

      <div className="flex items-center justify-end gap-2 mb-4">
        {isOwner && (
          <label className="flex items-center gap-1 text-xs text-gray-500">
            作成先ワークスペース
            <select
              data-testid="workspace-select"
              value={selectedWorkspaceId}
              onChange={(e) => setSelectedWorkspaceId(e.target.value)}
              className="border border-gray-300 rounded px-2 py-1 text-sm"
            >
              <option value="">既定（アカウント設定 / 環境の鍵）</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>{w.label}</option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          data-testid="create-btn"
          onClick={handleCreate}
          // reviewer R1 P1: 設定ロード未完了 (settingsReady=false) の間は作成不可 = 旧 account の鍵混入を防ぐ。
          disabled={creating || !selectedAccountId || !settingsReady}
          className="px-4 py-2 rounded-lg text-sm text-white disabled:opacity-50"
          style={{ backgroundColor: LINE_GREEN }}
        >
          {creating ? '作成中...' : '＋ 新規フォーム'}
        </button>
      </div>

      <section>
        {showLoading ? (
          <div className="text-sm text-gray-400">読み込み中...</div>
        ) : noAccount ? (
          <div data-testid="no-account" className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400 text-sm">
            表示できる LINE アカウントがありません。アカウントを追加・選択してからご利用ください。
          </div>
        ) : forms.length === 0 ? (
          <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400 text-sm">
            このアカウントの高機能フォームはまだありません。「＋ 新規フォーム」から作成してください。
          </div>
        ) : (
          <div data-testid="forms-grid" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {forms.map((form) => {
              const badge = statusBadge(form.builderStatus)
              return (
                <div key={form.id} data-testid={`form-card-${form.id}`} className="bg-white rounded-lg border border-gray-200 p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs text-white px-2 py-0.5 rounded" style={{ backgroundColor: badge.color }}>{badge.label}</span>
                    <span className="text-[10px] text-gray-400">高機能</span>
                    {form.lineAccountId == null && <span className="text-[10px] text-gray-400">共通</span>}
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
