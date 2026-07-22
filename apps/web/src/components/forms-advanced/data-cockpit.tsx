'use client'

import { useMemo, useState } from 'react'
import type { SubmissionRow, FormStats, SavedFilter, RowsQuery } from '@/lib/formaloo-advanced-api'
import { formatJstMinute } from '@/lib/datetime'
import { fileAnswerSummary, isFileAnswer } from '@/lib/file-answer'

// =============================================================================
// DataCockpit (F-4 / T-D1・T-D2) — フォームビルダーの回答データページ本体 (presentational)。
//   検索/絞り込み/ソート/ページング + 統計カード + CSV 出し入れ + 保存フィルタ + 選択削除。
//   page.tsx が API を叩いてデータ + コールバックを渡す (テスト容易・fetch 非依存)。
//   owner 向け anti-generic: 既存管理画面トーン (gray 罫線 / rounded-lg / 44px タップ)。破壊操作は
//   行内確認 (window.confirm 不使用 / M-16)。CSV export/import/一括削除は owner のみ表示 (N-9)。
// =============================================================================

const LINE_GREEN = '#06C755'
const LIST_PREVIEW_LIMIT = 3

export interface DataCockpitProps {
  formTitle: string
  rows: SubmissionRow[]
  total: number
  page: number
  pageSize: number
  stats: FormStats | null
  savedFilters: SavedFilter[]
  isOwner: boolean
  // form-response-display-fix (T-A2): 列ヘッダーを質問名で描画するための slug→label 対応 (/rows の fields)。
  //   未指定 or 未知 slug は slug fallback (後方互換)。列順は定義 (この配列) 順優先 + 定義外 slug を末尾。
  fieldLabels?: Array<{ slug: string; label: string }>
  loading?: boolean
  onQuery: (q: RowsQuery) => void
  onSaveFilter: (name: string, filter: Record<string, unknown>) => void
  onDeleteFilter: (id: string) => void
  onExport: () => void
  onImport: (csv: string) => void
  onBulkDelete: (ids: string[]) => void
  onOpenRow: (rowId: string) => void
}

function cellText(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (isFileAnswer(v)) return fileAnswerSummary(v)
  if (Array.isArray(v)) return v.join('、')
  return String(v)
}

