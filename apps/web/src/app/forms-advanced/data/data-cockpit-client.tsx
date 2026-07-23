'use client'

import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import Link from 'next/link'
import Header from '@/components/layout/header'
import DataCockpit from '@/components/forms-advanced/data-cockpit'
import ExternalEditApprovalDialog from '@/components/forms-advanced/external-edit-approval-dialog'
import {
  formsAdvancedApi,
  formalooDataApi,
  type RowsQuery,
  type RowsPage,
  type FormStats,
  type SavedFilter,
  type RowDetail,
  type RowEditFieldMeta,
} from '@/lib/formaloo-advanced-api'
import { fetchApi } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { csvDateStamp, safeFilenamePart } from '@/lib/download'
import { formatJstMinute } from '@/lib/datetime'
import { fileAnswerSummary, fileSizeLabel, isFileAnswer, type FileAnswerEntry } from '@/lib/file-answer'

const DEFAULT_QUERY: RowsQuery = { sort: 'desc', page: 1, pageSize: 25 }
type RenderBackendState = 'unknown' | 'formaloo' | 'internal'

/** slug → field ラベル (無ければ slug 自身)。回答詳細の read-only 表示を分かりやすくする。 */
function labelForSlug(detail: RowDetail, slug: string): string {
  return (detail.fields ?? []).find((f) => f.slug === slug)?.label ?? slug
}

function readonlyAnswerText(value: unknown): string {
  if (isFileAnswer(value)) return fileAnswerSummary(value)
  if (typeof value === 'boolean') return value ? 'はい' : 'いいえ'
  if (Array.isArray(value)) return value.length > 0
    ? value.map(readonlyAnswerText).join('、')
    : '—'
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
    return entries.length > 0
      ? entries.map(([key, nested]) => `${key}: ${readonlyAnswerText(nested)}`).join('、')
      : '—'
  }
  return String(value ?? '—')
}

type DetailAnswerItem = { slug: string; label: string; value: unknown }

/** 0 / false は有効な回答。空白・空配列・空 object だけを未回答として扱う。 */
function hasReadableAnswer(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.some(hasReadableAnswer)
  if (typeof value === 'object') return Object.values(value).some(hasReadableAnswer)
  return true
}

/** field 定義順を正本にし、定義外の回答も末尾へ残して安定分割する。 */
function detailAnswerSections(detail: RowDetail): {
  answered: DetailAnswerItem[]
  unanswered: DetailAnswerItem[]
} {
  const ordered: DetailAnswerItem[] = []
  const seen = new Set<string>()
  for (const field of detail.fields ?? []) {
    if (seen.has(field.slug)) continue
    seen.add(field.slug)
    ordered.push({ slug: field.slug, label: field.label, value: detail.answers[field.slug] })
  }
  for (const [slug, value] of Object.entries(detail.answers)) {
    if (seen.has(slug)) continue
    seen.add(slug)
    ordered.push({ slug, label: labelForSlug(detail, slug), value })
  }
  return {
    answered: ordered.filter((item) => hasReadableAnswer(item.value)),
    unanswered: ordered.filter((item) => !hasReadableAnswer(item.value)),
  }
}

/** 複合値は項目ごとのリスト、通常値は改行を保つテキストとして表示する。 */
function ReadonlyAnswerValue({ value }: { value: unknown }): ReactNode {
  if (Array.isArray(value)) {
    if (value.length === 0) return '—'
    const includesComposite = value.some((item) => item !== null && typeof item === 'object')
    if (!includesComposite) return readonlyAnswerText(value)
    return (
      <ul className="space-y-1" role="list">
        {value.map((item, index) => (
          <li key={index} className="rounded-md bg-gray-50 px-2 py-1.5" role="listitem">
            <ReadonlyAnswerValue value={item} />
          </li>
        ))}
      </ul>
    )
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length === 0) return '—'
    return (
      <ul className="space-y-1" role="list">
        {entries.map(([key, nested]) => (
          <li key={key} className="min-w-0 rounded-md bg-gray-50 px-2 py-1.5" role="listitem">
            <span className="font-medium text-gray-600">{key}: </span>
            <ReadonlyAnswerValue value={nested} />
          </li>
        ))}
      </ul>
    )
  }
  return readonlyAnswerText(value)
}

