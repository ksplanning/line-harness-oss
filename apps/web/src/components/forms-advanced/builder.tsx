'use client'

import { Children, Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  DndContext,
  DragOverlay,
  closestCenter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { HarnessField, HarnessFieldType, HarnessLogicRule } from '@line-crm/shared'
import {
  FIELD_TYPE_META,
  FIELD_CATEGORIES,
  fieldTypeLabel,
  fieldTypeIcon,
  hasChoices,
  hasLength,
  isDecoration,
} from './field-types'
import FormPreview from './form-preview'
import type { BuilderStatus } from '@/lib/formaloo-advanced-api'
import { formSyncBadge } from '@/lib/formaloo-sync-badge'

const LINE_GREEN = '#06C755'

export const MOUSE_ACTIVATION = { distance: 8 } as const
export const TOUCH_ACTIVATION = { delay: 200, tolerance: 8 } as const

export type DragEndResult =
  | { kind: 'add'; type: HarnessFieldType; index: number | null }
  | { kind: 'sort'; from: string; to: string }
  | { kind: 'outside' }
  | { kind: 'noop' }

export function resolveDragEnd(activeId: string, overId: string | null, fieldIds: string[]): DragEndResult {
  if (activeId.startsWith('palette:')) {
    const type = activeId.slice('palette:'.length) as HarnessFieldType
    if (overId == null) return { kind: 'outside' }
    if (overId === 'canvas') return { kind: 'add', type, index: null }
    const idx = fieldIds.indexOf(overId)
    return { kind: 'add', type, index: idx >= 0 ? idx : null }
  }
  if (overId == null || overId === activeId) return { kind: 'noop' }
  return { kind: 'sort', from: activeId, to: overId }
}

export interface BuilderProps {
  formTitle: string
  formDescription?: string | null
  status: BuilderStatus
  initialFields: HarnessField[]
  initialLogic: HarnessLogicRule[]
  /** preserve-raw: 初期 logic の fingerprint (reload→save の未編集判定用に carry / Batch 1)。 */
  initialLogicFingerprint?: string | null
  onSave: (def: { fields: HarnessField[]; logic: HarnessLogicRule[]; rawLogic?: unknown; logicFingerprint?: string | null; title: string; description?: string | null }) => Promise<void> | void
  onSubmitForReview?: () => void
  onPublish?: () => void
  onUnpublish?: () => void
  /** Formaloo から定義を再取り込み (pull / N-8)。ok===true の時だけ editor に反映する (B2)。 */
  onReimport?: () => Promise<{ ok: boolean; fields: HarnessField[]; logic: HarnessLogicRule[]; note?: string; rawLogic?: unknown; logicFingerprint?: string | null } | null>
  publicUrl?: string | null
  embedCode?: string | null
  syncStatus?: string
  /** formaloo-auto-pull: Formaloo 側定義変更 (drift) の状態 (none/detected/conflict/applied)。 */
  driftStatus?: string
  layoutMode?: 'mobile' | 'desktop'
}

function newField(type: HarnessFieldType): HarnessField {
  return {
    id: `f_${(crypto.randomUUID?.() ?? String(Math.random())).slice(0, 8)}`,
    type,
    label: fieldTypeLabel(type),
    required: false,
    position: 0,
    config: hasChoices(type) ? { choices: ['選択肢1', '選択肢2'] } : type === 'section' ? { text: '' } : {},
  }
}

export function DragGhost({ activeDragId, fields }: { activeDragId: string; fields: HarnessField[] }) {
  const paletteDrag = activeDragId.startsWith('palette:')
  const field = fields.find((item) => item.id === activeDragId)
  const type = paletteDrag
    ? activeDragId.slice('palette:'.length) as HarnessFieldType
    : (field?.type ?? 'text')
  const label = paletteDrag ? fieldTypeLabel(type) : (field?.label ?? '')

  return (
    <div
      data-testid="drag-ghost"
      className="flex items-center gap-2 rounded-lg border-2 bg-white px-3 py-2 text-sm font-medium shadow-lg"
      style={{ borderColor: LINE_GREEN, color: '#374151' }}
    >
      <span aria-hidden>{fieldTypeIcon(type)}</span>
      <span>{label}</span>
    </div>
  )
}

export function DropFeedback({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div
      data-testid="drop-feedback"
      role="status"
      className="mb-2 rounded-lg border px-3 py-2 text-xs"
      style={{ borderColor: LINE_GREEN, backgroundColor: '#F0FFF6', color: '#166534' }}
    >
      {message}
    </div>
  )
}

function DropPlaceholder() {
  return (
    <div
      data-testid="drop-placeholder"
      aria-hidden
      className="flex h-9 items-center justify-center rounded-lg border-2 border-dashed text-xs font-medium"
      style={{ borderColor: LINE_GREEN, backgroundColor: '#F0FFF6', color: LINE_GREEN }}
    >
      ここに追加
    </div>
  )
}

export function CanvasDropLayout({
  activeDragId,
  overId,
  fieldIds,
  children,
}: {
  activeDragId: string | null
  overId: string | null
  fieldIds: string[]
  children: ReactNode
}) {
  const items = Children.toArray(children)
  const placeholderIndex = activeDragId
    ? overId === 'canvas'
      ? fieldIds.length
      : fieldIds.indexOf(overId ?? '')
    : -1
  const paletteDragActive = activeDragId?.startsWith('palette:') ?? false

  return (
    <div
      data-testid="canvas-drop-layout"
      data-canvas-active={paletteDragActive ? 'true' : 'false'}
      className={fieldIds.length === 0 ? 'mt-2' : 'space-y-2'}
    >
      {items.map((child, index) => (
        <Fragment key={fieldIds[index] ?? index}>
          {placeholderIndex === index && <DropPlaceholder />}
          {child}
        </Fragment>
      ))}
      {placeholderIndex === fieldIds.length && <DropPlaceholder />}
    </div>
  )
}

// ── パレット項目 (click-to-add = 素人/375px 向け + drag = desktop) ──
function PaletteItem({ type, label, icon, onAdd }: { type: HarnessFieldType; label: string; icon: string; onAdd: () => void }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: `palette:${type}` })
  return (
    <button
      ref={setNodeRef}
      type="button"
      onClick={onAdd}
      aria-label={`${label}を追加`}
      className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm bg-white border border-gray-200 rounded-lg hover:border-gray-400 hover:bg-gray-50 cursor-grab"
      style={{ opacity: isDragging ? 0.5 : 1 }}
      {...attributes}
      {...listeners}
    >
      <span aria-hidden>{icon}</span>
      <span>{label}</span>
    </button>
  )
}

