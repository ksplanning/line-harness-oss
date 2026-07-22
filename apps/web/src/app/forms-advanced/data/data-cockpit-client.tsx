'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
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
  type RowDetail,
} from '@/lib/formaloo-advanced-api'
import { fetchApi } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { csvDateStamp, safeFilenamePart } from '@/lib/download'
import { formatJstMinute } from '@/lib/datetime'
import { fileSizeLabel, isFileAnswer } from '@/lib/file-answer'

const DEFAULT_QUERY: RowsQuery = { sort: 'desc', page: 1, pageSize: 25 }
type RenderBackendState = 'unknown' | 'formaloo' | 'internal'

/** slug → field ラベル (無ければ slug 自身)。回答詳細の read-only 表示を分かりやすくする。 */
function labelForSlug(detail: RowDetail, slug: string): string {
  return (detail.fields ?? []).find((f) => f.slug === slug)?.label ?? slug
}

// F-4 データコックピット本体。id は data/page.tsx が ?id= から解決して渡す (static export 互換 / 新地雷)。
export default function DataCockpitClient({ id, initialRowId }: { id: string; initialRowId?: string | null }) {
  const { selectedAccountId } = useAccount()
  const [title, setTitle] = useState('')
  // F6-2 表示スコープ: 読み込んだ form の lineAccountId (undefined=未取得 / null=共通)。
  const [formAccountId, setFormAccountId] = useState<string | null | undefined>(undefined)
  const [rowsPage, setRowsPage] = useState<RowsPage>({ rows: [], total: 0, page: 1, pageSize: 25 })
  const [stats, setStats] = useState<FormStats | null>(null)
  const [filters, setFilters] = useState<SavedFilter[]>([])
  const [isOwner, setIsOwner] = useState(false)
  const [renderBackend, setRenderBackend] = useState<RenderBackendState>('unknown')
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<string | null>(null)
  const [query, setQuery] = useState<RowsQuery>(DEFAULT_QUERY)
  const [detail, setDetail] = useState<RowDetail | null>(null)
  // 弾M (form-post-edit / T-D2): ①管理者編集モード。allow_post_edit=1 のときのみ有効。
  const [editMode, setEditMode] = useState(false)
  const [editValues, setEditValues] = useState<Record<string, string>>({})
  const [editError, setEditError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

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
    setRenderBackend('unknown')
    try {
      const [form] = await Promise.all([
        formsAdvancedApi.get(id).catch(() => null),
        refreshStats(),
        formalooDataApi.listFilters(id).then(setFilters).catch(() => setFilters([])),
        loadRows(DEFAULT_QUERY),
      ])
      const backend: RenderBackendState = form?.renderBackend === 'internal' || form?.renderBackend === 'formaloo'
        ? form.renderBackend
        : 'unknown'
      setRenderBackend(backend)
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
    try { setDetail(await formalooDataApi.row(id, rowId)); setEditMode(false); setEditError(null) } catch { setNotice('回答の取得に失敗しました') }
  }
  const autoOpenedRef = useRef(false)
  useEffect(() => {
    if (loading || !initialRowId || autoOpenedRef.current) return
    autoOpenedRef.current = true
    void onOpenRow(initialRowId)
  }, [loading, initialRowId]) // eslint-disable-line react-hooks/exhaustive-deps
  const onDownloadFile = async (fieldId: string, index: number, name: string) => {
    if (!detail) return
    try {
      await formalooDataApi.downloadAttachment(id, detail.id, fieldId, index, name)
    } catch (error) {
      setNotice((error as { message?: string })?.message ?? 'ファイルのダウンロードに失敗しました')
    }
  }
  const closeDetail = () => { setDetail(null); setEditMode(false); setEditError(null) }
  // 弾M (T-D2): 編集モードに入る = 編集可能 field の現在値を入力欄に載せる。
  const startEdit = () => {
    if (!detail) return
    const init: Record<string, string> = {}
    for (const f of detail.fields ?? []) if (f.editable) init[f.slug] = String(detail.answers[f.slug] ?? '')
    setEditValues(init); setEditError(null); setEditMode(true)
  }
  const saveEdit = async () => {
    if (!detail) return
    // required 検証: 必須の編集可能 field を空にすると保存を止める (Formaloo は非強制ゆえ harness 側)。
    const missing = (detail.fields ?? []).filter((f) => f.editable && f.required && !String(editValues[f.slug] ?? '').trim())
    if (missing.length > 0) { setEditError(`必須項目を入力してください: ${missing.map((f) => f.label).join('、')}`); return }
    setSaving(true); setEditError(null)
    try {
      const updated = await formalooDataApi.editRow(id, detail.id, editValues)
      // 反映確認済 (worker が persist 保証)。詳細と一覧を更新。
      setDetail({ ...detail, answers: updated.answers, source: updated.source, lastEdit: updated.lastEdit })
      setEditMode(false)
      await loadRows(query)
    } catch (e) {
      setEditError((e as { body?: { error?: string } })?.body?.error ?? '保存に失敗しました（反映されていません）')
    } finally { setSaving(false) }
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
  const headerDescription = renderBackend === 'internal'
    ? '自前回答の検索・集計ができます'
    : renderBackend === 'formaloo'
      ? '回答の検索・集計・CSV 出し入れができます'
      : '回答を表示しています（配信方式を確認できません）'

  if (scopeBlocked || scopeUnknown) {
    return (
      <div>
        <Header title="回答データ" description={headerDescription} />
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
      <Header title="回答データ" description={headerDescription} />
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
          fieldLabels={rowsPage.fields}
          stats={stats}
          savedFilters={filters}
          isOwner={isOwner && renderBackend === 'formaloo'}
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
        <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={closeDetail}>
          <div className="h-full w-full max-w-md overflow-y-auto bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-bold text-gray-900">回答の詳細</h2>
              <button type="button" onClick={closeDetail} className="text-gray-400 hover:text-gray-700">閉じる</button>
            </div>
            <div className="text-xs text-gray-400">
              {formatJstMinute(detail.submittedAt)}・
              <span data-testid="answer-source">
                {detail.source === 'formaloo' ? 'Formaloo 最新' : detail.source === 'internal' ? '自前配信' : 'ミラー'}
              </span>
            </div>
            {/* ④ 最終編集の表示 (誰が いつ) */}
            {detail.lastEdit && (
              <div data-testid="last-edit" className="mt-1 text-xs text-amber-700">
                最終編集: {detail.lastEdit.editorName ?? '不明'}・{formatJstMinute(detail.lastEdit.editedAt)}
              </div>
            )}

            {!editMode ? (
              <>
                <dl className="mt-3 space-y-2">
                  {Object.entries(detail.answers).map(([k, v]) => (
                    <div key={k} className="rounded border border-gray-100 p-2">
                      <dt className="text-xs text-gray-500">{labelForSlug(detail, k)}</dt>
                      {isFileAnswer(v) ? (
                        <dd className="mt-0.5 space-y-1">
                          {v.map((file, index) => (
                            <div key={`${file.key}-${index}`} className="flex items-center justify-between gap-2 text-sm text-gray-900">
                              <span className="min-w-0 truncate">{file.name || '添付ファイル'}</span>
                              {typeof file.size === 'number' && (
                                <span className="shrink-0 text-xs text-gray-400">({fileSizeLabel(file.size)})</span>
                              )}
                              {detail.source === 'internal' && (
                                <button
                                  type="button"
                                  data-testid={`download-file-${k}-${index}`}
                                  onClick={() => onDownloadFile(k, index, file.name || '添付ファイル')}
                                  className="shrink-0 rounded border border-gray-300 px-2 py-0.5 text-xs text-gray-700 hover:bg-gray-50"
                                >
                                  ダウンロード
                                </button>
                              )}
                            </div>
                          ))}
                        </dd>
                      ) : (
                        <dd className="mt-0.5 text-sm text-gray-900">{Array.isArray(v) ? v.join('、') : String(v ?? '—')}</dd>
                      )}
                    </div>
                  ))}
                  {Object.keys(detail.answers).length === 0 && <div className="text-sm text-gray-400">回答項目がありません</div>}
                </dl>
                {/* 弾M (T-D2): allow_post_edit=1 のときのみ「編集」ボタンを表示 */}
                {detail.allowPostEdit === 1 && (
                  <button type="button" data-testid="edit-answer" onClick={startEdit}
                    className="mt-4 rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700">
                    回答を編集
                  </button>
                )}
              </>
            ) : (
              <div className="mt-3 space-y-3">
                {(detail.fields ?? []).map((f) => (
                  <div key={f.slug} className="rounded border border-gray-100 p-2">
                    <label className="block text-xs text-gray-500">
                      {f.label}{f.required && <span className="ml-0.5 text-red-500">*</span>}
                      {!f.editable && <span className="ml-1 text-[10px] text-gray-400">（この項目は編集できません）</span>}
                    </label>
                    {f.editable ? (
                      // F-I4: textarea 型は複数行を保つため <textarea> で描画 (input だと改行 flatten = データ毀損)。
                      f.type === 'textarea' ? (
                        <textarea
                          data-testid={`edit-input-${f.slug}`}
                          rows={3}
                          value={editValues[f.slug] ?? ''}
                          onChange={(e) => setEditValues((prev) => ({ ...prev, [f.slug]: e.target.value }))}
                          className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm text-gray-900"
                        />
                      ) : (
                        <input
                          data-testid={`edit-input-${f.slug}`}
                          type={f.type === 'number' ? 'number' : f.type === 'email' ? 'email' : f.type === 'date' ? 'date' : 'text'}
                          value={editValues[f.slug] ?? ''}
                          onChange={(e) => setEditValues((prev) => ({ ...prev, [f.slug]: e.target.value }))}
                          className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm text-gray-900"
                        />
                      )
                    ) : (
                      <div className="mt-0.5 text-sm text-gray-500">{String(detail.answers[f.slug] ?? '—')}</div>
                    )}
                  </div>
                ))}
                {editError && <div data-testid="edit-error" className="text-xs text-red-600">{editError}</div>}
                <div className="flex items-center gap-2">
                  <button type="button" data-testid="edit-save" disabled={saving} onClick={saveEdit}
                    className="rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50">
                    {saving ? '保存中…' : '保存'}
                  </button>
                  <button type="button" onClick={() => { setEditMode(false); setEditError(null) }}
                    className="rounded border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50">
                    キャンセル
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
