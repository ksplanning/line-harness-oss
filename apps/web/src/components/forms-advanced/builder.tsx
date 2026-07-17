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
import type { HarnessField, HarnessFieldType, HarnessLogicRule, FormDesign, FormDesignImages, FormDisplayType, RatingSubType, FormCopy } from '@line-crm/shared'
import { computeRouteTerminalWarnings } from '@line-crm/shared'
import {
  FIELD_TYPE_META,
  FIELD_CATEGORIES,
  fieldTypeLabel,
  fieldTypeIcon,
  hasChoices,
  hasMaxLength,
  hasRatingSubType,
  RATING_SUB_TYPE_OPTIONS,
  VIDEO_SIZE_PRESETS,
  isDecoration,
} from './field-types'
import FormPreview from './form-preview'
import DesignPanel from './design-panel'
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
  /** form-design (Batch D): 初期デザイン (色/画像テーマ)。未設定は空。 */
  initialDesign?: FormDesign
  /** form-route-branching (R2): 初期表示形式 (simple/multi_step)。未設定は simple 扱い表示。 */
  initialFormType?: FormDisplayType
  /** form-jp-localization: 初期の公開ページ文言 (送信ボタン/完了/送信エラー)。未設定は空 = 既定英語表示。 */
  initialFormCopy?: FormCopy
  /** form-media-limits ③: 回答者後編集の許可フラグ (0=不可 / 1=可)。未設定は 0 (=編集不可=現状挙動)。弾S は inert。 */
  initialAllowPostEdit?: number
  /** form-edit-mail-link (弾L): 編集 URL メール送付の許可フラグ (0=送らない / 1=送る)。allow_post_edit=1 でのみ有効。 */
  initialAllowEditMail?: number
  // F3: onSave は確定結果を返す。ok=完全同期(out_of_sync でない) / design=server 確定 design(新 S3 URL 含む)。
  //     warnings=jump+simple backstop 等の非ブロッキング警告 / void 返却 (throw/legacy) は「未確定」。
  onSave: (def: { fields: HarnessField[]; logic: HarnessLogicRule[]; rawLogic?: unknown; logicFingerprint?: string | null; title: string; description?: string | null; design?: FormDesign; designImages?: FormDesignImages; formType?: FormDisplayType; formCopy?: FormCopy; allowPostEdit?: number; allowEditMail?: number }) => Promise<{ ok: boolean; design?: FormDesign; warnings?: string[] } | void> | void
  onSubmitForReview?: () => void
  onPublish?: () => void
  onUnpublish?: () => void
  /** Formaloo から定義を再取り込み (pull / N-8)。ok===true の時だけ editor に反映する (B2)。design/formType も復元 (F2)。 */
  onReimport?: () => Promise<{ ok: boolean; fields: HarnessField[]; logic: HarnessLogicRule[]; note?: string; rawLogic?: unknown; logicFingerprint?: string | null; design?: FormDesign; formType?: FormDisplayType } | null>
  publicUrl?: string | null
  embedCode?: string | null
  syncStatus?: string
  /** ① 未同期リカバリ用の原因表示 (sync last_error)。out_of_sync 時に『未同期』の隣へ出す。 */
  syncError?: string | null
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
    config: hasChoices(type) ? { choices: ['選択肢1', '選択肢2'] } : type === 'section' ? { text: '' } : type === 'video' ? { videoUrl: '' } : {},
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
// form-media-limits ②: 「動画を許可」checkbox が allowedExtensions へ射影する curated 動画拡張子。
// checkbox は allowedExtensions の派生状態 (含む/空) を都度計算し、拡張子 input と単一 source を共有する (RK-7)。
const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'webm']
// form-media-limits ①: 最大サイズの保守的プリセット (KB)。動画許可時のみ 50MB(51200) を追加露出 (RK-8)。
// API clamp は 102400 だが UI は巨大 upload/プラン超過リスク回避で保守的に留める。
const MAX_SIZE_PRESETS_KB = [2048, 5120, 10240, 20480]
const maxSizeLabel = (kb: number): string => (kb === 2048 ? '2MB（標準）' : `${Math.round(kb / 1024)}MB`)