// ── キャンバスの field カード (sortable + 選択 + 削除は行内確認 = M-16) ──
function FieldCard({
  field,
  selected,
  onSelect,
  onDelete,
}: {
  field: HarnessField
  selected: boolean
  onSelect: () => void
  onDelete: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: field.id })
  const [confirming, setConfirming] = useState(false)
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`bg-white border rounded-lg p-3 ${selected ? 'border-2' : 'border-gray-200'}`}
    >
      <div className="flex items-center gap-2">
        <span className="text-gray-400 cursor-grab" aria-label="ドラッグして並べ替え" {...attributes} {...listeners}>
          ⋮⋮
        </span>
        <button type="button" onClick={onSelect} className="flex-1 text-left text-sm">
          {isDecoration(field.type) ? (
            field.type === 'section' ? (
              <span className="block">
                <span className="block font-bold text-gray-800">{field.label}</span>
                {field.config.text && <span className="block mt-1 text-xs text-gray-500">{field.config.text}</span>}
              </span>
            ) : (
              <span className="flex items-center gap-2 text-xs text-gray-500">
                <span className="h-px flex-1 bg-gray-200" aria-hidden />
                <span>{field.label || '改ページ'}</span>
                <span className="h-px flex-1 bg-gray-200" aria-hidden />
              </span>
            )
          ) : (
            <span className="flex items-center gap-2">
              <span aria-hidden>{fieldTypeIcon(field.type)}</span>
              <span className="font-medium">{field.label}</span>
              {field.required && <span className="text-xs text-white px-1.5 rounded" style={{ backgroundColor: LINE_GREEN }}>必須</span>}
            </span>
          )}
        </button>
        <button type="button" aria-label="設定" onClick={onSelect} className="text-gray-400 hover:text-gray-700">⚙️</button>
        {!confirming ? (
          <button type="button" aria-label="削除" onClick={() => setConfirming(true)} className="text-gray-400 hover:text-red-600">🗑️</button>
        ) : (
          // 行内確認 (window.confirm 不使用 / M-16)
          <span className="flex items-center gap-1 text-xs">
            <span>削除しますか？</span>
            <button type="button" onClick={onDelete} className="text-red-600 font-bold">はい</button>
            <button type="button" onClick={() => setConfirming(false)} className="text-gray-500">いいえ</button>
          </span>
        )}
      </div>
    </div>
  )
}