export default function DataCockpit(props: DataCockpitProps) {
  const { rows, total, page, pageSize, stats, savedFilters, isOwner, fieldLabels } = props
  const [q, setQ] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [sort, setSort] = useState<'asc' | 'desc'>('desc')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [importText, setImportText] = useState('')
  const [saveName, setSaveName] = useState('')
  const [showSave, setShowSave] = useState(false)

  // slug→label 対応 (T-A2)。未指定/未知 slug は slug 自身へ fallback。
  const labelMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const f of fieldLabels ?? []) m.set(f.slug, f.label)
    return m
  }, [fieldLabels])
  const labelFor = (col: string) => labelMap.get(col) ?? col

  // 回答項目 (列) = 現在ページ全行の answer キーの union。
  //   列順は定義 (fieldLabels) 順を優先し、定義外の answer-slug を元の出現順で末尾に付す (T-A2)。
  const allColumns = useMemo(() => {
    const present = new Set<string>()
    for (const r of rows) for (const k of Object.keys(r.answers)) present.add(k)
    const ordered: string[] = []
    for (const f of fieldLabels ?? []) {
      if (present.has(f.slug)) { ordered.push(f.slug); present.delete(f.slug) }
    }
    // 残り (定義に無い answer-slug) は元の union 出現順で末尾へ。
    for (const r of rows) for (const k of Object.keys(r.answers)) {
      if (present.has(k)) { ordered.push(k); present.delete(k) }
    }
    return ordered
  }, [rows, fieldLabels])
  const columns = allColumns.slice(0, LIST_PREVIEW_LIMIT)
  const totalFieldCount = new Set([
    ...(fieldLabels ?? []).map((field) => field.slug),
    ...allColumns,
  ]).size
  const hiddenColumnCount = Math.max(0, totalFieldCount - columns.length)

  const currentFilter = (): RowsQuery => ({ q: q || undefined, from: from || undefined, to: to || undefined, sort, page: 1, pageSize })
  const runSearch = () => { setSelected(new Set()); props.onQuery(currentFilter()) }
  const goPage = (p: number) => props.onQuery({ ...currentFilter(), page: p })

  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  const rangeStart = total === 0 ? 0 : (page - 1) * pageSize + 1
  const rangeEnd = Math.min(total, page * pageSize)

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const applySaved = (f: SavedFilter) => {
    const flt = f.filter as RowsQuery
    setQ(typeof flt.q === 'string' ? flt.q : '')
    setFrom(typeof flt.from === 'string' ? flt.from : '')
    setTo(typeof flt.to === 'string' ? flt.to : '')
    setSort(flt.sort === 'asc' ? 'asc' : 'desc')
    props.onQuery({ ...flt, page: 1, pageSize })
  }

  return (
    <div className="space-y-4">
      {/* 統計カード */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="text-xs text-gray-500">総回答数</div>
          <div className="mt-1 text-2xl font-bold text-gray-900" data-testid="stats-total">{stats?.total ?? total}</div>
        </div>
        <div className="rounded-lg border border-gray-200 bg-white p-4">
          <div className="text-xs text-gray-500">確認済み</div>
          <div className="mt-1 text-2xl font-bold" style={{ color: LINE_GREEN }} data-testid="stats-verified">{stats?.verified ?? 0}</div>
        </div>
        <div className="col-span-2 rounded-lg border border-gray-200 bg-white p-4 sm:col-span-1">
          <div className="text-xs text-gray-500">最近の推移</div>
          <div className="mt-1 flex items-end gap-0.5" data-testid="stats-daily" aria-label="日次推移">
            {(stats?.daily ?? []).slice(-14).map((d) => (
              <div key={d.day} title={`${d.day}: ${d.count}件`} className="w-2 rounded-sm bg-emerald-200" style={{ height: `${Math.min(40, 6 + d.count * 6)}px` }} />
            ))}
            {(stats?.daily ?? []).length === 0 && <span className="text-xs text-gray-400">データなし</span>}
          </div>
        </div>
      </div>

      {/* フィルタバー */}
      <div className="rounded-lg border border-gray-200 bg-white p-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-xs text-gray-500">
            フリーワード
            <input aria-label="フリーワード検索" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') runSearch() }}
              className="mt-1 min-h-[44px] w-48 rounded-lg border border-gray-300 px-3 text-sm" placeholder="回答・友だちID" />
          </label>
          <label className="flex flex-col text-xs text-gray-500">
            期間（から）
            <input aria-label="期間開始" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 min-h-[44px] rounded-lg border border-gray-300 px-3 text-sm" />
          </label>
          <label className="flex flex-col text-xs text-gray-500">
            期間（まで）
            <input aria-label="期間終了" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 min-h-[44px] rounded-lg border border-gray-300 px-3 text-sm" />
          </label>
          <label className="flex flex-col text-xs text-gray-500">
            並び順
            <select aria-label="並び順" value={sort} onChange={(e) => setSort(e.target.value as 'asc' | 'desc')} className="mt-1 min-h-[44px] rounded-lg border border-gray-300 px-3 text-sm">
              <option value="desc">新しい順</option>
              <option value="asc">古い順</option>
            </select>
          </label>
          <button type="button" onClick={runSearch} className="min-h-[44px] rounded-lg px-4 text-sm font-medium text-white" style={{ backgroundColor: LINE_GREEN }}>検索</button>
          <button type="button" onClick={() => setShowSave((v) => !v)} className="min-h-[44px] rounded-lg border border-gray-300 px-3 text-sm text-gray-700 hover:bg-gray-50">この条件を保存</button>
        </div>

        {showSave && (
          <div className="mt-2 flex items-center gap-2" data-testid="save-filter-row">
            <input aria-label="保存名" value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="例：未対応のみ" className="min-h-[40px] w-48 rounded-lg border border-gray-300 px-3 text-sm" />
            <button type="button" onClick={() => { if (saveName.trim()) { props.onSaveFilter(saveName.trim(), currentFilter() as Record<string, unknown>); setSaveName(''); setShowSave(false) } }}
              className="min-h-[40px] rounded-lg border border-gray-300 px-3 text-sm">保存</button>
          </div>
        )}

        {savedFilters.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5" data-testid="saved-filters">
            {savedFilters.map((f) => (
              <span key={f.id} className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-1 text-xs">
                <button type="button" onClick={() => applySaved(f)} className="text-gray-700">{f.name}</button>
                <button type="button" aria-label={`${f.name} を削除`} onClick={() => props.onDeleteFilter(f.id)} className="text-gray-400 hover:text-red-500">×</button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* アクション (owner のみ) */}
      {isOwner && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={props.onExport} className="min-h-[44px] rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-700 hover:bg-gray-50">CSVエクスポート</button>
          <button type="button" onClick={() => setShowImport((v) => !v)} className="min-h-[44px] rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-700 hover:bg-gray-50">CSVインポート</button>
          {selected.size > 0 && !confirmingDelete && (
            <button type="button" onClick={() => setConfirmingDelete(true)} className="min-h-[44px] rounded-lg border border-red-300 bg-white px-3 text-sm text-red-600 hover:bg-red-50">選択削除（{selected.size}）</button>
          )}
          {confirmingDelete && (
            <span className="inline-flex items-center gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm" data-testid="delete-confirm">
              {selected.size}件を削除しますか？
              <button type="button" onClick={() => { props.onBulkDelete([...selected]); setSelected(new Set()); setConfirmingDelete(false) }} className="rounded bg-red-600 px-2 py-1 text-white">はい</button>
              <button type="button" onClick={() => setConfirmingDelete(false)} className="rounded border border-gray-300 px-2 py-1">いいえ</button>
            </span>
          )}
        </div>
      )}

      {isOwner && showImport && (
        <div className="rounded-lg border border-gray-200 bg-white p-3" data-testid="import-panel">
          <div className="text-xs text-gray-500">CSV を貼り付けて取り込みます（エクスポートした形式）。</div>
          <textarea aria-label="CSV貼り付け" value={importText} onChange={(e) => setImportText(e.target.value)} rows={4} className="mt-1 w-full rounded-lg border border-gray-300 p-2 font-mono text-xs" />
          <button type="button" onClick={() => { if (importText.trim()) { props.onImport(importText); setImportText(''); setShowImport(false) } }} className="mt-2 min-h-[40px] rounded-lg px-3 text-sm font-medium text-white" style={{ backgroundColor: LINE_GREEN }}>取り込む</button>
        </div>
      )}

      {/* 回答テーブル: 多項目フォームでも一覧は先頭3項目に絞り、全回答は詳細で確認する。 */}
      {hiddenColumnCount > 0 && (
        <div data-testid="column-summary" className="rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-sm text-gray-700">
          一覧では先頭{columns.length}項目を表示しています。残り{hiddenColumnCount}項目は「詳細」で確認できます。
        </div>
      )}
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white sm:overflow-x-auto">
        <table className="block w-full text-sm sm:table sm:min-w-full">
          <thead className="hidden bg-gray-50 text-left text-xs text-gray-500 sm:table-header-group">
            <tr>
              <th className="sticky left-0 z-20 w-[88px] bg-gray-50 px-3 py-2 font-medium">詳細</th>
              {isOwner && <th className="w-10 px-3 py-2" />}
              {columns.map((col) => <th key={col} className="px-3 py-2 font-medium">{labelFor(col)}</th>)}
              <th className="px-3 py-2 font-medium">確認状況</th>
              <th className="px-3 py-2 font-medium">送信日時</th>
            </tr>
          </thead>
          <tbody className="block sm:table-row-group">
            {rows.length === 0 && (
              <tr><td colSpan={columns.length + (isOwner ? 4 : 3)} className="block px-3 py-8 text-center text-gray-400 sm:table-cell">回答がありません</td></tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="block space-y-2 border-t border-gray-100 p-3 sm:table-row sm:space-y-0 sm:p-0">
                <td className="sticky left-0 z-10 flex bg-white py-1 sm:table-cell sm:w-[88px] sm:px-3 sm:py-2">
                  <button
                    type="button"
                    aria-label={`${r.id} の詳細`}
                    onClick={() => props.onOpenRow(r.id)}
                    className="min-h-[44px] min-w-[72px] rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    詳細
                  </button>
                </td>
                {isOwner && (
                  <td className="flex min-h-[32px] items-center gap-2 py-1 sm:table-cell sm:px-3 sm:py-2">
                    <span className="w-24 shrink-0 text-xs text-gray-500 sm:hidden">選択:</span>
                    <input type="checkbox" aria-label={`${r.id} を選択`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} className="h-4 w-4" />
                  </td>
                )}
                {columns.map((col) => (
                  <td key={col} className="flex min-w-0 gap-2 py-1 text-gray-800 sm:table-cell sm:max-w-[18rem] sm:px-3 sm:py-2">
                    <span className="w-24 shrink-0 text-xs text-gray-500 sm:hidden">{labelFor(col)}:</span>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{cellText(r.answers[col])}</span>
                  </td>
                ))}
                <td className="flex items-center gap-2 py-1 sm:table-cell sm:px-3 sm:py-2">
                  <span className="w-24 shrink-0 text-xs text-gray-500 sm:hidden">確認状況:</span>
                  <span className={r.verified
                    ? 'inline-flex rounded-full bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700'
                    : 'inline-flex rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-600'}>
                    {r.verified ? '確認済み' : '未確認'}
                  </span>
                </td>
                <td className="flex items-center gap-2 whitespace-nowrap py-1 text-xs text-gray-500 sm:table-cell sm:px-3 sm:py-2">
                  <span className="w-24 shrink-0 sm:hidden">送信日時:</span>
                  <span>{formatJstMinute(r.submittedAt)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ページング */}
      <div className="flex items-center justify-between text-sm text-gray-600">
        <span data-testid="range-label">{total}件中 {rangeStart}–{rangeEnd}</span>
        <div className="flex items-center gap-2">
          <button type="button" disabled={page <= 1} onClick={() => goPage(page - 1)} className="min-h-[40px] rounded-lg border border-gray-300 px-3 disabled:opacity-40">前へ</button>
          <span data-testid="page-label">{page} / {totalPages}</span>
          <button type="button" disabled={page >= totalPages} onClick={() => goPage(page + 1)} className="min-h-[40px] rounded-lg border border-gray-300 px-3 disabled:opacity-40">次へ</button>
        </div>
      </div>
    </div>
  )
}