function canEditField(field: RowEditFieldMeta): boolean {
  return field.editableWhenVisible ?? field.editable
}

type EditValue = string | string[]
type AttachmentEditValue = { removedIndexes: number[]; files: File[] }

const INLINE_ATTACHMENT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])

function attachmentIcon(name: string, type = ''): string {
  const extension = name.match(/\.([^.]+)$/)?.[1]
  if (extension) return extension.toUpperCase().slice(0, 5)
  return type.split('/')[1]?.toUpperCase().slice(0, 5) || 'FILE'
}

function ExistingAttachmentThumbnail(props: {
  formId: string
  rowId: string
  fieldId: string
  index: number
  name: string
}) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    let objectUrl: string | null = null
    void formalooDataApi.fetchAttachmentBlob(props.formId, props.rowId, props.fieldId, props.index)
      .then((blob) => {
        if (!active) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch(() => { if (active) setUrl(null) })
    return () => {
      active = false
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [props.fieldId, props.formId, props.index, props.rowId])
  return url ? (
    <img src={url} alt={`${props.name} のプレビュー`} className="h-14 w-14 shrink-0 rounded-lg bg-gray-100 object-cover" />
  ) : (
    <span className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-gray-100 text-[10px] font-bold text-gray-600">画像</span>
  )
}

function AddedAttachmentThumbnail({ file }: { file: File }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!INLINE_ATTACHMENT_IMAGE_TYPES.has(file.type.toLowerCase())) return
    const objectUrl = URL.createObjectURL(file)
    setUrl(objectUrl)
    return () => URL.revokeObjectURL(objectUrl)
  }, [file])
  return url ? (
    <img src={url} alt={`${file.name} のプレビュー`} className="h-14 w-14 shrink-0 rounded-lg bg-gray-100 object-cover" />
  ) : (
    <span className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-gray-100 text-[10px] font-bold text-gray-600">
      {attachmentIcon(file.name, file.type)}
    </span>
  )
}

function initialEditValue(field: RowEditFieldMeta, value: unknown): EditValue {
  if (field.type === 'yes_no') {
    if (value === true) return 'yes'
    if (value === false) return 'no'
  }
  if (field.type === 'multiple_select') {
    if (Array.isArray(value)) return value.map(String)
    return value == null || value === '' ? [] : [String(value)]
  }
  return String(value ?? '')
}

function editPayloadValue(field: RowEditFieldMeta, value: EditValue): unknown {
  if (field.type === 'multiple_select') {
    return Array.isArray(value) ? [...value] : value === '' ? [] : [value]
  }
  return Array.isArray(value) ? value.join('、') : value
}

function editInputValue(value: EditValue | undefined): string {
  return Array.isArray(value) ? value.join('、') : value ?? ''
}

function editValueChanged(field: RowEditFieldMeta, value: EditValue, original: unknown): boolean {
  return JSON.stringify(editPayloadValue(field, value))
    !== JSON.stringify(editPayloadValue(field, initialEditValue(field, original)))
}

