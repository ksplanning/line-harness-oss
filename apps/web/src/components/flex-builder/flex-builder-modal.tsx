'use client'

/**
 * Flex ビジュアルビルダー本体モーダル (F1-F4 / ui-design §1,§2,§4,§10)。
 *
 * 合格の一点: 運用者が JSON を一度も見ずにカードを作り切れる。
 * - 全画面級モーダル (95vw) 左=編集 / 右=LINE 風プレビュー。
 * - overlay click は no-op (誤閉じ防止)。✕/Esc/キャンセルのみ閉じる (dirty なら confirm)。
 * - step='template'(起動時) → step='edit'。既存編集で開くと直接 edit。
 * - プレビューと保存は buildModelToFlex の唯一の出力 (乖離ゼロ)。
 *
 * C2 範囲: モーダル骨格 + パレット + text 系部品編集 + プレビュー結線 + テンプレ選択。
 * カルーセル(card-tabs)/画像 uploader/ボタン link-picker/保存バリデーション結線は C3-C4。
 */
import { useEffect, useMemo, useState } from 'react'
import FlexPreview from '@/components/flex-preview'
import PartPalette from './part-palette'
import PartEditor from './part-editor'
import CardTabs from './card-tabs'
import { NAIL_TEMPLATES, blankModel, cloneTemplate, type FlexTemplate } from '@/lib/flex-builder/templates'
import { buildModelToFlex } from '@/lib/flex-builder/to-flex'
import { validateFlex } from '@/lib/flex-builder/validate'
import {
  isModelDirty,
  shouldConfirmClose,
  previewJson,
  addPart,
  movePart,
  removePart,
  updatePart,
  duplicateCard,
  moveCard,
  removeCard,
} from '@/lib/flex-builder/modal-logic'
import type { BuilderModel, BuilderPart, PartKind, ValidationError } from '@/lib/flex-builder/types'

interface Props {
  /** 既存 Flex を編集する場合の初期モデル。新規なら undefined (テンプレ選択から)。 */
  initialModel?: BuilderModel
  onSave: (jsonString: string) => void
  onClose: () => void
}

const PART_META: Record<PartKind, { icon: string; label: string }> = {
  heading: { icon: '🅰', label: '見出し' },
  body: { icon: '📝', label: '本文' },
  image: { icon: '🖼', label: '画像' },
  button: { icon: '🔘', label: 'ボタン' },
  separator: { icon: '➖', label: '区切り線' },
  spacer: { icon: '⬜', label: '余白' },
}

function partSummary(part: BuilderPart): string {
  switch (part.kind) {
    case 'heading':
    case 'body':
      return part.text.slice(0, 18) || '(空)'
    case 'button':
      return part.label || '(ボタン)'
    case 'image':
      return part.url ? '画像あり' : '画像未設定'
    default:
      return ''
  }
}

