'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import Header from '@/components/layout/header'
import DataCockpit from '@/components/forms-advanced/data-cockpit'
import {
  formsAdvancedApi,
  formalooDataApi,
  type RowsQuery,
  type RowsPage,
  type FormStats,
  type SavedFilter,
} from '@/lib/formaloo-advanced-api'
import { fetchApi } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { csvDateStamp, safeFilenamePart } from '@/lib/download'

const DEFAULT_QUERY: RowsQuery = { sort: 'desc', page: 1, pageSize: 25 }

// F-4 データコックピット本体。id は data/page.tsx が ?id= から解決して渡す (static export 互換 / 新地雷)。
export default function DataCockpitClient({ id }: { id: string }) {
  const { selectedAccountId } = useAccount()
  const [title, setTitle] = useState('')
  // F6-2 表示スコープ: 読み込んだ form の lineAccountId (undefined=未取得 / null=共通)。
  const [formAccountId, setFormAccountId] = useState<string | null | undefined>(undefined)
  const [rowsPage, setRowsPage] = useState<RowsPage>({ rows: [], total: 0, page: 1, pageSize: 25 })
  const [stats, setStats] = useState<FormStats | null>(null)
  const [filters, setFilters] = useState<SavedFilter[]>([])
  const [isOwner, setIsOwner] = useState(false)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const [query, setQuery] = useState<RowsQuery>(DEFAULT_QUERY)
  const [detail, setDetail] = useState<{ id: string; answers: Record<string, unknown>; submittedAt: string; source: string } | null>(null)

  const loadRows = useCallback(async (q: RowsQuery) => {
    try {
      setRowsPage(await formalooDataApi.rows(id, q))
    } catch {
      setRowsPage({ rows: [], total: 0, page: 1, pageSize: q.pageSize ?? 25 })
    }
  }, [id])

  const refreshStats = useCallback(async () => {
    try { setStats(await formalooDataApi.stats(id)) } catch { /* fail-soft */ }
  }, [id])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [form] = await Promise.all([
        formsAdvancedApi.get(id).catch(() => null),
        refreshStats(),
        formalooDataApi.listFilters(id).then(setFilters).catch(() => setFilters([])),
        loadRows(DEFAULT_QUERY),
      ])
      if (form) {
        setTitle(form.title)
        setFormAccountId(form.lineAccountId)
      }
      try {
        const me = await fetchApi<{ data: { role: string } }>('/api/staff/me')
        setIsOwner(me.data.role === 'owner')
      } catch { /* 非 owner 扱い */ }
    } finally {
      setLoading(false)
    }
  }, [id, loadRows, refreshStats])

  useEffect(() => { void load() }, [load])

  const onQuery = (q: RowsQuery) => { setQuery(q); void loadRows(q) }
  const onSaveFilter = async (name: string, filter: Record<string, unknown>) => {
    try { await formalooDataApi.saveFilter(id, name, filter); setFilters(await formalooDataApi.listFilters(id)) } catch { setNotice('フィルタの保存に失敗しました') }
  }
  const onDeleteFilter = async (fid: string) => {
    try { await formalooDataApi.deleteFilter(id, fid); setFilters(await formalooDataApi.listFilters(id)) } catch { /* noop */ }
  }
  const onExport = async () => {
    try { await formalooDataApi.exportCsv(id, `formaloo_${safeFilenamePart(title || id)}_${csvDateStamp()}.csv`) } catch (e) { setNotice((e as { message?: string })?.message ?? 'CSV の出力に失敗しました') }
  }
  const onImport = async (csv: string) => {
    try { const r = await formalooDataApi.importCsv(id, csv); setNotice(r.note); await Promise.all([loadRows(query), refreshStats()]) } catch (e) { setNotice((e as { body?: { error?: string } })?.body?.error ?? 'CSV の取り込みに失敗しました') }
  }
  const onBulkDelete = async (ids: string[]) => {
    try { const r = await formalooDataApi.bulkDelete(id, ids); setNotice(`${r.deleted}件を削除しました`); await Promise.all([loadRows(query), refreshStats()]) } catch (e) { setNotice((e as { body?: { error?: string } })?.body?.error ?? '削除に失敗しました') }
  }
  const onOpenRow = async (rowId: string) => {
    try { setDetail(await formalooDataApi.row(id, rowId)) } catch { setNotice('回答の取得に失敗しました') }
  }

  // F6-2 表示スコープ照合 (Codex B#3): 別アカウント向け form の回答データは表示しない (NULL 共通は許容)。
  //   これは表示フィルタで、API 直打ちは防げない (N-17)。
  const scopeBlocked =
    formAccountId != null && selectedAccountId != null && formAccountId !== selectedAccountId
  // reviewer R1 P2 fail-closed: ロード完了後も form の lineAccountId が未取得 (formAccountId===undefined =
  //   form fetch 例外) か、account-scoped form で selectedAccountId が未確定 (null) の間は scope 判定不能
  //   → 回答データを描画せず hold する (fail-open で他アカウントの PII を出さない)。
  const scopeUnknown =
    !loading && (formAccountId === undefined || (formAccountId != null && selectedAccountId == null))

  if (scopeBlocked || scopeUnknown) {
    return (
      <div>
        <Header title="回答データ" description="回答の検索・集計・CSV 出し入れができます" />
        <div className="mb-3">
          <Link href="/forms-advanced" className="text-xs text-gray-500 hover:text-gray-800">← 一覧に戻る</Link>
        </div>
        {scopeBlocked ? (
          <div data-testid="scope-blocked" className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500 text-sm">
            このフォームは別の LINE アカウント向けです。表示するには対象のアカウントに切り替えてください。
            <p className="mt-3 text-[11px] text-gray-400">※これは画面上の仕分けです。URL を直接開くと表示される場合があります（アクセス制限は今後の対応です）。</p>
          </div>
        ) : (
          <div data-testid="scope-hold" className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400 text-sm">
            アカウントを確認しています。表示できない場合はアカウントを選択してから開き直してください。
          </div>
        )}
      </div>
    )
  }

  return (
    <div>
      <Header title="回答データ" description="回答の検索・集計・CSV 出し入れができます" />
      <div className="mb-3 flex items-center gap-3">
        <Link href="/forms-advanced" className="text-xs text-gray-500 hover:text-gray-800">← 一覧に戻る</Link>
        <Link href={`/forms-advanced/detail?id=${id}`} className="text-xs text-gray-500 hover:text-gray-800">フォームを編集</Link>
        {title && <span className="text-sm font-medium text-gray-800">{title}</span>}
      </div>

      {notice && (
        <div className="mb-3 rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700">
          {notice}
          <button type="button" onClick={() => setNotice(null)} className="ml-2 text-gray-400 hover:text-gray-700">×</button>
        </div>
      )}

      {loading ? (
        <div className="text-sm text-gray-400">読み込み中...</div>
      ) : (
        <DataCockpit
          formTitle={title}
          rows={rowsPage.rows}
          total={rowsPage.total}
          page={rowsPage.page}
          pageSize={rowsPage.pageSize}
          stats={stats}
          savedFilters={filters}
          isOwner={isOwner}
          loading={loading}
          onQuery={onQuery}
          onSaveFilter={onSaveFilter}
          onDeleteFilter={onDeleteFilter}
          onExport={onExport}
          onImport={onImport}
          onBulkDelete={onBulkDelete}
          onOpenRow={onOpenRow}
        />
      )}

      {detail && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={() => setDetail(null)}>
          <div className="h-full w-full max-w-md overflow-y-auto bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-bold text-gray-900">回答の詳細</h2>
              <button type="button" onClick={() => setDetail(null)} className="text-gray-400 hover:text-gray-700">閉じる</button>
            </div>
            <div className="text-xs text-gray-400">{detail.submittedAt.slice(0, 16).replace('T', ' ')}・{detail.source === 'formaloo' ? 'Formaloo 最新' : 'ミラー'}</div>
            <dl className="mt-3 space-y-2">
              {Object.entries(detail.answers).map(([k, v]) => (
                <div key={k} className="rounded border border-gray-100 p-2">
                  <dt className="text-xs text-gray-500">{k}</dt>
                  <dd className="mt-0.5 text-sm text-gray-900">{Array.isArray(v) ? v.join('、') : String(v ?? '—')}</dd>
                </div>
              ))}
              {Object.keys(detail.answers).length === 0 && <div className="text-sm text-gray-400">回答項目がありません</div>}
            </dl>
          </div>
        </div>
      )}
    </div>
  )
}
