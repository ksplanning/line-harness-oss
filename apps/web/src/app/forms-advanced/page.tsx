'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { formsAdvancedApi, type AdvancedForm } from '@/lib/formaloo-advanced-api'
import { formalooWorkspacesApi, type FormalooWorkspace } from '@/lib/formaloo-workspaces-api'
import { formalooAccountBindingsApi } from '@/lib/formaloo-account-bindings-api'
import { formalooFoldersApi, type FormalooFolder } from '@/lib/formaloo-folders-api'
import { useAccount } from '@/contexts/account-context'
import { fetchApi } from '@/lib/api'

const LINE_GREEN = '#06C755'

// フォルダ絞り: null=すべて / 'none'=未分類 (sentinel = §3.3b) / それ以外=フォルダ id。
type FolderFilter = string | null

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

  // F6-3: ハーネス側フォルダ分類。
  const [folders, setFolders] = useState<FormalooFolder[]>([])
  const [selectedFolderId, setSelectedFolderId] = useState<FolderFilter>(null)
  // folder fetch も stale 応答破棄 (Codex M#5: A→B 切替後に遅い A の folder 応答で B 画面を上書きしない)。
  const folderReqToken = useRef(0)
  // F6-3b (CRUD race): 常に最新の選択 account を保持し、CRUD (作成/リネーム/削除/移動) の応答待ち中に
  // account を切り替えたら、旧 account 向けの reload (loadFolders/reloadForms) を破棄する。
  // reqToken guard は各 reload の「自分の stale 応答」は捨てられるが、CRUD 完了後に旧 account の reload を
  // "新規に発行" してしまう経路 (= 最新 token を握って勝つ) を塞げないため、account 同一性で発行自体を止める。
  const accountRef = useRef(selectedAccountId)
  useEffect(() => {
    accountRef.current = selectedAccountId
  }, [selectedAccountId])

  const load = useCallback(async (accountId: string, folderFilter?: string) => {
    const token = ++reqToken.current
    setLoading(true)
    try {
      // folderFilter 無指定は 1 引数呼び (F6-2 の list(accountId) 契約と byte-equivalent)。
      const data =
        folderFilter === undefined
          ? await formsAdvancedApi.list(accountId)
          : await formsAdvancedApi.list(accountId, folderFilter)
      if (token !== reqToken.current) return // stale 応答は破棄
      setForms(data)
    } catch {
      if (token !== reqToken.current) return
      setForms([])
    } finally {
      if (token === reqToken.current) setLoading(false)
    }
  }, [])

  const loadFolders = useCallback(async (accountId: string) => {
    const token = ++folderReqToken.current
    try {
      const data = await formalooFoldersApi.list(accountId)
      if (token !== folderReqToken.current) return // stale 応答は破棄 (別 account のフォルダで上書きしない)
      setFolders(Array.isArray(data) ? data : [])
    } catch {
      if (token !== folderReqToken.current) return
      setFolders([])
    }
  }, [])

  // account 文脈が確定してからフォーム一覧をロード。folder 絞りを account 絞りに重ねる (§3.3b)。
  // reviewer R1 P3: account 消失 (zero-account / 選択解除) は進行中 A を invalidate して stale cards を消す。
  useEffect(() => {
    if (accountLoading) return
    if (!selectedAccountId) {
      reqToken.current++ // 進行中の list 応答を無効化 (stale cards 残存を防ぐ)
      setForms([])
      setLoading(false)
      return
    }
    const folderFilter = selectedFolderId === null ? undefined : selectedFolderId
    void load(selectedAccountId, folderFilter)
  }, [accountLoading, selectedAccountId, selectedFolderId, load])

  // account が変わったらフォルダ絞りをリセットし、選択アカウントのフォルダを再取得 (別 account のフォルダは出さない)。
  useEffect(() => {
    setSelectedFolderId(null)
    if (accountLoading) return
    if (!selectedAccountId) {
      folderReqToken.current++ // 進行中の folder 応答を無効化
      setFolders([])
      return
    }
    void loadFolders(selectedAccountId)
  }, [accountLoading, selectedAccountId, loadFolders])

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

  // 現在のフォルダ絞りで一覧を再取得 (CRUD/移動の後に反映)。
  const reloadForms = useCallback(() => {
    if (!selectedAccountId) return
    void load(selectedAccountId, selectedFolderId === null ? undefined : selectedFolderId)
  }, [selectedAccountId, selectedFolderId, load])

  const handleCreateFolder = async () => {
    if (!selectedAccountId) return
    const acct = selectedAccountId // 応答後に account が変わっていないか判定するため固定
    const name = window.prompt('新しいフォルダ名を入力してください')
    if (!name || !name.trim()) return
    try {
      await formalooFoldersApi.create(acct, name.trim())
      if (accountRef.current !== acct) return // account 切替 → 旧 account の reload を破棄 (F6-3b race)
      await loadFolders(acct)
    } catch {
      /* fail-soft: 一覧は現状維持 */
    }
  }

  const handleRenameFolder = async (id: string, current: string) => {
    const name = window.prompt('新しいフォルダ名', current)
    if (!name || !name.trim() || !selectedAccountId) return
    const acct = selectedAccountId
    try {
      await formalooFoldersApi.rename(id, name.trim())
      if (accountRef.current !== acct) return // account 切替 → 旧 account の reload を破棄 (F6-3b race)
      await loadFolders(acct)
    } catch {
      /* fail-soft */
    }
  }

  const handleDeleteFolder = async (id: string) => {
    // 削除の安心開示: form は消えず未分類へ戻る (spec §3.2 の実利を UI で明示)。
    const ok = window.confirm('このフォルダを削除しますか？\n中のフォームは削除されず「未分類」に戻ります（消えません）。')
    if (!ok || !selectedAccountId) return
    const acct = selectedAccountId
    try {
      await formalooFoldersApi.remove(id)
      if (accountRef.current !== acct) return // account 切替 → 旧 account の reload/絞り reset を破棄 (F6-3b race)
      if (selectedFolderId === id) setSelectedFolderId(null) // 絞り中フォルダを消したら「すべて」へ
      await loadFolders(acct)
      reloadForms() // 未分類化された form を反映
    } catch {
      /* fail-soft */
    }
  }

  const handleMoveForm = async (formId: string, value: string) => {
    const folderId = value === '' ? null : value
    const acct = selectedAccountId
    try {
      await formalooFoldersApi.assign(formId, folderId)
      if (accountRef.current !== acct) return // account 切替 → 旧 account の reload を破棄 (F6-3b race)
      reloadForms()
    } catch {
      /* fail-soft: cross-account 等は server が 400・一覧は現状維持 */
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

      {/* F6-3: フォルダ分類 (ハーネス側 SoT) — 絞り込み + CRUD。 */}
      <section data-testid="folder-panel" className="bg-white rounded-lg border border-gray-200 p-3 mb-4">
        <div className="flex items-center flex-wrap gap-2">
          <span className="text-xs text-gray-500 mr-1">フォルダ:</span>
          <button
            type="button"
            data-testid="folder-filter-all"
            onClick={() => setSelectedFolderId(null)}
            className={`text-xs px-2 py-1 rounded ${selectedFolderId === null ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            すべて
          </button>
          <button
            type="button"
            data-testid="folder-filter-none"
            onClick={() => setSelectedFolderId('none')}
            className={`text-xs px-2 py-1 rounded ${selectedFolderId === 'none' ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
          >
            未分類
          </button>
          {folders.map((f) => (
            <span key={f.id} className="inline-flex items-center gap-1 rounded bg-gray-50 border border-gray-200 pl-1">
              <button
                type="button"
                data-testid={`folder-item-${f.id}`}
                onClick={() => setSelectedFolderId(f.id)}
                className={`text-xs px-2 py-1 rounded ${selectedFolderId === f.id ? 'bg-gray-800 text-white' : 'text-gray-700 hover:bg-gray-100'}`}
                // 入れ子はインデントで簡易表現 (深い折りたたみは最小 CRUD 外)。
                style={f.parentId ? { marginLeft: 8 } : undefined}
              >
                {f.parentId ? '↳ ' : ''}{f.name}
              </button>
              <button type="button" data-testid={`folder-rename-${f.id}`} onClick={() => handleRenameFolder(f.id, f.name)} className="text-[10px] text-gray-400 hover:text-gray-600 px-1" title="名前変更">✎</button>
              <button type="button" data-testid={`folder-delete-${f.id}`} onClick={() => handleDeleteFolder(f.id)} className="text-[10px] text-gray-400 hover:text-red-500 px-1" title="削除">🗑</button>
            </span>
          ))}
          <button
            type="button"
            data-testid="folder-create-btn"
            onClick={handleCreateFolder}
            disabled={!selectedAccountId}
            className="text-xs px-2 py-1 rounded border border-dashed border-gray-300 text-gray-500 hover:bg-gray-50 disabled:opacity-40"
          >
            ＋ フォルダ
          </button>
        </div>
        {/* 芯 (N-19 / Codex B#3): 正直表示。自動連動を "実行する" 肯定形操作 (ボタン/リンク) は一切置かない。 */}
        <p data-testid="formaloo-sync-note" className="text-[11px] text-gray-400 mt-2 leading-relaxed">
          このフォルダ分けはハーネス側だけの整理です。<b>Formaloo 側フォルダとは自動連動しません</b>
          （Formaloo 側で整理したい場合は Formaloo の画面で手動でお願いします）。
        </p>
      </section>

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
                  {/* フォーム→フォルダ移動 (ローカル分類 = Formaloo push なし)。共通フォームは account フォルダに入れられない。 */}
                  <div className="mb-2">
                    <select
                      data-testid={`form-move-${form.id}`}
                      value={form.folderId ?? ''}
                      onChange={(e) => handleMoveForm(form.id, e.target.value)}
                      className="w-full border border-gray-200 rounded px-2 py-1 text-xs text-gray-600"
                      title="フォルダへ移動"
                    >
                      <option value="">未分類</option>
                      {folders.map((f) => (
                        <option key={f.id} value={f.id}>{f.name}</option>
                      ))}
                    </select>
                  </div>
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