function BuilderCanvas({
  fields,
  selectedId,
  activeDragId,
  overId,
  dropFeedback,
  onSelect,
  onDelete,
}: {
  fields: HarnessField[]
  selectedId: string | null
  activeDragId: string | null
  overId: string | null
  dropFeedback: string | null
  onSelect: (id: string) => void
  onDelete: (id: string) => void
}) {
  const { setNodeRef: setCanvasRef, isOver: isCanvasOver } = useDroppable({ id: 'canvas' })
  const paletteDragActive = activeDragId?.startsWith('palette:') ?? false
  const canvasActive = isCanvasOver || paletteDragActive

  return (
    <div
      ref={setCanvasRef}
      className={`flex-1 min-w-0 rounded-lg transition-shadow ${canvasActive ? 'ring-2 ring-[#06C755] ring-offset-2' : ''}`}
      data-testid="canvas"
      data-canvas-active={canvasActive ? 'true' : 'false'}
    >
      <DropFeedback message={dropFeedback} />
      {fields.length === 0 && (
        <div className="border-2 border-dashed border-gray-200 rounded-lg p-8 text-center text-sm text-gray-400">
          左のパレットから項目をドラッグ、またはタップして追加してください
        </div>
      )}
      <SortableContext items={fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
        <CanvasDropLayout activeDragId={activeDragId} overId={overId} fieldIds={fields.map((field) => field.id)}>
          {fields.map((f) => (
            <FieldCard key={f.id} field={f} selected={f.id === selectedId} onSelect={() => onSelect(f.id)} onDelete={() => onDelete(f.id)} />
          ))}
        </CanvasDropLayout>
      </SortableContext>
    </div>
  )
}

// ── 選択 field の設定パネル ──
function SettingsPanel({
  field,
  allFields,
  logic,
  onChange,
  onLogicChange,
}: {
  field: HarnessField
  allFields: HarnessField[]
  logic: HarnessLogicRule[]
  onChange: (f: HarnessField) => void
  onLogicChange: (rules: HarnessLogicRule[]) => void
}) {
  const cfg = field.config
  const set = (patch: Partial<HarnessField>) => onChange({ ...field, ...patch })
  const setCfg = (patch: Partial<HarnessField['config']>) => onChange({ ...field, config: { ...cfg, ...patch } })

  if (isDecoration(field.type)) {
    const label = field.type === 'section' ? '見出し' : 'ラベル(任意)'
    return (
      <div className="space-y-3 text-sm" data-testid="settings-panel">
        <div>
          <label className="block text-xs text-gray-500 mb-1">{label}</label>
          <input aria-label={label} value={field.label} onChange={(e) => set({ label: e.target.value })} className="w-full border border-gray-300 rounded px-2 py-1" />
        </div>
        {field.type === 'section' && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">説明</label>
            <textarea aria-label="説明文" value={cfg.text ?? ''} onChange={(e) => setCfg({ text: e.target.value })} className="w-full border border-gray-300 rounded px-2 py-1" />
          </div>
        )}
      </div>
    )
  }

  const rulesForField = logic.filter((r) => r.sourceFieldId === field.id)
  const addRule = () => {
    const other = allFields.find((f) => f.id !== field.id && !isDecoration(f.type))
    if (!other) return
    onLogicChange([
      ...logic,
      { id: `r_${Math.random().toString(36).slice(2, 8)}`, sourceFieldId: field.id, operator: 'equals', value: '', action: 'show', targetFieldId: other.id },
    ])
  }

  return (
    <div className="space-y-3 text-sm" data-testid="settings-panel">
      <div>
        <label className="block text-xs text-gray-500 mb-1">ラベル</label>
        <input aria-label="ラベル" value={field.label} onChange={(e) => set({ label: e.target.value })} className="w-full border border-gray-300 rounded px-2 py-1" />
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" aria-label="必須" checked={field.required} onChange={(e) => set({ required: e.target.checked })} />
        <span>必須項目にする</span>
      </label>

      {hasLength(field.type) && (
        <div className="flex gap-2">
          <div className="flex-1">
            <label className="block text-xs text-gray-500 mb-1">最小文字数</label>
            <input type="number" aria-label="最小文字数" value={cfg.minLength ?? ''} onChange={(e) => setCfg({ minLength: e.target.value === '' ? undefined : Number(e.target.value) })} className="w-full border border-gray-300 rounded px-2 py-1" />
          </div>
          <div className="flex-1">
            <label className="block text-xs text-gray-500 mb-1">最大文字数</label>
            <input type="number" aria-label="最大文字数" value={cfg.maxLength ?? ''} onChange={(e) => setCfg({ maxLength: e.target.value === '' ? undefined : Number(e.target.value) })} className="w-full border border-gray-300 rounded px-2 py-1" />
          </div>
        </div>
      )}

      {hasChoices(field.type) && (
        <div>
          <label className="block text-xs text-gray-500 mb-1">選択肢</label>
          <div className="space-y-1">
            {(cfg.choices ?? []).map((choice, i) => (
              <div key={i} className="flex gap-1">
                <input
                  aria-label={`選択肢${i + 1}`}
                  value={choice}
                  onChange={(e) => {
                    const next = [...(cfg.choices ?? [])]
                    next[i] = e.target.value
                    setCfg({ choices: next })
                  }}
                  className="flex-1 border border-gray-300 rounded px-2 py-1"
                />
                <button type="button" aria-label={`選択肢${i + 1}を削除`} onClick={() => setCfg({ choices: (cfg.choices ?? []).filter((_, j) => j !== i) })} className="text-gray-400 hover:text-red-600 px-1">✕</button>
              </div>
            ))}
          </div>
          <button type="button" onClick={() => setCfg({ choices: [...(cfg.choices ?? []), `選択肢${(cfg.choices?.length ?? 0) + 1}`] })} className="mt-1 text-xs" style={{ color: LINE_GREEN }}>＋ 選択肢を追加</button>
        </div>
      )}

      {field.type === 'file' && (
        <div className="space-y-2">
          <label className="flex items-center gap-2">
            <input type="checkbox" aria-label="複数ファイル許可" checked={cfg.allowMultipleFiles ?? false} onChange={(e) => setCfg({ allowMultipleFiles: e.target.checked })} />
            <span>複数ファイルを許可</span>
          </label>
          <div>
            <label className="block text-xs text-gray-500 mb-1">許可する拡張子 (カンマ区切り)</label>
            <input
              aria-label="許可拡張子"
              value={(cfg.allowedExtensions ?? []).join(', ')}
              onChange={(e) => setCfg({ allowedExtensions: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
              placeholder="pdf, png, jpg"
              className="w-full border border-gray-300 rounded px-2 py-1"
            />
          </div>
        </div>
      )}

      {/* 条件分岐 (R1 / T-B2 GUI) */}
      <div className="pt-2 border-t border-gray-100">
        <div className="text-xs text-gray-500 mb-1">条件分岐（この項目の回答で他項目を出し分け）</div>
        {rulesForField.map((rule) => (
          <div key={rule.id} className="flex flex-wrap items-center gap-1 text-xs mb-1">
            <span>もし「</span>
            <input aria-label="分岐の値" value={rule.value} onChange={(e) => onLogicChange(logic.map((r) => (r.id === rule.id ? { ...r, value: e.target.value } : r)))} className="border border-gray-300 rounded px-1 w-20" />
            <span>」なら</span>
            <select aria-label="分岐アクション" value={rule.action} onChange={(e) => onLogicChange(logic.map((r) => (r.id === rule.id ? { ...r, action: e.target.value as HarnessLogicRule['action'] } : r)))} className="border border-gray-300 rounded px-1">
              <option value="show">表示</option>
              <option value="hide">隠す</option>
              <option value="skip">スキップ</option>
            </select>
            <select aria-label="分岐対象" value={rule.targetFieldId} onChange={(e) => onLogicChange(logic.map((r) => (r.id === rule.id ? { ...r, targetFieldId: e.target.value } : r)))} className="border border-gray-300 rounded px-1">
              {allFields.filter((f) => f.id !== field.id && !isDecoration(f.type)).map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
            <button type="button" aria-label="分岐を削除" onClick={() => onLogicChange(logic.filter((r) => r.id !== rule.id))} className="text-gray-400 hover:text-red-600">✕</button>
          </div>
        ))}
        <button type="button" onClick={addRule} disabled={allFields.filter((f) => f.id !== field.id && !isDecoration(f.type)).length < 1} className="text-xs disabled:opacity-40" style={{ color: LINE_GREEN }}>＋ 分岐を追加</button>
      </div>
    </div>
  )
}

function useAutoLayoutMode(): 'mobile' | 'desktop' {
  const [autoMode, setAutoMode] = useState<'mobile' | 'desktop'>('desktop')

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return

    const mediaQuery = window.matchMedia('(min-width: 1024px)')
    const updateMode = () => setAutoMode(mediaQuery.matches ? 'desktop' : 'mobile')
    updateMode()
    mediaQuery.addEventListener('change', updateMode)
    return () => mediaQuery.removeEventListener('change', updateMode)
  }, [])

  return autoMode
}

export default function FormBuilder(props: BuilderProps) {
  const autoMode = useAutoLayoutMode()
  const mode = props.layoutMode ?? autoMode
  const [mobileTab, setMobileTab] = useState<'edit' | 'preview'>('edit')
  const [fields, setFields] = useState<HarnessField[]>(props.initialFields)
  const [logic, setLogic] = useState<HarnessLogicRule[]>(props.initialLogic)
  const [title, setTitle] = useState(props.formTitle)
  const [description, setDescription] = useState(props.formDescription ?? '')
  // preserve-raw: rawLogic (pull 由来の Formaloo logic 逐語) + logicFingerprint (未編集判定) を opaque 保持。
  // logic 編集時は更新しない (route が carry fingerprint vs 現 logic で編集を検知する)。reload 初期は raw 無し
  // (server-side D1 が持つ) → save で fingerprint のみ carry し route が D1 rawLogic を使う。
  const [rawLogic, setRawLogic] = useState<unknown>(undefined)
  const [logicFingerprint, setLogicFingerprint] = useState<string | null>(props.initialLogicFingerprint ?? null)
  const [selectedId, setSelectedId] = useState<string | null>(props.initialFields[0]?.id ?? null)
  const [saving, setSaving] = useState(false)
  const [confirmPublish, setConfirmPublish] = useState(false)
  const [reimportConfirm, setReimportConfirm] = useState(false)
  const [reimporting, setReimporting] = useState(false)
  const [activeDragId, setActiveDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [dropFeedback, setDropFeedback] = useState<string | null>(null)
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (feedbackTimerRef.current !== null) clearTimeout(feedbackTimerRef.current)
  }, [])

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: MOUSE_ACTIVATION }),
    useSensor(TouchSensor, { activationConstraint: TOUCH_ACTIVATION }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const reposition = (list: HarnessField[]) => list.map((f, i) => ({ ...f, position: i }))

  const addField = (type: HarnessFieldType, index?: number) => {
    const f = newField(type)
    setFields((cur) => {
      const next = [...cur]
      if (typeof index === 'number') next.splice(index, 0, f)
      else next.push(f)
      return reposition(next)
    })
    setSelectedId(f.id)
  }

  const handleDragStart = (e: DragStartEvent) => {
    if (feedbackTimerRef.current !== null) {
      clearTimeout(feedbackTimerRef.current)
      feedbackTimerRef.current = null
    }
    setDropFeedback(null)
    setActiveDragId(String(e.active.id))
    setOverId(null)
  }

  const handleDragOver = (e: DragOverEvent) => {
    setOverId(e.over ? String(e.over.id) : null)
  }

  const handleDragCancel = () => {
    setActiveDragId(null)
    setOverId(null)
  }

  const handleDragEnd = (e: DragEndEvent) => {
    const activeId = String(e.active.id)
    const eventOverId = e.over ? String(e.over.id) : null
    const result = resolveDragEnd(activeId, eventOverId, fields.map((field) => field.id))

    if (result.kind === 'add') {
      addField(result.type, result.index ?? undefined)
    } else if (result.kind === 'sort') {
      // キャンバス内の並べ替え (既存挙動を維持)
      setFields((cur) => {
        const oldIndex = cur.findIndex((f) => f.id === result.from)
        const newIndex = cur.findIndex((f) => f.id === result.to)
        if (oldIndex < 0 || newIndex < 0) return cur
        return reposition(arrayMove(cur, oldIndex, newIndex))
      })
    } else if (result.kind === 'outside') {
      setDropFeedback('ここには置けません。キャンバスの上でカードを離してください')
      if (feedbackTimerRef.current !== null) clearTimeout(feedbackTimerRef.current)
      feedbackTimerRef.current = setTimeout(() => {
        setDropFeedback(null)
        feedbackTimerRef.current = null
      }, 2500)
    }

    setActiveDragId(null)
    setOverId(null)
  }

  const updateField = (f: HarnessField) => setFields((cur) => cur.map((x) => (x.id === f.id ? f : x)))
  const deleteField = (id: string) => {
    const deletingDecoration = fields.some((field) => field.id === id && isDecoration(field.type))
    setFields((cur) => reposition(cur.filter((f) => f.id !== id)))
    setLogic((cur) => cur.filter((r) =>
      r.sourceFieldId !== id
      && r.targetFieldId !== id
      && (!deletingDecoration || !r.conditions?.some((condition) => condition.sourceFieldId === id))
      && (!deletingDecoration || !r.actions?.some((action) => action.targetFieldId === id)),
    ))
    if (selectedId === id) setSelectedId(null)
  }

  const handleSave = async () => {
    if (!title.trim()) return
    setSaving(true)
    try {
      // preserve-raw: rawLogic + logicFingerprint を同梱。未編集なら route が raw を Formaloo へ verbatim 再送。
      await props.onSave({ fields: reposition(fields), logic, rawLogic, logicFingerprint, title, description })
    } finally {
      setSaving(false)
    }
  }

  // Formaloo 再取り込み (pull / N-8)。ok===true の時だけ editor を置換し、失敗 (ok:false/null) は
  // editor を保持する (B2 = 空へ潰さない)。note は親が setNotice で表示。reimporting で二重実行防止。
  const handleReimport = async () => {
    setReimportConfirm(false)
    setReimporting(true)
    try {
      const d = await props.onReimport?.()
      if (d && d.ok) {
        setFields(reposition(d.fields))
        setLogic(d.logic)
        setSelectedId(d.fields[0]?.id ?? null)
        // preserve-raw: pull の rawLogic + fingerprint を保持 (次の save で未編集なら verbatim 再送)。
        setRawLogic(d.rawLogic)
        setLogicFingerprint(d.logicFingerprint ?? null)
      }
    } finally {
      setReimporting(false)
    }
  }

  const selected = fields.find((f) => f.id === selectedId) ?? null
  const statusLabel = props.status === 'published' ? '公開中' : props.status === 'in_review' ? 'レビュー中' : '下書き'
  const statusColor = props.status === 'published' ? LINE_GREEN : props.status === 'in_review' ? '#F59E0B' : '#9CA3AF'

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {/* 上部バー */}
      <div className="flex flex-wrap items-center gap-2 mb-3 pb-3 border-b border-gray-200">
        <label className="min-w-48 flex-1">
          <span className="block text-[10px] text-gray-500 mb-0.5">タイトル</span>
          <input aria-label="フォームタイトル" value={title} onChange={(e) => setTitle(e.target.value)} className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm" />
        </label>
        <label className="min-w-56 flex-[2]">
          <span className="block text-[10px] text-gray-500 mb-0.5">説明</span>
          <textarea aria-label="フォーム説明" rows={1} value={description} onChange={(e) => setDescription(e.target.value)} className="w-full resize-y rounded border border-gray-300 bg-white px-2 py-1 text-sm" />
        </label>
        <span className="text-xs text-white px-2 py-0.5 rounded" style={{ backgroundColor: statusColor }}>{statusLabel}</span>
        {(() => {
          // drift/sync 単一 badge (優先順位: 競合>更新あり>未同期>自動反映 / formSyncBadge 共有)。
          const b = formSyncBadge({ driftStatus: props.driftStatus, syncStatus: props.syncStatus ?? 'idle' })
          if (!b) return null
          const needsReimport = b.kind === 'update' || b.kind === 'conflict'
          return (
            <span data-testid="sync-badge" className={`text-xs ${b.className}`}>
              {b.label}
              {needsReimport && <span className="ml-1 text-gray-500">→「Formaloo から再取り込み」で反映</span>}
            </span>
          )
        })()}
        <div className="flex-1" />
        <button type="button" onClick={handleSave} disabled={saving || !title.trim()} className="px-3 py-1.5 rounded-lg text-xs text-white disabled:opacity-50" style={{ backgroundColor: LINE_GREEN }}>
          {saving ? '保存中...' : '保存'}
        </button>
        {props.onReimport && !reimportConfirm && (
          <button type="button" onClick={() => setReimportConfirm(true)} disabled={reimporting} className="px-3 py-1.5 rounded-lg text-xs bg-gray-100 hover:bg-gray-200 disabled:opacity-50">
            {reimporting ? '取り込み中...' : 'Formaloo から再取り込み'}
          </button>
        )}
        {props.onReimport && reimportConfirm && (
          // 行内確認 (window.confirm 不使用 / M-16): 未保存の編集が Formaloo の内容に置き換わる旨
          <span className="flex items-center gap-1 text-xs" data-testid="reimport-confirm">
            <span>未保存の変更は破棄され Formaloo の内容に置き換わります。よろしいですか？</span>
            <button type="button" onClick={handleReimport} className="text-white px-2 py-0.5 rounded" style={{ backgroundColor: LINE_GREEN }}>はい</button>
            <button type="button" onClick={() => setReimportConfirm(false)} className="text-gray-500">いいえ</button>
          </span>
        )}
        {props.status === 'draft' && props.onSubmitForReview && (
          <button type="button" onClick={props.onSubmitForReview} className="px-3 py-1.5 rounded-lg text-xs bg-gray-100 hover:bg-gray-200">レビュー依頼</button>
        )}
        {props.status === 'in_review' && props.onPublish && !confirmPublish && (
          <button type="button" onClick={() => setConfirmPublish(true)} className="px-3 py-1.5 rounded-lg text-xs text-white" style={{ backgroundColor: LINE_GREEN }}>公開</button>
        )}
        {props.status === 'in_review' && props.onPublish && confirmPublish && (
          // publish gate 確認カード (N-7)
          <span className="flex items-center gap-1 text-xs" data-testid="publish-confirm">
            <span>公開すると埋め込み・配信リンクが有効になります。</span>
            <button type="button" onClick={props.onPublish} className="text-white px-2 py-0.5 rounded" style={{ backgroundColor: LINE_GREEN }}>公開する</button>
            <button type="button" onClick={() => setConfirmPublish(false)} className="text-gray-500">やめる</button>
          </span>
        )}
        {props.status === 'published' && props.onUnpublish && (
          <button type="button" onClick={props.onUnpublish} className="px-3 py-1.5 rounded-lg text-xs bg-gray-100 hover:bg-gray-200">非公開に戻す</button>
        )}
      </div>

      {mode === 'mobile' && (
        <div className="mb-3 grid grid-cols-2 rounded-lg bg-gray-100 p-1" aria-label="ビルダー表示切替">
          <button
            type="button"
            data-testid="preview-tab-edit"
            aria-pressed={mobileTab === 'edit'}
            onClick={() => setMobileTab('edit')}
            className={`rounded-md px-3 py-2 text-sm font-medium ${mobileTab === 'edit' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}
          >
            編集
          </button>
          <button
            type="button"
            data-testid="preview-tab-preview"
            aria-pressed={mobileTab === 'preview'}
            onClick={() => setMobileTab('preview')}
            className={`rounded-md px-3 py-2 text-sm font-medium ${mobileTab === 'preview' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}
          >
            プレビュー
          </button>
        </div>
      )}

      <div className={mode === 'desktop' ? 'flex items-start gap-4' : ''}>
        {(mode === 'desktop' || mobileTab === 'edit') && (
          /* 3 ペイン (375px: 縦 1 カラム / md 以上: 横 3 カラム) */
          <div className={`flex min-w-0 flex-col gap-3 md:flex-row ${mode === 'desktop' ? 'flex-1' : ''}`}>
            {/* 左: パレット */}
            <div className="md:w-48 md:shrink-0" data-testid="palette">
              <div className="text-xs font-bold text-gray-500 mb-2">項目を追加</div>
              {FIELD_CATEGORIES.map((cat) => (
                <div key={cat} className="mb-2">
                  <div className="text-[10px] text-gray-400 mb-1">{cat}</div>
                  <div className="grid grid-cols-2 md:grid-cols-1 gap-1">
                    {FIELD_TYPE_META.filter((m) => m.category === cat).map((m) => (
                      <PaletteItem key={m.type} type={m.type} label={m.label} icon={m.icon} onAdd={() => addField(m.type)} />
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* 中央: キャンバス */}
            <BuilderCanvas
              fields={fields}
              selectedId={selectedId}
              activeDragId={activeDragId}
              overId={overId}
              dropFeedback={dropFeedback}
              onSelect={setSelectedId}
              onDelete={deleteField}
            />

            {/* 右: 設定 */}
            <div className="md:w-64 md:shrink-0" data-testid="settings">
              <div className="text-xs font-bold text-gray-500 mb-2">項目の設定</div>
              {selected ? (
                <SettingsPanel field={selected} allFields={fields} logic={logic} onChange={updateField} onLogicChange={setLogic} />
              ) : (
                <div className="text-xs text-gray-400">項目を選ぶと設定が表示されます</div>
              )}
            </div>
          </div>
        )}

        {(mode === 'desktop' || mobileTab === 'preview') && (
          <div
            data-testid="preview-pane"
            className={mode === 'desktop' ? 'w-[399px] shrink-0 rounded-xl bg-gray-50 p-3' : 'w-full rounded-xl bg-gray-50 p-3'}
          >
            <FormPreview title={title} description={description} fields={fields} />
          </div>
        )}
      </div>

      <div data-testid="drag-overlay">
        <DragOverlay>
          {activeDragId ? <DragGhost activeDragId={activeDragId} fields={fields} /> : null}
        </DragOverlay>
      </div>
    </DndContext>
  )
}
