'use client'

import { useState } from 'react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDraggable,
  useDroppable,
  type DragEndEvent,
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
} from './field-types'
import type { BuilderStatus } from '@/lib/formaloo-advanced-api'

const LINE_GREEN = '#06C755'

export interface BuilderProps {
  formTitle: string
  status: BuilderStatus
  initialFields: HarnessField[]
  initialLogic: HarnessLogicRule[]
  onSave: (def: { fields: HarnessField[]; logic: HarnessLogicRule[] }) => Promise<void> | void
  onSubmitForReview?: () => void
  onPublish?: () => void
  onUnpublish?: () => void
  publicUrl?: string | null
  embedCode?: string | null
  syncStatus?: string
}

function newField(type: HarnessFieldType): HarnessField {
  return {
    id: `f_${(crypto.randomUUID?.() ?? String(Math.random())).slice(0, 8)}`,
    type,
    label: fieldTypeLabel(type),
    required: false,
    position: 0,
    config: hasChoices(type) ? { choices: ['選択肢1', '選択肢2'] } : {},
  }
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
        <button type="button" onClick={onSelect} className="flex-1 flex items-center gap-2 text-left text-sm">
          <span aria-hidden>{fieldTypeIcon(field.type)}</span>
          <span className="font-medium">{field.label}</span>
          {field.required && <span className="text-xs text-white px-1.5 rounded" style={{ backgroundColor: LINE_GREEN }}>必須</span>}
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

  const rulesForField = logic.filter((r) => r.sourceFieldId === field.id)
  const addRule = () => {
    const other = allFields.find((f) => f.id !== field.id)
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
              {allFields.filter((f) => f.id !== field.id).map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
            <button type="button" aria-label="分岐を削除" onClick={() => onLogicChange(logic.filter((r) => r.id !== rule.id))} className="text-gray-400 hover:text-red-600">✕</button>
          </div>
        ))}
        <button type="button" onClick={addRule} disabled={allFields.length < 2} className="text-xs disabled:opacity-40" style={{ color: LINE_GREEN }}>＋ 分岐を追加</button>
      </div>
    </div>
  )
}

export default function FormBuilder(props: BuilderProps) {
  const [fields, setFields] = useState<HarnessField[]>(props.initialFields)
  const [logic, setLogic] = useState<HarnessLogicRule[]>(props.initialLogic)
  const [selectedId, setSelectedId] = useState<string | null>(props.initialFields[0]?.id ?? null)
  const [saving, setSaving] = useState(false)
  const [confirmPublish, setConfirmPublish] = useState(false)

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )
  const { setNodeRef: setCanvasRef } = useDroppable({ id: 'canvas' })

  const reposition = (list: HarnessField[]) => list.map((f, i) => ({ ...f, position: i }))

  const addField = (type: HarnessFieldType) => {
    const f = newField(type)
    setFields((cur) => reposition([...cur, f]))
    setSelectedId(f.id)
  }

  const handleDragEnd = (e: DragEndEvent) => {
    const activeId = String(e.active.id)
    // パレットからのドロップ → 新規追加
    if (activeId.startsWith('palette:')) {
      if (e.over) addField(activeId.slice('palette:'.length) as HarnessFieldType)
      return
    }
    // キャンバス内の並べ替え
    const overId = e.over ? String(e.over.id) : null
    if (!overId || activeId === overId) return
    setFields((cur) => {
      const oldIndex = cur.findIndex((f) => f.id === activeId)
      const newIndex = cur.findIndex((f) => f.id === overId)
      if (oldIndex < 0 || newIndex < 0) return cur
      return reposition(arrayMove(cur, oldIndex, newIndex))
    })
  }

  const updateField = (f: HarnessField) => setFields((cur) => cur.map((x) => (x.id === f.id ? f : x)))
  const deleteField = (id: string) => {
    setFields((cur) => reposition(cur.filter((f) => f.id !== id)))
    setLogic((cur) => cur.filter((r) => r.sourceFieldId !== id && r.targetFieldId !== id))
    if (selectedId === id) setSelectedId(null)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await props.onSave({ fields: reposition(fields), logic })
    } finally {
      setSaving(false)
    }
  }

  const selected = fields.find((f) => f.id === selectedId) ?? null
  const statusLabel = props.status === 'published' ? '公開中' : props.status === 'in_review' ? 'レビュー中' : '下書き'
  const statusColor = props.status === 'published' ? LINE_GREEN : props.status === 'in_review' ? '#F59E0B' : '#9CA3AF'

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      {/* 上部バー */}
      <div className="flex flex-wrap items-center gap-2 mb-3 pb-3 border-b border-gray-200">
        <span className="text-xs text-white px-2 py-0.5 rounded" style={{ backgroundColor: statusColor }}>{statusLabel}</span>
        {props.syncStatus === 'out_of_sync' && <span className="text-xs text-amber-600" data-testid="sync-badge">未同期</span>}
        <div className="flex-1" />
        <button type="button" onClick={handleSave} disabled={saving} className="px-3 py-1.5 rounded-lg text-xs text-white disabled:opacity-50" style={{ backgroundColor: LINE_GREEN }}>
          {saving ? '保存中...' : '保存'}
        </button>
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

      {/* 3 ペイン (375px: 縦 1 カラム / md 以上: 横 3 カラム) */}
      <div className="flex flex-col md:flex-row gap-3">
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
        <div ref={setCanvasRef} className="flex-1 min-w-0" data-testid="canvas">
          {fields.length === 0 ? (
            <div className="border-2 border-dashed border-gray-200 rounded-lg p-8 text-center text-sm text-gray-400">
              左のパレットから項目をドラッグ、またはタップして追加してください
            </div>
          ) : (
            <SortableContext items={fields.map((f) => f.id)} strategy={verticalListSortingStrategy}>
              <div className="space-y-2">
                {fields.map((f) => (
                  <FieldCard key={f.id} field={f} selected={f.id === selectedId} onSelect={() => setSelectedId(f.id)} onDelete={() => deleteField(f.id)} />
                ))}
              </div>
            </SortableContext>
          )}
        </div>

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
    </DndContext>
  )
}