function SettingsPanel({
  field,
  allFields,
  logic,
  onChange,
  onLogicChange,
  formType,
  onEnsureMultiStep,
}: {
  field: HarnessField
  allFields: HarnessField[]
  logic: HarnessLogicRule[]
  onChange: (f: HarnessField) => void
  onLogicChange: (rules: HarnessLogicRule[]) => void
  /** 表示形式 (form-route-branching R2)。jump は multi_step でのみ発火 → simple での警告/自動切替に使う。 */
  formType?: FormDisplayType
  /** jump アクション選択時に simple なら multi_step へ自動切替 (可視通知) させる親コールバック。 */
  onEnsureMultiStep?: () => void
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
        {/* treasure-b1-palette: video(oembed) の埋め込み URL。空だと保存 hold (空 url oembed PATCH=500 回避)。 */}
        {field.type === 'video' && (
          <>
            <div>
              <label className="block text-xs text-gray-500 mb-1">動画URL</label>
              <input
                aria-label="動画URL"
                value={cfg.videoUrl ?? ''}
                onChange={(e) => setCfg({ videoUrl: e.target.value })}
                placeholder="https://www.youtube.com/watch?v=..."
                className="w-full border border-gray-300 rounded px-2 py-1"
              />
              <p className="mt-1 text-[10px] text-gray-400 leading-snug">
                YouTube / Vimeo などの埋め込み対応 URL を入力してください。URL 未入力のままでは保存できません（対応外の URL は保存時にエラーになります）。
              </p>
            </div>
            {/* b1-field-polish: 動画の表示サイズ (空=既定 250px)。既定薄帯 (100px) で再生できない問題の修理。 */}
            <div>
              <label className="block text-xs text-gray-500 mb-1" htmlFor={`video-size-${field.id}`}>表示サイズ</label>
              <select
                id={`video-size-${field.id}`}
                aria-label="表示サイズ"
                value={cfg.videoHeight ?? ''}
                onChange={(e) => setCfg({ videoHeight: e.target.value ? e.target.value : undefined })}
                className="w-full border border-gray-300 rounded px-2 py-1"
              >
                <option value="">（既定）</option>
                {VIDEO_SIZE_PRESETS.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
              <p className="mt-1 text-[10px] text-gray-400 leading-snug">
                公開フォームでの動画の高さです。「（既定）」は再生しやすい標準サイズになります。
              </p>
            </div>
          </>
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
  // route-terminal-submit (F-MED-1): submit 状態遷移を一元化。
  //   host required は「残存 submit があれば true / 無ければ元値 (terminalHostWasRequired) へ復元」で再計算する。
  const hostHasSubmit = (list: HarnessLogicRule[]) => list.some((r) => r.sourceFieldId === field.id && r.action === 'submit')
  const firstPageId = () => allFields.find((f) => f.type === 'page_break')?.id ?? ''
  const firstOtherFieldId = () => allFields.find((f) => f.id !== field.id && !isDecoration(f.type))?.id ?? ''
  // logic 差替 + required 再計算。restoreRequired = submit が host から消えた時に戻す元値。
  const applyLogic = (nextLogic: HarnessLogicRule[], restoreRequired?: boolean) => {
    onLogicChange(nextLogic)
    if (hostHasSubmit(nextLogic)) { if (!field.required) set({ required: true }) }
    else if (restoreRequired !== undefined) set({ required: restoreRequired })
  }
  // 「ここで送信」rule 追加 (target 空=既定完了ページ / Phase1)。**同一 host に既に submit があれば追加しない (先頭勝ち)**。
  const addSubmitRule = () => {
    if (hostHasSubmit(logic)) return // 重複 submit 禁止 (F-MED-1 / T-B3 先頭勝ち)
    applyLogic([
      ...logic,
      { id: `r_${Math.random().toString(36).slice(2, 8)}`, sourceFieldId: field.id, operator: 'equals', value: '', action: 'submit', targetFieldId: '', terminalTrigger: 'on_answered', terminalHostWasRequired: field.required },
    ])
    if (formType !== 'multi_step') onEnsureMultiStep?.()
  }
  // action select 変更。submit 入場=正規化(空値/空target/terminalTrigger/元 required 保存)・submit 退場=terminal metadata 除去 + 有効 target 設定。
  const onActionChange = (rule: HarnessLogicRule, nextAction: HarnessLogicRule['action']) => {
    if (nextAction === rule.action) return
    // 重複 submit 禁止: 別 rule が既に host を submit で閉じている状態で submit へ変更しない (先頭勝ち)。
    if (nextAction === 'submit' && logic.some((r) => r.id !== rule.id && r.sourceFieldId === field.id && r.action === 'submit')) return
    const wasRequired = field.required
    const leavingSubmit = rule.action === 'submit' && nextAction !== 'submit'
    const nextLogic = logic.map((r) => {
      if (r.id !== rule.id) return r
      const next: HarnessLogicRule = { ...r, action: nextAction }
      if (nextAction === 'submit') {
        next.targetFieldId = '' // Phase1: 既定完了ページ (target 空)
        next.terminalTrigger = 'on_answered'
        if (next.terminalHostWasRequired === undefined) next.terminalHostWasRequired = wasRequired
      } else {
        // submit / 他 action からの離脱: terminal metadata を除去し **有効 target** を設定 (target 空だと save filter で消える)。
        delete next.terminalTrigger
        delete next.terminalHostWasRequired
        if (nextAction === 'jump') {
          const curIsPage = allFields.some((f) => f.id === r.targetFieldId && f.type === 'page_break')
          next.targetFieldId = curIsPage ? r.targetFieldId : firstPageId()
        } else {
          const curValid = allFields.some((f) => f.id === r.targetFieldId && f.id !== field.id && !isDecoration(f.type))
          next.targetFieldId = curValid ? r.targetFieldId : firstOtherFieldId()
        }
      }
      return next
    })
    // 多層防御 (主機構): jump/submit 選択で simple なら multi_step へ自動切替 (可視通知は親が表示)。
    if ((nextAction === 'jump' || nextAction === 'submit') && formType !== 'multi_step') onEnsureMultiStep?.()
    // required 再計算: submit 離脱時は元値復元 (残存 submit があれば applyLogic 内で true 維持)。
    applyLogic(nextLogic, leavingSubmit ? (rule.terminalHostWasRequired ?? false) : undefined)
  }
  // rule 削除。submit rule 削除は host の required を再計算 (残存 submit 無ければ元値へ復元)。
  const onDeleteRule = (rule: HarnessLogicRule) => {
    applyLogic(logic.filter((r) => r.id !== rule.id), rule.action === 'submit' ? (rule.terminalHostWasRequired ?? false) : undefined)
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

      {/* 補足説明 (Help text / 全入力型)。ラベルの下に記入例・注意書きを添える。section 本文(config.text)とは別欄。 */}
      <div>
        <label className="block text-xs text-gray-500 mb-1">補足説明</label>
        <textarea
          aria-label="補足説明"
          value={cfg.description ?? ''}
          onChange={(e) => setCfg({ description: e.target.value || undefined })}
          placeholder="例: 日中つながる番号をご記入ください"
          className="w-full border border-gray-300 rounded px-2 py-1"
        />
      </div>

      {/* treasure-b1-palette: rating の評価スタイル(sub_type)。星=既定は config.ratingSubType を未設定に写像(star drop)。 */}
      {hasRatingSubType(field.type) && (
        <div>
          <label className="block text-xs text-gray-500 mb-1">評価スタイル</label>
          <select
            aria-label="評価スタイル"
            value={cfg.ratingSubType ?? 'star'}
            onChange={(e) => {
              const v = e.target.value as RatingSubType
              setCfg({ ratingSubType: v === 'star' ? undefined : v })
            }}
            className="w-full border border-gray-300 rounded px-2 py-1"
          >
            {RATING_SUB_TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </div>
      )}

      {/* 最大文字数は一行テキストのみ (OD-2: Formaloo hosted が max_length を enforce する唯一の型)。
          複数行の最大文字数欄・全型の最小文字数欄は Formaloo 非対応の no-op ゆえ撤去 (OD-3)。
          既存 config.minLength/maxLength の型・保存値は後方互換で残置 (push は最大のみ)。 */}
      {hasMaxLength(field.type) && (
        <div>
          <label className="block text-xs text-gray-500 mb-1">最大文字数</label>
          <input type="number" aria-label="最大文字数" value={cfg.maxLength ?? ''} onChange={(e) => setCfg({ maxLength: e.target.value === '' ? undefined : Number(e.target.value) })} className="w-full border border-gray-300 rounded px-2 py-1" />
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

      {field.type === 'file' && (() => {
        // form-media-limits: 動画許可 = allowedExtensions が空(=all で全許可) または curated 動画拡張子を含む。
        const exts = cfg.allowedExtensions ?? []
        const videoAllowed = exts.length === 0 || VIDEO_EXTS.some((v) => exts.includes(v))
        const currentMax = cfg.maxSizeKb ?? 2048
        // 動画許可時のみ 50MB を露出。pull 由来の非プリセット値 (例 15MB) は現値を追加露出して save 時の silent 消失を防ぐ。
        const presets = videoAllowed ? [...MAX_SIZE_PRESETS_KB, 51200] : [...MAX_SIZE_PRESETS_KB]
        const options = presets.includes(currentMax) ? presets : [currentMax, ...presets].sort((a, b) => a - b)
        return (
        <div className="space-y-2">
          <label className="flex items-center gap-2">
            <input type="checkbox" aria-label="複数ファイル許可" checked={cfg.allowMultipleFiles ?? false} onChange={(e) => setCfg({ allowMultipleFiles: e.target.checked })} />
            <span>複数ファイルを許可</span>
          </label>
          <div>
            <label className="block text-xs text-gray-500 mb-1">最大サイズ</label>
            <select
              aria-label="最大サイズ"
              value={String(currentMax)}
              onChange={(e) => {
                const kb = Number(e.target.value)
                // 2MB(標準) は既定 → 未設定へ戻す (push しない = 後方互換)。それ以外は maxSizeKb を設定。
                setCfg({ maxSizeKb: kb === 2048 ? undefined : kb })
              }}
              className="w-full border border-gray-300 rounded px-2 py-1"
            >
              {options.map((kb) => <option key={kb} value={String(kb)}>{maxSizeLabel(kb)}</option>)}
            </select>
          </div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              aria-label="動画を許可"
              checked={videoAllowed}
              onChange={(e) => {
                if (e.target.checked) {
                  // ON: 空(=all)は既に動画許可 → 変更なし / 非空は curated 動画拡張子を union (既存拡張子は保持)。
                  if (exts.length > 0) setCfg({ allowedExtensions: [...exts, ...VIDEO_EXTS.filter((v) => !exts.includes(v))] })
                } else {
                  // OFF: curated 動画拡張子のみ除去 (他拡張子は保持)。
                  setCfg({ allowedExtensions: exts.filter((x) => !VIDEO_EXTS.includes(x)) })
                }
              }}
            />
            <span>動画も受け取れるようにする（mp4 / mov 等）</span>
          </label>
          <p className="text-[10px] text-gray-400 leading-snug">
            動画は容量が大きいので「最大サイズ」も上げてください。実際に添付できるかは公開フォームでの実アップロードで確認します。
          </p>
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
        )
      })()}

      {/* 条件分岐 (R1 / T-B2 GUI + form-route-branching jump) */}
      <div className="pt-2 border-t border-gray-100">
        <div className="text-xs text-gray-500 mb-1">条件分岐（この項目の回答で他項目を出し分け）</div>
        {/* R3: 既存 show/hide の実質ルート活用案内 (文言のみ・機能追加なし)。 */}
        <div className="text-[10px] text-gray-400 mb-1 leading-snug">
          「表示/隠す」でも回答ごとに出す項目を変えられます。ページ単位で丸ごと分けたい時は「ページへ飛ぶ」（1問ずつ表示）を使います。
        </div>
        {rulesForField.map((rule) => {
          const isJump = rule.action === 'jump'
          const isSubmit = rule.action === 'submit'
          // choice source は選択肢 select 化 (title 表示・値は title を送出 → 生成側で slug へ写像)。
          // pull 由来 (rule.value=slug) は choiceItems から title へ解決して選択表示。
          const choiceItems = cfg.choiceItems
          const choiceTitles = cfg.choices ?? []
          const selectedChoiceTitle = choiceItems?.find((ci) => ci.slug === rule.value)?.title ?? rule.value
          const isChoiceSource = hasChoices(field.type) && choiceTitles.length > 0
          // jump 飛び先は page_break (改ページ) / show・hide・skip は非装飾 field。
          const targetOptions = isJump
            ? allFields.filter((f) => f.type === 'page_break')
            : allFields.filter((f) => f.id !== field.id && !isDecoration(f.type))
          // 分岐アクション select (submit option 含む・route-terminal-submit)。
          const actionSelect = (
            <select
              aria-label="分岐アクション"
              value={rule.action}
              onChange={(e) => onActionChange(rule, e.target.value as HarnessLogicRule['action'])}
              className="border border-gray-300 rounded px-1"
            >
              <option value="show">表示</option>
              <option value="hide">隠す</option>
              <option value="jump">ページへ飛ぶ</option>
              <option value="submit">ここで送信（完了ページへ）</option>
              <option value="skip">（旧）スキップ</option>
            </select>
          )
          const deleteBtn = (
            <button type="button" aria-label="分岐を削除" onClick={() => onDeleteRule(rule)} className="text-gray-400 hover:text-red-600">✕</button>
          )
          // route-terminal-submit: submit rule は「もし値なら」でなく「この項目に回答したら送信」= 専用行。
          if (isSubmit) {
            return (
              <div key={rule.id} className="text-xs mb-1 space-y-1">
                <div className="flex flex-wrap items-center gap-1">
                  <span>この項目に回答したら</span>
                  {actionSelect}
                  {/* Phase1: 完了ページは既定固定 (target 空)。Phase2 で success-page 候補を露出。 */}
                  <select aria-label="送信先の完了ページ" value="" disabled className="border border-gray-300 rounded px-1 bg-gray-50 text-gray-500">
                    <option value="">（既定の完了ページ）</option>
                  </select>
                  {deleteBtn}
                </div>
                {/* lint(c) 誤解ゼロ: submit は必須素通し + host 自動必須化を明示 (S-1 確定文言)。 */}
                <div data-testid="submit-lint-note" className="text-[10px] text-amber-600 leading-snug">
                  この項目は自動で必須になります。※「ここで送信」は他の必須項目をスキップして送信します（他ページの必須チェックは効きません）。
                </div>
              </div>
            )
          }
          return (
            <div key={rule.id} className="flex flex-wrap items-center gap-1 text-xs mb-1">
              <span>もし「</span>
              {isChoiceSource ? (
                <select
                  aria-label="分岐の値"
                  value={selectedChoiceTitle}
                  onChange={(e) => onLogicChange(logic.map((r) => (r.id === rule.id ? { ...r, value: e.target.value } : r)))}
                  className="border border-gray-300 rounded px-1"
                >
                  {/* pull 由来で choices に無い値も選択維持できるよう現値を先頭に補完 */}
                  {!choiceTitles.includes(selectedChoiceTitle) && selectedChoiceTitle ? <option value={selectedChoiceTitle}>{selectedChoiceTitle}</option> : null}
                  {choiceTitles.map((t, i) => <option key={i} value={t}>{t}</option>)}
                </select>
              ) : (
                <input aria-label="分岐の値" value={rule.value} onChange={(e) => onLogicChange(logic.map((r) => (r.id === rule.id ? { ...r, value: e.target.value } : r)))} className="border border-gray-300 rounded px-1 w-20" />
              )}
              <span>」なら</span>
              {actionSelect}
              <select aria-label="分岐対象" value={rule.targetFieldId} onChange={(e) => onLogicChange(logic.map((r) => (r.id === rule.id ? { ...r, targetFieldId: e.target.value } : r)))} className="border border-gray-300 rounded px-1">
                {targetOptions.map((f) => <option key={f.id} value={f.id}>{f.type === 'page_break' ? (f.label || 'ページ区切り') : f.label}</option>)}
              </select>
              {deleteBtn}
              {/* case-b 注記: choice source だが choice_slug 未取得 (新規フォーム) → 保存後 再取り込みで有効化。 */}
              {isJump && isChoiceSource && !cfg.choiceItems ? (
                <div className="w-full text-[10px] text-amber-600">この選択肢での分岐は「保存」後に有効になります（保存で選択肢が Formaloo に登録されます）。</div>
              ) : null}
            </div>
          )
        })}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={addRule} disabled={allFields.filter((f) => f.id !== field.id && !isDecoration(f.type)).length < 1} className="text-xs disabled:opacity-40" style={{ color: LINE_GREEN }}>＋ 分岐を追加</button>
          {/* route-terminal-submit: 「ここで送信」は他 field を要さず追加可 (入力1項目でも可)。 */}
          <button type="button" onClick={addSubmitRule} className="text-xs" style={{ color: LINE_GREEN }}>＋「ここで送信」を追加</button>
        </div>
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
  const [mobileTab, setMobileTab] = useState<'edit' | 'design' | 'preview'>('edit')
  const [fields, setFields] = useState<HarnessField[]>(props.initialFields)
  const [logic, setLogic] = useState<HarnessLogicRule[]>(props.initialLogic)
  const [title, setTitle] = useState(props.formTitle)
  const [description, setDescription] = useState(props.formDescription ?? '')
  // preserve-raw: rawLogic (pull 由来の Formaloo logic 逐語) + logicFingerprint (未編集判定) を opaque 保持。
  // logic 編集時は更新しない (route が carry fingerprint vs 現 logic で編集を検知する)。reload 初期は raw 無し
  // (server-side D1 が持つ) → save で fingerprint のみ carry し route が D1 rawLogic を使う。
  const [rawLogic, setRawLogic] = useState<unknown>(undefined)
  const [logicFingerprint, setLogicFingerprint] = useState<string | null>(props.initialLogicFingerprint ?? null)
  // form-design (Batch D): 色/画像テーマ + 画像 upload intent (keep/replace/remove)。
  const [design, setDesign] = useState<FormDesign>(props.initialDesign ?? {})
  const [designImages, setDesignImages] = useState<FormDesignImages>({})
  // form-route-branching (R2): 表示形式 (simple/multi_step) + 自動切替の可視通知 + save 警告。
  const [formType, setFormType] = useState<FormDisplayType | undefined>(props.initialFormType)
  const [formTypeNotice, setFormTypeNotice] = useState<string | null>(null)
  // form-jp-localization: 公開ページ文言 (送信ボタン/完了/送信エラー)。現在値を完全 object で保持し、
  //   触ったときだけ onSave に載せる (formCopyTouched)。初期未編集は送らない = 既存フォーム不干渉 (absent)。
  const [formCopy, setFormCopy] = useState<{ buttonText: string; successMessage: string; errorMessage: string }>({
    buttonText: props.initialFormCopy?.buttonText ?? '',
    successMessage: props.initialFormCopy?.successMessage ?? '',
    errorMessage: props.initialFormCopy?.errorMessage ?? '',
  })
  const [formCopyTouched, setFormCopyTouched] = useState(false)
  const updateFormCopy = (key: 'buttonText' | 'successMessage' | 'errorMessage', value: string) => {
    setFormCopy((c) => ({ ...c, [key]: value }))
    setFormCopyTouched(true)
  }
  const [saveWarnings, setSaveWarnings] = useState<string[]>([])
  // form-media-limits ③: 回答者後編集の許可フラグ (0=不可 / 1=可)。弾S は inert (保存のみ・実効化は弾M)。
  const [allowPostEdit, setAllowPostEdit] = useState<number>(props.initialAllowPostEdit ?? 0)
  // form-edit-mail-link (弾L): 編集 URL メール送付の許可フラグ (0|1)。allow_post_edit=1 でのみ有効 (依存を UI で表現)。
  const [allowEditMail, setAllowEditMail] = useState<number>(props.initialAllowEditMail ?? 0)
  // jump 追加時: simple なら multi_step へ自動切替 + 可視通知 (多層防御の主機構)。
  const ensureMultiStep = () => {
    setFormType('multi_step')
    setFormTypeNotice('ページ移動には「1問ずつ表示」が必要なため、表示形式を切り替えました。')
  }
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
      // form-design: design(色) + designImages(画像 intent) を同梱。
      // form-jp-localization: 文言を触ったときだけ完全 object で載せる (初期未編集は absent = 既存不干渉)。
      const result = await props.onSave({ fields: reposition(fields), logic, rawLogic, logicFingerprint, title, description, design, designImages, formType, ...(formCopyTouched ? { formCopy } : {}), allowPostEdit, allowEditMail })
      // F3: server 確定 design(新 S3 URL 含む)を adopt し、以後の save で旧値に revert しない。
      if (result && typeof result === 'object') {
        if (result.design) setDesign(result.design)
        // 画像 intent の消費は「完全同期(ok)」時のみ。soft-fail(out_of_sync)/throw は pending file を保持し再試行可能に。
        if (result.ok) setDesignImages({})
        // form-route-branching: jump+simple backstop 等の非ブロッキング警告を surface。
        setSaveWarnings(Array.isArray(result.warnings) ? result.warnings : [])
      }
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
        // F2: pull した design を復元し、pending 画像 intent を破棄 (再取り込み後に stale design で上書きしない)。
        setDesign(d.design ?? {})
        setDesignImages({})
        // form-route-branching: pull した表示形式を復元 (未設定は undefined = simple 表示)。
        setFormType(d.formType)
        setFormTypeNotice(null)
      }
    } finally {
      setReimporting(false)
    }
  }

  const selected = fields.find((f) => f.id === selectedId) ?? null
  // form-route-branching: jump rule 有無 (DesignPanel 逆ガード警告の入力)。
  const hasJumpRule = logic.some((r) => r.action === 'jump')
  // b1-field-polish: rating field 有無 (DesignPanel の form-level 星色 picker 表示条件)。
  const hasRating = fields.some((f) => f.type === 'rating')
  // route-terminal-submit (T-B2): lint(a)なだれ込み/(b)送信不能/(d)データ損失 の非ブロッキング警告。
  //   純 show/hide フォームは空 = 誤警告 0 (computeRouteTerminalWarnings が保証)。
  const routeTerminalWarnings = computeRouteTerminalWarnings(fields, logic, formType)
  const onFormTypeSwitch = (t: FormDisplayType) => { setFormType(t); setFormTypeNotice(null) }
  // プレビューは pending 画像 (dataUrl) を即時反映する (upload 前でも見た目を確認できる)。
  const previewDesign: FormDesign = {
    ...design,
    ...(designImages.logo?.intent === 'replace' && designImages.logo.dataUrl ? { logoUrl: designImages.logo.dataUrl } : {}),
    ...(designImages.logo?.intent === 'remove' ? { logoUrl: undefined } : {}),
    ...(designImages.cover?.intent === 'replace' && designImages.cover.dataUrl ? { backgroundImageUrl: designImages.cover.dataUrl } : {}),
    ...(designImages.cover?.intent === 'remove' ? { backgroundImageUrl: undefined } : {}),
  }
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

      {/* form-media-limits ③: フォーム単位「後編集を許可しない」トグル (弾M あと編集の前提スイッチ)。
          弾S は inert = 保存のみ (実効化は弾M)。既定 ON=allow_post_edit 0 = 現状の hosted 挙動と一致。 */}
      <div className="mb-2 flex flex-wrap items-start gap-x-2 gap-y-1 rounded-md border border-gray-100 bg-gray-50 px-3 py-2">
        <label className="flex items-center gap-2 text-xs text-gray-600">
          <input
            type="checkbox"
            aria-label="後編集を許可しない"
            checked={allowPostEdit === 0}
            onChange={(e) => setAllowPostEdit(e.target.checked ? 0 : 1)}
          />
          <span>回答者による後からの編集を許可しない（フォーム単位）</span>
        </label>
        <span className="basis-full text-[10px] text-gray-400 leading-snug">
          ※ この設定はいまは保存のみで、実際に効き始めるのは「あと編集」機能（次の弾）を作ってからです。
        </span>
      </div>

      {/* form-edit-mail-link (弾L): フォーム単位「メールで編集 URL を送る」トグル。
          「あと編集を許可する」(allow_post_edit=1) のときだけ有効 (依存を UI で表現・disabled で示す)。 */}
      <div className="mb-2 flex flex-wrap items-start gap-x-2 gap-y-1 rounded-md border border-gray-100 bg-gray-50 px-3 py-2">
        <label className={`flex items-center gap-2 text-xs ${allowPostEdit === 1 ? 'text-gray-600' : 'text-gray-400'}`}>
          <input
            type="checkbox"
            aria-label="メールで編集URLを送る"
            disabled={allowPostEdit === 0}
            checked={allowEditMail === 1}
            onChange={(e) => setAllowEditMail(e.target.checked ? 1 : 0)}
          />
          <span>回答完了時に、入力されたメールアドレス宛へ「編集用リンク」を送る（フォーム単位）</span>
        </label>
        <span className="basis-full text-[10px] text-gray-400 leading-snug">
          ※ 「回答者による後からの編集」を許可したフォームでのみ設定できます。メール送信の実際の有効化は運用側の設定が必要です。
        </span>
      </div>

      {/* form-jp-localization: 公開ページ文言 (送信ボタン/完了/送信エラー) を日本語で個別指定。
          未入力は Formaloo 既定 (英語) のまま。空欄=未指定=触らない (既存文言を消さない)。 */}
      <div className="mb-2 rounded-md border border-gray-100 bg-gray-50 px-3 py-2" data-testid="form-copy-section">
        <div className="text-xs font-medium text-gray-600 mb-1">公開ページの文言（日本語）</div>
        <div className="flex flex-col gap-2">
          <label className="block text-[11px] text-gray-500">
            送信ボタンの文言
            <input
              aria-label="送信ボタンの文言"
              value={formCopy.buttonText}
              onChange={(e) => updateFormCopy('buttonText', e.target.value)}
              placeholder="Submit（未入力なら英語の既定）"
              className="mt-0.5 w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm"
            />
          </label>
          <label className="block text-[11px] text-gray-500">
            送信完了メッセージ
            <input
              aria-label="送信完了メッセージ"
              value={formCopy.successMessage}
              onChange={(e) => updateFormCopy('successMessage', e.target.value)}
              placeholder="Thanks! submitted successfully（未入力なら英語の既定）"
              className="mt-0.5 w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm"
            />
          </label>
          <label className="block text-[11px] text-gray-500">
            送信エラー時の文言
            <input
              aria-label="送信エラー時の文言"
              value={formCopy.errorMessage}
              onChange={(e) => updateFormCopy('errorMessage', e.target.value)}
              placeholder="送信に失敗したときのメッセージ"
              className="mt-0.5 w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm"
            />
          </label>
        </div>
        {/* AC-6 制約注記: ①文字数オーバー/必須 等は Formaloo 側固定で変更不可 (できない事をできる風に見せない)。 */}
        <p className="mt-2 text-[10px] text-gray-400 leading-snug" data-testid="form-copy-constraint-note">
          ※ 文字数オーバー時のエラー（例: the answer should be less than 10 characters）や「必須です」等の入力チェック文言・入力欄の案内文は、Formaloo 側で固定のため変更できません。日本語にできるのは上の 3 つ（送信ボタン／完了メッセージ／送信エラー）です。
        </p>
      </div>

      {/* ① 今すぐ同期リカバリ: sync_status=out_of_sync のとき、原因 (syncError) + 再送ヘルプ + 「今すぐ同期」を
          目立つ位置に出す。ボタンは既存の保存/push 経路 (handleSave) を再実行するだけ (新経路を作らず状態機械を壊さない)。 */}
      {props.syncStatus === 'out_of_sync' && (
        <div data-testid="sync-recovery" role="status" className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <span className="font-medium">未同期です。</span>
          {props.syncError && <span data-testid="sync-recovery-cause">原因: {props.syncError}</span>}
          <span className="text-amber-700">保存し直すと再送されます。</span>
          <button
            type="button"
            data-testid="sync-now"
            onClick={handleSave}
            disabled={saving || !title.trim()}
            className="ml-auto rounded-lg px-3 py-1 font-medium text-white disabled:opacity-50"
            style={{ backgroundColor: LINE_GREEN }}
          >
            {saving ? '同期中...' : '今すぐ同期'}
          </button>
        </div>
      )}

      {/* ③ 公開ページを開いてテスト導線: 公開済み+URL 確定でテストリンク / 準備中 or 未公開は案内。 */}
      {props.status === 'published' ? (
        props.publicUrl ? (
          <div data-testid="public-test-link" className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
            <span>公開中です。回答者と同じ画面でテストできます。</span>
            <a
              href={props.publicUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="open-public-page"
              className="ml-auto rounded-lg px-3 py-1 font-medium text-white"
              style={{ backgroundColor: LINE_GREEN }}
            >
              公開ページを開いてテスト
            </a>
          </div>
        ) : (
          <div data-testid="public-url-pending" className="mb-2 text-xs text-amber-700">
            公開URLを準備中です。保存し直すと公開ページのURLが確定します。
          </div>
        )
      ) : (
        <div data-testid="public-test-hint" className="mb-2 text-xs text-gray-400">
          公開すると回答者用ページが作られ、ここから開いてテストできます。
        </div>
      )}

      {/* form-route-branching: 表示形式 自動切替の可視通知 (jump 追加時) + save 時の非ブロッキング警告 (backstop)。 */}
      {formTypeNotice && (
        <div data-testid="formtype-notice" role="status" className="mb-2 rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-800 flex items-start gap-2">
          <span>ⓘ {formTypeNotice}</span>
          <button type="button" aria-label="通知を閉じる" onClick={() => setFormTypeNotice(null)} className="ml-auto text-blue-400 hover:text-blue-700">✕</button>
        </div>
      )}
      {saveWarnings.length > 0 && (
        <div data-testid="save-warnings" role="alert" className="mb-2 rounded-md bg-amber-50 border border-amber-300 px-3 py-2 text-xs text-amber-800 space-y-1">
          {saveWarnings.map((w, i) => <div key={i}>⚠️ {w}</div>)}
        </div>
      )}
      {/* route-terminal-submit (T-B2): なだれ込み/送信不能/データ損失 の live 非ブロッキング警告。 */}
      {routeTerminalWarnings.length > 0 && (
        <div data-testid="route-terminal-warnings" role="alert" className="mb-2 rounded-md bg-amber-50 border border-amber-300 px-3 py-2 text-xs text-amber-800 space-y-1">
          {routeTerminalWarnings.map((w, i) => <div key={i}>⚠️ {w}</div>)}
        </div>
      )}

      {mode === 'mobile' && (
        <div className="mb-3 grid grid-cols-3 rounded-lg bg-gray-100 p-1" aria-label="ビルダー表示切替">
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
            data-testid="preview-tab-design"
            aria-pressed={mobileTab === 'design'}
            onClick={() => setMobileTab('design')}
            className={`rounded-md px-3 py-2 text-sm font-medium ${mobileTab === 'design' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}
          >
            デザイン
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
                <SettingsPanel field={selected} allFields={fields} logic={logic} onChange={updateField} onLogicChange={setLogic} formType={formType} onEnsureMultiStep={ensureMultiStep} />
              ) : (
                <div className="text-xs text-gray-400">項目を選ぶと設定が表示されます</div>
              )}
            </div>
          </div>
        )}

        {mode !== 'desktop' && mobileTab === 'design' && (
          <div data-testid="design-pane" className="w-full rounded-xl bg-gray-50 p-3">
            <DesignPanel design={design} images={designImages} onChange={setDesign} onImagesChange={setDesignImages} formType={formType} onFormTypeChange={onFormTypeSwitch} hasJumpRule={hasJumpRule} hasRating={hasRating} />
          </div>
        )}

        {(mode === 'desktop' || mobileTab === 'preview') && (
          <div
            data-testid="preview-pane"
            className={mode === 'desktop' ? 'w-[399px] shrink-0 space-y-3 rounded-xl bg-gray-50 p-3' : 'w-full rounded-xl bg-gray-50 p-3'}
          >
            {mode === 'desktop' && (
              <details data-testid="design-pane" className="rounded-lg border border-gray-200 bg-white p-3" open>
                <summary className="cursor-pointer text-xs font-bold text-gray-500">デザイン</summary>
                <div className="mt-3">
                  <DesignPanel design={design} images={designImages} onChange={setDesign} onImagesChange={setDesignImages} formType={formType} onFormTypeChange={onFormTypeSwitch} hasJumpRule={hasJumpRule} hasRating={hasRating} />
                </div>
              </details>
            )}
            <FormPreview title={title} description={description} fields={fields} design={previewDesign} formType={formType} logic={logic} />
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