function multipleSelectOptions(field: RowEditFieldMeta, value: EditValue | undefined): string[] {
  return Array.from(new Set([
    ...(field.choices ?? []),
    ...(Array.isArray(value) ? value : []),
  ]))
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
  const [editValues, setEditValues] = useState<Record<string, EditValue>>({})
  const [attachmentEdits, setAttachmentEdits] = useState<Record<string, AttachmentEditValue>>({})
  const [editError, setEditError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [reviewingExternalEdit, setReviewingExternalEdit] = useState(false)

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
    try {
      setDetail(await formalooDataApi.row(id, rowId))
      setEditMode(false)
      setAttachmentEdits({})
      setEditError(null)
      setConfirmingDelete(false)
      setDeleteError(null)
      setReviewingExternalEdit(false)
    } catch { setNotice('回答の取得に失敗しました') }
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
  const closeDetail = () => {
    setDetail(null)
    setEditMode(false)
    setAttachmentEdits({})
    setEditError(null)
    setConfirmingDelete(false)
    setDeleteError(null)
    setReviewingExternalEdit(false)
  }
  const deleteAnswer = async () => {
    if (!detail || detail.source !== 'internal') return
    const rowId = detail.id
    setDeleting(true)
    setDeleteError(null)
    try {
      await formalooDataApi.deleteRow(id, rowId)
      closeDetail()
      setNotice('回答を削除しました')
      await Promise.all([loadRows(query), refreshStats()])
    } catch (e) {
      setDeleteError((e as { body?: { error?: string } })?.body?.error ?? '削除に失敗しました')
    } finally {
      setDeleting(false)
    }
  }
  const finishExternalEditApproval = async () => {
    setReviewingExternalEdit(false)
    closeDetail()
    await Promise.all([loadRows(query), refreshStats()])
  }
  // internal は共通 /ife/ へ遷移し、旧 inline 編集は外部データ向けに残す。
  const startEdit = async () => {
    if (!detail) return
    if (detail.source === 'internal') {
      try {
        const response = await fetchApi<{ data: { editUrl: string } }>(
          `/api/forms-advanced/${encodeURIComponent(id)}/rows/${encodeURIComponent(detail.id)}/admin-edit-url`,
          { method: 'POST' },
        )
        globalThis.location.assign(response.data.editUrl)
      } catch {
        setNotice('編集画面を開けませんでした。再読み込みして、もう一度お試しください。')
      }
      return
    }
    const init: Record<string, EditValue> = {}
    const initialAttachments: Record<string, AttachmentEditValue> = {}
    for (const field of detail.fields ?? []) {
      if (canEditField(field)) init[field.slug] = initialEditValue(field, detail.answers[field.slug])
      if (detail.source === 'internal' && field.type === 'file' && field.attachmentManageable) {
        initialAttachments[field.slug] = { removedIndexes: [], files: [] }
      }
    }
    setEditValues(init); setAttachmentEdits(initialAttachments); setEditError(null); setEditMode(true)
  }
  const saveEdit = async () => {
    if (!detail) return
    // required 検証: 必須の編集可能 field を空にすると保存を止める (Formaloo は非強制ゆえ harness 側)。
    const missing = (detail.fields ?? []).filter((f) => (
      f.editable && f.required && editInputValue(editValues[f.slug]).trim() === ''
    ))
    if (missing.length > 0) { setEditError(`必須項目を入力してください: ${missing.map((f) => f.label).join('、')}`); return }
    const editAnswers: Record<string, unknown> = {}
    for (const field of detail.fields ?? []) {
      const value = editValues[field.slug] ?? ''
      if (canEditField(field) && (
        field.editable || editValueChanged(field, value, detail.answers[field.slug])
      )) {
        editAnswers[field.slug] = editPayloadValue(field, value)
      }
    }
    const attachmentChanges = (detail.fields ?? []).flatMap((field, fieldIndex) => {
      const change = attachmentEdits[field.slug]
      if (!change || (change.removedIndexes.length === 0 && change.files.length === 0)) return []
      return [{
        fieldIndex,
        fieldId: field.slug,
        removedIndexes: [...change.removedIndexes],
        files: [...change.files],
      }]
    })
    if (
      attachmentChanges.length > 0
      && (detail.editVersion === undefined || detail.answerRevision === undefined)
    ) {
      setEditError('添付を保存するには、回答を再読み込みしてください')
      return
    }
    setSaving(true); setEditError(null)
    try {
      const updated = attachmentChanges.length > 0
        ? await formalooDataApi.editRow(
            id,
            detail.id,
            editAnswers,
            detail.editVersion,
            detail.answerRevision,
            { attachments: attachmentChanges },
          )
        : detail.editVersion === undefined || detail.answerRevision === undefined
          ? await formalooDataApi.editRow(id, detail.id, editAnswers)
          : await formalooDataApi.editRow(
              id,
              detail.id,
              editAnswers,
              detail.editVersion,
              detail.answerRevision,
            )
      // 反映確認済 (worker が persist 保証)。詳細と一覧を更新。
      setDetail({
        ...detail,
        answers: updated.answers,
        source: updated.source,
        allowPostEdit: updated.allowPostEdit ?? detail.allowPostEdit,
        fields: updated.fields ?? detail.fields,
        editVersion: updated.editVersion ?? detail.editVersion,
        answerRevision: updated.answerRevision ?? detail.answerRevision,
        lastEdit: updated.lastEdit,
      })
      setEditMode(false)
      setAttachmentEdits({})
      await loadRows(query)
    } catch (e) {
      setEditError((e as { body?: { error?: string } })?.body?.error ?? '保存に失敗しました（反映されていません）')
    } finally { setSaving(false) }
  }

  const visibleDetailAnswers = detail
    ? detailAnswerSections(detail)
    : { answered: [], unanswered: [] }
  const renderDetailAnswer = (item: DetailAnswerItem) => {
    if (!detail) return null
    const answered = hasReadableAnswer(item.value)
    return (
      <div
        key={item.slug}
        data-answer-slug={item.slug}
        className="min-w-0 rounded-lg border border-gray-200 bg-white p-3"
      >
        <dt className="text-xs font-medium text-gray-500">{item.label}</dt>
        {!answered ? (
          <dd data-testid={`answer-value-${item.slug}`} className="mt-1 text-sm text-gray-400">未回答</dd>
        ) : isFileAnswer(item.value) ? (
          <dd data-testid={`answer-value-${item.slug}`} className="mt-1.5 space-y-2">
            {item.value.map((file, index) => (
              <div
                key={`${file.key}-${index}`}
                className="flex flex-col items-start gap-1.5 rounded-md bg-gray-50 p-2 text-sm text-gray-900 sm:flex-row sm:items-center"
              >
                <span className="min-w-0 break-words [overflow-wrap:anywhere]">{file.name || '添付ファイル'}</span>
                {typeof file.size === 'number' && (
                  <span className="shrink-0 text-xs text-gray-400">({fileSizeLabel(file.size)})</span>
                )}
                {detail.source === 'internal' && (
                  <button
                    type="button"
                    data-testid={`download-file-${item.slug}-${index}`}
                    onClick={() => onDownloadFile(item.slug, index, file.name || '添付ファイル')}
                    className="min-h-[40px] shrink-0 rounded-lg border border-gray-300 bg-white px-3 text-xs font-medium text-gray-700 hover:bg-gray-100 sm:ml-auto"
                  >
                    ダウンロード
                  </button>
                )}
              </div>
            ))}
          </dd>
        ) : (
          <dd
            data-testid={`answer-value-${item.slug}`}
            className="mt-1 min-w-0 whitespace-pre-wrap break-words text-sm leading-6 text-gray-900 [overflow-wrap:anywhere]"
          >
            <ReadonlyAnswerValue value={item.value} />
          </dd>
        )}
      </div>
    )
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
          <div className="h-full w-full max-w-xl overflow-x-hidden overflow-y-auto bg-white p-4 shadow-xl sm:p-6" onClick={(e) => e.stopPropagation()}>
            <div data-testid="detail-header" className="mb-3 flex items-start justify-between gap-3">
              <h2 className="text-sm font-bold text-gray-900">回答の詳細</h2>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {/* 弾M (T-D2): allow_post_edit=1 のときのみ、見つけやすい上部に「編集」を表示。 */}
                {detail.allowPostEdit === 1 && !editMode && (
                  <button
                    type="button"
                    data-testid="edit-answer"
                    onClick={() => void startEdit()}
                    className="min-h-[40px] rounded-lg bg-gray-900 px-3 text-xs font-medium text-white hover:bg-gray-700"
                  >
                    回答を編集
                  </button>
                )}
                <button
                  type="button"
                  onClick={closeDetail}
                  className="min-h-[40px] rounded-lg px-2 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-800"
                >
                  閉じる
                </button>
              </div>
            </div>
            <div className="text-xs text-gray-400">
              {formatJstMinute(detail.submittedAt)}・
              <span data-testid="answer-source">
                {detail.source === 'formaloo' ? 'Formaloo 最新' : detail.source === 'internal' ? '自前配信' : 'ミラー'}
              </span>
            </div>
            {typeof detail.verified === 'boolean' && (
              <div
                data-testid="detail-line-linkage"
                className={detail.verified
                  ? 'mt-2 inline-flex rounded-full bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700'
                  : 'mt-2 inline-flex rounded-full bg-gray-100 px-2 py-1 text-xs font-medium text-gray-600'}
              >
                {`LINE連携: ${detail.verified ? '連携済み' : '未連携'}`}
              </div>
            )}
            {/* ④ 最終編集の表示 (誰が いつ) */}
            {detail.lastEdit && (
              <div data-testid="last-edit" className="mt-1 text-xs text-amber-700">
                最終編集: {detail.lastEdit.editorName ?? '不明'}・{formatJstMinute(detail.lastEdit.editedAt)}
              </div>
            )}
            {((detail.externalEditChanges?.length ?? 0) > 0
              || Boolean(detail.externalEditSource && !detail.externalEditApprovedAt)) && (
              <section
                data-testid="detail-external-edit-changes"
                aria-labelledby="detail-external-edit-changes-heading"
                className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3"
              >
                <h3 id="detail-external-edit-changes-heading" className="text-sm font-semibold text-amber-900">
                  外部編集の変更内容
                </h3>
                {(detail.externalEditChanges?.length ?? 0) > 0 ? (
                  <ul className="mt-2 space-y-1 text-sm text-gray-700">
                    {detail.externalEditChanges?.map((change, index) => (
                      <li key={`${change.fieldId}-${index}`} className="break-words">
                        {`${labelForSlug(detail, change.fieldId)}: ${readonlyAnswerText(change.before)} → ${readonlyAnswerText(change.after)}`}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-gray-700">
                    {detail.externalEditChanges === undefined
                      ? '変更項目を取得できませんでした。再読み込みしてください。'
                      : '変更された項目はありません'}
                  </p>
                )}
                {detail.externalEditSource && !detail.externalEditApprovedAt && (
                  <button
                    type="button"
                    onClick={() => setReviewingExternalEdit(true)}
                    className="mt-3 min-h-[44px] rounded-lg border border-amber-400 bg-white px-3 text-sm font-medium text-amber-800 hover:bg-amber-100"
                  >
                    差分を確認して承認
                  </button>
                )}
              </section>
            )}

            {!editMode ? (
              <>
                <section data-testid="answered-answers" className="mt-4" aria-labelledby="answered-answers-heading">
                  <div className="flex items-center justify-between gap-2">
                    <h3 id="answered-answers-heading" className="text-sm font-semibold text-gray-900">回答済みの項目</h3>
                    <span className="rounded-full bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">
                      {visibleDetailAnswers.answered.length}件
                    </span>
                  </div>
                  <dl className="mt-2 space-y-2">
                    {visibleDetailAnswers.answered.map(renderDetailAnswer)}
                  </dl>
                  {visibleDetailAnswers.answered.length === 0 && (
                    <p className="mt-2 rounded-lg bg-gray-50 p-3 text-sm text-gray-500">回答済みの項目はありません</p>
                  )}
                </section>

                {visibleDetailAnswers.unanswered.length > 0 && (
                  <details data-testid="unanswered-answers" className="mt-4 rounded-lg border border-gray-200 bg-gray-50">
                    <summary className="min-h-[44px] cursor-pointer px-3 py-3 text-sm font-medium text-gray-700">
                      未回答の項目（{visibleDetailAnswers.unanswered.length}件）
                    </summary>
                    <dl className="space-y-2 border-t border-gray-200 p-2">
                      {visibleDetailAnswers.unanswered.map(renderDetailAnswer)}
                    </dl>
                  </details>
                )}

                {visibleDetailAnswers.answered.length === 0 && visibleDetailAnswers.unanswered.length === 0 && (
                  <div className="mt-3 text-sm text-gray-400">回答項目がありません</div>
                )}
                {detail.source === 'internal' && !confirmingDelete && (
                  <button
                    type="button"
                    onClick={() => { setConfirmingDelete(true); setDeleteError(null) }}
                    className="mt-4 rounded border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50"
                  >
                    回答を削除
                  </button>
                )}
                {detail.source === 'internal' && confirmingDelete && (
                  <div data-testid="delete-answer-confirm" className="mt-4 rounded border border-red-200 bg-red-50 p-3">
                    <p className="text-xs text-red-800">この回答を削除しますか？</p>
                    {deleteError && <p className="mt-2 text-xs text-red-700">{deleteError}</p>}
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        type="button"
                        disabled={deleting}
                        onClick={() => { setConfirmingDelete(false); setDeleteError(null) }}
                        className="rounded border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      >
                        キャンセル
                      </button>
                      <button
                        type="button"
                        disabled={deleting}
                        onClick={() => void deleteAnswer()}
                        className="rounded bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50"
                      >
                        {deleting ? '削除中…' : '削除する'}
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="mt-3 space-y-3">
                {(detail.fields ?? []).map((f, fieldIndex) => {
                  const fieldCanEdit = canEditField(f)
                  const attachmentCanEdit = detail.source === 'internal'
                    && f.type === 'file'
                    && f.attachmentManageable === true
                  const savedAnswer = detail.answers[f.slug]
                  const savedFiles: FileAnswerEntry[] = isFileAnswer(savedAnswer) ? savedAnswer : []
                  const attachmentValue = attachmentEdits[f.slug] ?? { removedIndexes: [], files: [] }
                  return <div key={f.slug} className="rounded border border-gray-100 p-2">
                    <label className="block text-xs text-gray-500">
                      {f.label}{f.required && <span className="ml-0.5 text-red-500">*</span>}
                      {!fieldCanEdit && !attachmentCanEdit && <span className="ml-1 text-[10px] text-gray-400">（この項目は編集できません）</span>}
                      {(fieldCanEdit || attachmentCanEdit) && f.visible === false && (
                        <span className="ml-1 text-[10px] text-gray-400">（条件を変えたときに入力）</span>
                      )}
                    </label>
                    {attachmentCanEdit ? (
                      <div data-testid={`edit-attachments-${f.slug}`} className="mt-2 space-y-3">
                        <ul aria-label="保存済みファイル" className="space-y-2">
                          {savedFiles.map((file, index) => (
                            <li key={`${file.key}-${index}`} className="flex min-w-0 items-center gap-2 rounded-md bg-gray-50 p-2">
                              {INLINE_ATTACHMENT_IMAGE_TYPES.has((file.type ?? '').toLowerCase()) ? (
                                <ExistingAttachmentThumbnail
                                  formId={id}
                                  rowId={detail.id}
                                  fieldId={f.slug}
                                  index={index}
                                  name={file.name || '添付ファイル'}
                                />
                              ) : (
                                <span className="grid h-14 w-14 shrink-0 place-items-center rounded-lg bg-gray-100 text-[10px] font-bold text-gray-600">
                                  {attachmentIcon(file.name, file.type)}
                                </span>
                              )}
                              <span className="min-w-0 flex-1">
                                <button
                                  type="button"
                                  onClick={() => void onDownloadFile(f.slug, index, file.name || '添付ファイル')}
                                  className="block min-h-[40px] max-w-full break-words text-left text-sm font-medium text-gray-900 underline [overflow-wrap:anywhere]"
                                >
                                  {file.name || '添付ファイル'}
                                </button>
                                {typeof file.size === 'number' && (
                                  <span className="block text-xs text-gray-400">{fileSizeLabel(file.size)}</span>
                                )}
                              </span>
                              <label className="flex min-h-[40px] shrink-0 items-center gap-1 text-xs text-red-700">
                                <input
                                  type="checkbox"
                                  aria-label={`${file.name || '添付ファイル'} を削除する`}
                                  checked={attachmentValue.removedIndexes.includes(index)}
                                  onChange={(event) => setAttachmentEdits((prev) => {
                                    const current = prev[f.slug] ?? { removedIndexes: [], files: [] }
                                    return {
                                      ...prev,
                                      [f.slug]: {
                                        ...current,
                                        removedIndexes: event.target.checked
                                          ? Array.from(new Set([...current.removedIndexes, index])).sort((left, right) => left - right)
                                          : current.removedIndexes.filter((savedIndex) => savedIndex !== index),
                                      },
                                    }
                                  })}
                                />
                                削除する
                              </label>
                            </li>
                          ))}
                          {savedFiles.length === 0 && (
                            <li className="rounded-md bg-gray-50 p-2 text-xs text-gray-500">保存済みファイルはありません</li>
                          )}
                        </ul>

                        <div>
                          <label htmlFor={`attachment-add-${fieldIndex}`} className="block text-xs font-medium text-gray-700">
                            ファイルを追加
                          </label>
                          <input
                            id={`attachment-add-${fieldIndex}`}
                            aria-label={`${f.label}：ファイルを追加`}
                            type="file"
                            multiple={f.attachmentConfig?.allowMultipleFiles === true}
                            accept={(f.attachmentConfig?.allowedExtensions ?? [])
                              .map((extension) => `.${extension.replace(/^\./, '').toLowerCase()}`)
                              .join(',') || undefined}
                            data-max-size-kb={f.attachmentConfig?.maxSizeKb ?? 2048}
                            onChange={(event) => {
                              const files = Array.from(event.currentTarget.files ?? [])
                              if (files.length > 0) {
                                setAttachmentEdits((prev) => {
                                  const current = prev[f.slug] ?? { removedIndexes: [], files: [] }
                                  return {
                                    ...prev,
                                    [f.slug]: {
                                      ...current,
                                      files: f.attachmentConfig?.allowMultipleFiles === true
                                        ? [...current.files, ...files]
                                        : files.slice(-1),
                                    },
                                  }
                                })
                              }
                              event.currentTarget.value = ''
                            }}
                            className="mt-1 block w-full text-xs text-gray-700 file:mr-2 file:rounded-lg file:border-0 file:bg-gray-900 file:px-3 file:py-2 file:text-xs file:font-medium file:text-white"
                          />
                        </div>

                        {attachmentValue.files.length > 0 && (
                          <ul aria-label="追加するファイル" className="space-y-2">
                            {attachmentValue.files.map((file, index) => (
                              <li key={`${file.name}-${file.lastModified}-${index}`} className="flex min-w-0 items-center gap-2 rounded-md bg-blue-50 p-2">
                                <AddedAttachmentThumbnail file={file} />
                                <span className="min-w-0 flex-1">
                                  <span className="block break-words text-sm font-medium text-gray-900 [overflow-wrap:anywhere]">{file.name}</span>
                                  <span className="block text-xs text-gray-500">{fileSizeLabel(file.size)}</span>
                                </span>
                                <button
                                  type="button"
                                  aria-label={`${file.name} を削除`}
                                  onClick={() => setAttachmentEdits((prev) => {
                                    const current = prev[f.slug] ?? { removedIndexes: [], files: [] }
                                    return {
                                      ...prev,
                                      [f.slug]: { ...current, files: current.files.filter((_savedFile, savedIndex) => savedIndex !== index) },
                                    }
                                  })}
                                  className="min-h-[40px] shrink-0 rounded-lg border border-red-200 bg-white px-3 text-xs text-red-700 hover:bg-red-50"
                                >
                                  削除
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ) : fieldCanEdit ? (
                      // F-I4: textarea 型は複数行を保つため <textarea> で描画 (input だと改行 flatten = データ毀損)。
                      f.type === 'multiple_select' ? (
                        <fieldset
                          data-testid={`edit-input-${f.slug}`}
                          className="mt-1 space-y-1 rounded border border-gray-200 p-2"
                        >
                          {multipleSelectOptions(f, editValues[f.slug]).map((choice, index) => {
                            const selected = Array.isArray(editValues[f.slug])
                              ? editValues[f.slug] as string[]
                              : []
                            return (
                              <label key={`${f.slug}-${index}`} className="flex items-center gap-2 text-sm text-gray-900">
                                <input
                                  data-testid={`edit-input-${f.slug}-${index}`}
                                  type="checkbox"
                                  checked={selected.includes(choice)}
                                  onChange={(event) => setEditValues((prev) => {
                                    const saved = prev[f.slug]
                                    const current: string[] = Array.isArray(saved) ? saved : []
                                    return {
                                      ...prev,
                                      [f.slug]: event.target.checked
                                        ? Array.from(new Set([...current, choice]))
                                        : current.filter((item) => item !== choice),
                                    }
                                  })}
                                />
                                <span>{choice}</span>
                              </label>
                            )
                          })}
                        </fieldset>
                      ) : f.type === 'yes_no' ? (
                        <select
                          data-testid={`edit-input-${f.slug}`}
                          value={editInputValue(editValues[f.slug])}
                          onChange={(e) => setEditValues((prev) => ({ ...prev, [f.slug]: e.target.value }))}
                          className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm text-gray-900"
                        >
                          <option value="">選択してください</option>
                          <option value="yes">はい</option>
                          <option value="no">いいえ</option>
                        </select>
                      ) : f.type === 'textarea' ? (
                        <textarea
                          data-testid={`edit-input-${f.slug}`}
                          rows={3}
                          value={editInputValue(editValues[f.slug])}
                          onChange={(e) => setEditValues((prev) => ({ ...prev, [f.slug]: e.target.value }))}
                          className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm text-gray-900"
                        />
                      ) : (
                        <input
                          data-testid={`edit-input-${f.slug}`}
                          type={f.type === 'number' ? 'number' : f.type === 'email' ? 'email' : f.type === 'date' ? 'date' : 'text'}
                          value={editInputValue(editValues[f.slug])}
                          onChange={(e) => setEditValues((prev) => ({ ...prev, [f.slug]: e.target.value }))}
                          className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm text-gray-900"
                        />
                      )
                    ) : (
                      <div className="mt-0.5 text-sm text-gray-500">
                        {readonlyAnswerText(detail.answers[f.slug])}
                      </div>
                    )}
                  </div>
                })}
                {editError && <div role="alert" data-testid="edit-error" className="text-xs text-red-600">{editError}</div>}
                <div className="flex items-center gap-2">
                  <button type="button" data-testid="edit-save" disabled={saving} onClick={saveEdit}
                    className="rounded bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-50">
                    {saving ? '保存中…' : '保存'}
                  </button>
                  <button type="button" onClick={() => { setEditMode(false); setAttachmentEdits({}); setEditError(null) }}
                    className="rounded border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50">
                    キャンセル
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {detail && reviewingExternalEdit && detail.externalEditSource && (
        <ExternalEditApprovalDialog
          formId={id}
          rowId={detail.id}
          source={detail.externalEditSource}
          editedAt={detail.externalEditedAt ?? null}
          changes={detail.externalEditChanges?.map((change) => ({
            ...change,
            label: labelForSlug(detail, change.fieldId),
          }))}
          onClose={() => setReviewingExternalEdit(false)}
          onApproved={finishExternalEditApproval}
        />
      )}
    </div>
  )
}