export default function FlexBuilderModal({ initialModel, onSave, onClose }: Props) {
  const [step, setStep] = useState<'template' | 'edit'>(initialModel ? 'edit' : 'template')
  const [model, setModel] = useState<BuilderModel>(initialModel ?? blankModel())
  const [snapshot, setSnapshot] = useState<BuilderModel>(initialModel ?? blankModel())
  const [activeCard, setActiveCard] = useState(0)
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null)
  const [saveErrors, setSaveErrors] = useState<ValidationError[]>([])

  const dirty = step === 'edit' && isModelDirty(snapshot, model)

  const requestClose = () => {
    const { canClose, needsConfirm } = shouldConfirmClose({ isDirty: dirty, saving: false })
    if (!canClose) return
    if (needsConfirm && !window.confirm('作りかけの内容は保存されません。閉じてよいですか？')) return
    onClose()
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  })

  const startFromTemplate = (tpl: FlexTemplate | null) => {
    const m = tpl ? cloneTemplate(tpl) : blankModel()
    setModel(m)
    setSnapshot(JSON.parse(JSON.stringify(m)))
    setSelectedPartId(m.cards[0]?.parts[0]?.id ?? null)
    setStep('edit')
  }

  const flexJson = useMemo(() => previewJson(model), [model])
  const card = model.cards[activeCard]
  const selectedPart = card?.parts.find((p) => p.id === selectedPartId) ?? null

  const handleAdd = (kind: PartKind) => {
    const { model: next, partId } = addPart(model, activeCard, kind)
    setModel(next)
    setSelectedPartId(partId)
  }
  const handleMove = (partId: string, dir: 'up' | 'down') => setModel(movePart(model, activeCard, partId, dir))
  const handleRemove = (partId: string) => {
    if (!window.confirm('この部品を消しますか？')) return
    setModel(removePart(model, activeCard, partId))
    if (selectedPartId === partId) setSelectedPartId(null)
  }
  const handlePartChange = (patch: Partial<BuilderPart>) => {
    if (!selectedPartId) return
    setModel(updatePart(model, activeCard, selectedPartId, patch))
  }

  // カード操作 (カルーセル / F7)
  const handleDuplicateCard = () => {
    const { model: next, newIndex } = duplicateCard(model, activeCard)
    setModel(next)
    setActiveCard(newIndex)
    setSelectedPartId(null)
  }
  const handleMoveCard = (dir: 'left' | 'right') => {
    setModel(moveCard(model, activeCard, dir))
    setActiveCard((i) => {
      const t = dir === 'left' ? i - 1 : i + 1
      return t < 0 || t >= model.cards.length ? i : t
    })
  }
  const handleRemoveCard = () => {
    if (model.cards.length <= 1) return
    if (!window.confirm('このカードを消しますか？')) return
    setModel(removeCard(model, activeCard))
    setActiveCard((i) => Math.max(0, i - (i > 0 ? 1 : 0)))
    setSelectedPartId(null)
  }
  const handleSelectCard = (i: number) => {
    setActiveCard(i)
    setSelectedPartId(null)
  }

  // 保存: validateFlex 結線 (D-14)。ok:false なら保存せずエラー列挙。
  const contents = buildModelToFlex(model)
  const validation = validateFlex(contents)
  const canSave = validation.ok

  const handleSave = () => {
    if (!validation.ok) {
      setSaveErrors(validation.errors)
      return
    }
    setSaveErrors([])
    onSave(JSON.stringify(contents))
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4"
      onClick={(e) => {
        // overlay click は no-op (誤閉じ防止)。内側のクリックは伝播で無視される。
        if (e.target === e.currentTarget) return
      }}
    >
      <div className="bg-white rounded-lg shadow-xl w-[95vw] max-w-6xl max-h-[95vh] flex flex-col">
        {/* ヘッダー */}
        <div className="flex items-center justify-between px-5 py-4 border-b shrink-0">
          <h3 className="text-base font-semibold text-gray-900">カードを作る</h3>
          <button
            type="button"
            onClick={requestClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
            aria-label="閉じる"
          >
            ×
          </button>
        </div>

        {step === 'template' ? (
          <TemplateStep onPick={startFromTemplate} />
        ) : (
          <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
            {/* 左ペイン: 編集 */}
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3 border-b lg:border-b-0 lg:border-r">
              <CardTabs
                cardCount={model.cards.length}
                activeIndex={activeCard}
                onSelect={handleSelectCard}
                onDuplicate={handleDuplicateCard}
                onMove={handleMoveCard}
                onRemove={handleRemoveCard}
              />
              <PartPalette onAdd={handleAdd} />
              <ul className="space-y-1.5">
                {card?.parts.map((part, i) => {
                  const meta = PART_META[part.kind]
                  const selected = part.id === selectedPartId
                  return (
                    <li
                      key={part.id}
                      onClick={() => setSelectedPartId(part.id)}
                      className={`flex items-center gap-2 rounded-md border px-2 py-2 cursor-pointer ${
                        selected ? 'border-green-500 bg-green-50 ring-1 ring-green-500' : 'border-gray-200'
                      }`}
                    >
                      <span className="text-base leading-none" aria-hidden>
                        {meta.icon}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-xs font-medium text-gray-800">{meta.label}</span>
                        <span className="block text-[11px] text-gray-500 truncate">{partSummary(part)}</span>
                      </span>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleMove(part.id, 'up') }}
                        disabled={i === 0}
                        className="w-8 h-8 rounded text-gray-500 disabled:opacity-30 hover:bg-gray-100"
                        aria-label="上へ移動"
                      >↑</button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleMove(part.id, 'down') }}
                        disabled={i === card.parts.length - 1}
                        className="w-8 h-8 rounded text-gray-500 disabled:opacity-30 hover:bg-gray-100"
                        aria-label="下へ移動"
                      >↓</button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleRemove(part.id) }}
                        className="w-8 h-8 rounded text-gray-400 hover:text-red-600 hover:bg-red-50"
                        aria-label="この部品を消す"
                      >🗑</button>
                    </li>
                  )
                })}
                {card?.parts.length === 0 && (
                  <li className="text-xs text-gray-400 py-4 text-center">
                    まだ部品がありません。「＋ 部品を足す」から始めましょう。
                  </li>
                )}
              </ul>
              {selectedPart && (
                <div className="rounded-md border border-gray-200 p-3 bg-gray-50">
                  <PartEditor part={selectedPart} onChange={handlePartChange} />
                </div>
              )}
            </div>

            {/* 右ペイン: プレビュー */}
            <div className="lg:w-[360px] shrink-0 bg-slate-100 p-4 overflow-y-auto">
              <div className="lg:sticky lg:top-0">
                <p className="text-[11px] text-gray-500 mb-2">プレビュー</p>
                <FlexPreview content={flexJson} maxWidth={300} />
                <p className="mt-3 text-[11px] text-gray-400">
                  実際のLINEでは少し見え方が変わることがあります。
                </p>
              </div>
            </div>
          </div>
        )}

        {/* sticky footer */}
        {step === 'edit' && (
          <div className="sticky bottom-0 px-5 py-3 border-t bg-white flex items-center gap-3 shrink-0">
            <div className="flex-1 min-w-0">
              {saveErrors.length > 0 && (
                <ul className="text-xs text-red-600 space-y-0.5">
                  {saveErrors.map((e, i) => (
                    <li key={`${e.code}-${i}`}>{e.messageJa}</li>
                  ))}
                </ul>
              )}
            </div>
            <button
              onClick={requestClose}
              className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md min-h-[36px] shrink-0"
            >
              キャンセル
            </button>
            <button
              onClick={handleSave}
              disabled={!canSave}
              className="px-4 py-1.5 text-xs font-medium text-white rounded-md min-h-[36px] shrink-0 disabled:opacity-50"
              style={{ backgroundColor: '#06C755' }}
            >
              保存
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/** step='template': どれから作るかの選択画面 (まっさら + 3 テンプレ)。サムネは FlexPreview 実物。 */
function TemplateStep({ onPick }: { onPick: (tpl: FlexTemplate | null) => void }) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6">
      <p className="text-sm font-medium text-gray-800 mb-4">どれから作りますか？</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <button
          type="button"
          onClick={() => onPick(null)}
          className="flex flex-col items-center justify-center gap-2 min-h-[160px] border-2 border-dashed border-gray-300 rounded-lg hover:border-green-500 hover:bg-green-50 focus:outline-none focus:ring-2 focus:ring-green-500"
        >
          <span className="text-3xl text-gray-400" aria-hidden>＋</span>
          <span className="text-sm font-medium text-gray-700">まっさら</span>
        </button>
        {NAIL_TEMPLATES.map((tpl) => (
          <button
            key={tpl.key}
            type="button"
            onClick={() => onPick(tpl)}
            className="flex flex-col items-center gap-2 p-2 border border-gray-200 rounded-lg hover:border-green-500 hover:bg-green-50 focus:outline-none focus:ring-2 focus:ring-green-500"
          >
            <div className="w-full bg-slate-100 rounded p-1 flex justify-center overflow-hidden" style={{ maxHeight: 130 }}>
              <FlexPreview content={JSON.stringify(buildModelToFlex(tpl.model))} maxWidth={140} />
            </div>
            <span className="text-sm font-medium text-gray-700">{tpl.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
