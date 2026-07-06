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
import { NAIL_TEMPLATES, GALLERY_TEMPLATES, blankModel, cloneTemplate, type FlexTemplate } from '@/lib/flex-builder/templates'
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
  findPart,
  setHero,
  type Region,
} from '@/lib/flex-builder/modal-logic'
import ImageUploader from '@/components/shared/image-uploader'
import type { BuilderModel, BuilderPart, ImageAspect, PartKind, ValidationError } from '@/lib/flex-builder/types'
import type { ComponentType, SVGProps } from 'react'
import {
  HeadingIcon,
  BodyTextIcon,
  ImageIcon,
  ButtonIcon,
  SeparatorIcon,
  SpacerIcon,
  BoxIcon,
  TrashIcon,
  ChevronUpIcon,
  ChevronDownIcon,
} from '@/components/shared/icons'

interface Props {
  /** 既存 Flex を編集する場合の初期モデル。新規なら undefined (テンプレ選択から)。 */
  initialModel?: BuilderModel
  onSave: (jsonString: string) => void
  onClose: () => void
}

// 装飾は絵文字文字でなく inline SVG (M-19: VS16 無し絵文字の豆腐を根絶)。
const PART_META: Record<PartKind, { Icon: ComponentType<SVGProps<SVGSVGElement>>; label: string }> = {
  heading: { Icon: HeadingIcon, label: '見出し' },
  body: { Icon: BodyTextIcon, label: '本文' },
  image: { Icon: ImageIcon, label: '画像' },
  button: { Icon: ButtonIcon, label: 'ボタン' },
  separator: { Icon: SeparatorIcon, label: '区切り線' },
  spacer: { Icon: SpacerIcon, label: '余白' },
  box: { Icon: BoxIcon, label: '箱' },
  icon: { Icon: ImageIcon, label: 'アイコン' },
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
    case 'icon':
      return part.url ? 'アイコンあり' : 'アイコン未設定'
    case 'box':
      return `${part.layout === 'horizontal' ? 'よこ並び' : 'たて並び'}・中身 ${part.contents.length} 個`
    default:
      return ''
  }
}

// ネスト対応の部品ツリー描画 (batch C-core)。box の子部品を indent して再帰表示し、box には
// 「＋ この箱に部品を足す」を出す。並べ替え(上/下)は各階層の兄弟内で動く = D&D 相当。
interface PartTreeProps {
  parts: BuilderPart[]
  depth: number
  selectedPartId: string | null
  confirmingRemoveId: string | null
  onSelect: (id: string) => void
  onMove: (id: string, dir: 'up' | 'down') => void
  onRequestRemove: (id: string) => void
  onConfirmRemove: (id: string) => void
  onCancelRemove: () => void
  onAddChild: (boxId: string, kind: PartKind) => void
}

function PartTree(props: PartTreeProps) {
  const { parts, depth } = props
  return (
    <ul className="space-y-1.5">
      {parts.map((part, i) => {
        const meta = PART_META[part.kind]
        const selected = part.id === props.selectedPartId
        return (
          <li key={part.id}>
            <div
              onClick={() => props.onSelect(part.id)}
              className={`flex items-center gap-2 rounded-md border px-2 py-2 cursor-pointer ${
                selected ? 'border-green-500 bg-green-50 ring-1 ring-green-500' : 'border-gray-200'
              }`}
            >
              <span className="text-base leading-none text-gray-600" aria-hidden>
                <meta.Icon />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-xs font-medium text-gray-800">{meta.label}</span>
                <span className="block text-[11px] text-gray-500 truncate">{partSummary(part)}</span>
              </span>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); props.onMove(part.id, 'up') }}
                disabled={i === 0}
                className="w-8 h-8 rounded text-gray-500 disabled:opacity-30 hover:bg-gray-100 inline-flex items-center justify-center"
                aria-label="上へ移動"
              ><ChevronUpIcon /></button>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); props.onMove(part.id, 'down') }}
                disabled={i === parts.length - 1}
                className="w-8 h-8 rounded text-gray-500 disabled:opacity-30 hover:bg-gray-100 inline-flex items-center justify-center"
                aria-label="下へ移動"
              ><ChevronDownIcon /></button>
              {props.confirmingRemoveId === part.id ? (
                <span className="flex items-center gap-1">
                  <span className="text-[11px] text-gray-600">消す?</span>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); props.onConfirmRemove(part.id) }}
                    className="px-2 h-8 rounded text-xs font-medium text-white bg-red-600 hover:bg-red-700"
                    aria-label="はい、この部品を消す"
                  >はい</button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); props.onCancelRemove() }}
                    className="px-2 h-8 rounded text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200"
                    aria-label="いいえ、消さない"
                  >いいえ</button>
                </span>
              ) : (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); props.onRequestRemove(part.id) }}
                  className="w-8 h-8 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 inline-flex items-center justify-center"
                  aria-label="この部品を消す"
                ><TrashIcon /></button>
              )}
            </div>
            {part.kind === 'box' && (
              <div className="mt-1.5 ml-3 pl-2 border-l-2 border-green-200 space-y-1.5">
                {part.contents.length > 0 && (
                  <PartTree {...props} parts={part.contents} depth={depth + 1} />
                )}
                <PartPalette onAdd={(kind) => props.onAddChild(part.id, kind)} />
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

// ブロック (header / footer) の編集領域 (batch C-core)。部品列 + パレット + 空状態。
type RegionTreeHandlers = Omit<PartTreeProps, 'parts' | 'depth'>
function RegionEditor({
  title, hint, region, parts, onAddTop, handlers,
}: {
  title: string
  hint: string
  region: Region
  parts: BuilderPart[]
  onAddTop: (region: Region, kind: PartKind) => void
  handlers: RegionTreeHandlers
}) {
  return (
    <div className="rounded-md border border-gray-200 p-2 space-y-2 bg-white">
      <div>
        <p className="text-xs font-medium text-gray-700">{title}</p>
        <p className="text-[11px] text-gray-500">{hint}</p>
      </div>
      <PartPalette onAdd={(kind) => onAddTop(region, kind)} />
      {parts.length > 0 && <PartTree parts={parts} depth={0} {...handlers} />}
    </div>
  )
}

export default function FlexBuilderModal({ initialModel, onSave, onClose }: Props) {
  const [step, setStep] = useState<'template' | 'edit'>(initialModel ? 'edit' : 'template')
  const [model, setModel] = useState<BuilderModel>(initialModel ?? blankModel())
  const [snapshot, setSnapshot] = useState<BuilderModel>(initialModel ?? blankModel())
  const [activeCard, setActiveCard] = useState(0)
  const [selectedPartId, setSelectedPartId] = useState<string | null>(null)
  // 選択部品がどのブロック (body/header/footer) にあるか。編集の書き戻し先を決める (batch C-core)。
  const [selectedRegion, setSelectedRegion] = useState<Region>('body')
  const [saveErrors, setSaveErrors] = useState<ValidationError[]>([])
  // 部品削除のインライン確認 (native window.confirm は headless で自動キャンセルされ削除が反映されない
  // 不具合を招くため、行内の「消す?[はい][いいえ]」に置換 = おばあちゃんにも分かりやすく確実に反映される)
  const [confirmingRemoveId, setConfirmingRemoveId] = useState<string | null>(null)

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
  // ネスト対応: 選択部品は box の子も含めツリー全体から探す (batch C-core)。
  const selectedPart = card && selectedPartId ? findPart(card, selectedPartId) : null

  // 全操作は setState の updater 形式 (prev => ...) で最新 model から派生させる
  // (イベントハンドラのクロージャが古い model を掴む参照劣化を排除 = 削除だけ反映されない不具合の再発防止)。
  // parentBoxId を渡すとその box の子として足す (ネスト)。region で body/header/footer を選ぶ (batch C-core)。
  const handleAdd = (kind: PartKind, parentBoxId?: string, region: Region = 'body') => {
    let newPartId = ''
    setModel((prev) => {
      const { model: next, partId } = addPart(prev, activeCard, kind, parentBoxId, region)
      newPartId = partId
      return next
    })
    setSelectedPartId(newPartId)
    setSelectedRegion(region)
  }
  const handleMove = (partId: string, dir: 'up' | 'down', region: Region = 'body') =>
    setModel((prev) => movePart(prev, activeCard, partId, dir, region))
  // 行内「はい」で実行 (確認は UI で先に表示済み)。partId が現アクティブカードに存在する時だけ削除
  // (別カードに切替後の stale 確認で誤操作しない / H3 同種の予防)。setState updater で確実に反映。
  const handleRemove = (partId: string, region: Region = 'body') => {
    setModel((prev) => {
      const c = prev.cards[activeCard]
      if (!c || !findPart(c, partId)) return prev // ネスト対応: ツリー全体で存在確認
      return removePart(prev, activeCard, partId, region)
    })
    if (selectedPartId === partId) setSelectedPartId(null)
    setConfirmingRemoveId(null)
  }
  const handlePartChange = (patch: Partial<BuilderPart>) => {
    if (!selectedPartId) return
    setModel((prev) => updatePart(prev, activeCard, selectedPartId, patch, selectedRegion))
  }
  // 各ブロック (body/header/footer) の PartTree に渡す共通ハンドラ束 (region を閉じ込める)。
  const treeHandlersFor = (region: Region) => ({
    selectedPartId,
    confirmingRemoveId,
    onSelect: (id: string) => { setSelectedPartId(id); setSelectedRegion(region) },
    onMove: (id: string, dir: 'up' | 'down') => handleMove(id, dir, region),
    onRequestRemove: setConfirmingRemoveId,
    onConfirmRemove: (id: string) => handleRemove(id, region),
    onCancelRemove: () => setConfirmingRemoveId(null),
    onAddChild: (boxId: string, kind: PartKind) => handleAdd(kind, boxId, region),
  })

  // hero (一番上の大きな画像 / 単一)。UI は画像に限定 (box hero は高度形式として保持のみ)。
  const heroImage = card && card.hero && card.hero.kind === 'image' ? card.hero : null
  const handleHeroAdd = () =>
    setModel((prev) => setHero(prev, activeCard, { kind: 'image', id: 'hero_' + Math.random().toString(36).slice(2, 8), url: '', aspect: 'landscape', rounded: false }))
  const handleHeroRemove = () => setModel((prev) => setHero(prev, activeCard, undefined))
  const handleHeroChange = (patch: Partial<Extract<BuilderPart, { kind: 'image' }>>) =>
    setModel((prev) => {
      const c = prev.cards[activeCard]
      if (!c || !c.hero || c.hero.kind !== 'image') return prev
      return setHero(prev, activeCard, { ...c.hero, ...patch })
    })

  // カード操作 (カルーセル / F7)
  const handleDuplicateCard = () => {
    setModel((prev) => {
      const { model: next } = duplicateCard(prev, activeCard)
      return next
    })
    setActiveCard(model.cards.length) // 複製は末尾に足されるので新 index = 現 length
    setSelectedPartId(null)
  }
  const handleMoveCard = (dir: 'left' | 'right') => {
    setModel((prev) => moveCard(prev, activeCard, dir))
    setActiveCard((i) => {
      const t = dir === 'left' ? i - 1 : i + 1
      return t < 0 || t >= model.cards.length ? i : t
    })
  }
  // 確認は card-tabs の行内「はい」で済んでいる。削除対象は確認時点の index を受け取る (H3: 誤カード削除防止)。
  const handleRemoveCard = (index: number) => {
    if (model.cards.length <= 1) return
    if (index < 0 || index >= model.cards.length) return
    setModel((prev) => removeCard(prev, index))
    // アクティブが削除位置以降なら 1 つ手前へ (範囲外を指さないよう clamp)。
    setActiveCard((i) => {
      const next = i > index ? i - 1 : i
      return Math.min(next, model.cards.length - 2)
    })
    setSelectedPartId(null)
  }
  const handleSelectCard = (i: number) => {
    setActiveCard(i)
    setSelectedPartId(null)
    setSelectedRegion('body')
    setConfirmingRemoveId(null) // カード切替で部品削除の行内確認をリセット (H3 同種の予防)
  }
  // カードの大きさ (bubble.size / batch C)。fallback を押すと未指定に戻す。
  const handleCardSize = (size: string | undefined) => {
    setModel((prev) => ({
      ...prev,
      cards: prev.cards.map((c, i) => (i === activeCard ? { ...c, size } : c)),
    }))
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
              {/* カードの大きさ (bubble.size / batch C)。専門語を出さず日本語トグル。 */}
              <div>
                <label className="block text-xs text-gray-600 mb-1">カードの大きさ</label>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    { v: undefined, label: '標準' },
                    { v: 'nano', label: '極小' },
                    { v: 'micro', label: '小' },
                    { v: 'kilo', label: '中' },
                    { v: 'mega', label: '大' },
                    { v: 'giga', label: '特大' },
                  ].map((o) => {
                    const active = (card?.size ?? undefined) === o.v
                    return (
                      <button
                        key={o.label}
                        type="button"
                        onClick={() => handleCardSize(o.v)}
                        className={`min-h-[36px] px-3 rounded-md border text-xs ${active ? 'border-green-500 text-green-700 bg-green-50' : 'border-gray-300 text-gray-600'}`}
                      >
                        {o.label}
                      </button>
                    )
                  })}
                </div>
              </div>
              {/* 上の帯 (header / batch C-core)。無ければ追加ボタン、あれば編集領域。 */}
              {card?.header && card.header.length > 0 ? (
                <RegionEditor
                  title="上の帯（ヘッダー）" hint="カードの一番上に出る帯です。"
                  region="header" parts={card.header}
                  onAddTop={(region, kind) => handleAdd(kind, undefined, region)}
                  handlers={treeHandlersFor('header')}
                />
              ) : (
                <button type="button" onClick={() => handleAdd('heading', undefined, 'header')}
                  className="w-full min-h-[40px] border border-dashed border-gray-300 text-gray-600 rounded-md px-3 py-2 text-xs hover:border-green-500 hover:bg-green-50">
                  ＋ 上の帯（ヘッダー）を足す
                </button>
              )}

              {/* 一番上の大きな画像 (hero / batch C-core)。UI は画像限定。 */}
              {card?.hero && card.hero.kind !== 'image' ? (
                <div className="rounded-md border border-gray-200 p-2 bg-white flex items-center justify-between">
                  <span className="text-[11px] text-gray-500">高度な形式の大きな画像があります（保存時に保持されます）。</span>
                  <button type="button" onClick={handleHeroRemove} className="text-xs text-red-600 px-2 py-1 hover:bg-red-50 rounded">外す</button>
                </div>
              ) : heroImage ? (
                <div className="rounded-md border border-gray-200 p-2 bg-white space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-gray-700">一番上の大きな画像（ヒーロー）</span>
                    <button type="button" onClick={handleHeroRemove} className="text-xs text-red-600 px-2 py-1 hover:bg-red-50 rounded" aria-label="ヒーロー画像を外す">外す</button>
                  </div>
                  <ImageUploader
                    mode="url"
                    value={heroImage.url ? { mode: 'url', url: heroImage.url } : null}
                    onChange={(next) => handleHeroChange({ url: next && next.mode === 'url' ? next.url : '' })}
                  />
                  <div className="flex gap-2">
                    {([{ v: 'original', label: 'そのまま' }, { v: 'landscape', label: '横長' }, { v: 'square', label: '正方形' }] as { v: ImageAspect; label: string }[]).map((a) => (
                      <button key={a.v} type="button" onClick={() => handleHeroChange({ aspect: a.v })}
                        className={`min-h-[36px] px-3 rounded-md border text-xs ${(heroImage.aspect ?? 'original') === a.v ? 'border-green-500 text-green-700 bg-green-50' : 'border-gray-300 text-gray-600'}`}>
                        {a.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <button type="button" onClick={handleHeroAdd}
                  className="w-full min-h-[40px] border border-dashed border-gray-300 text-gray-600 rounded-md px-3 py-2 text-xs hover:border-green-500 hover:bg-green-50">
                  ＋ 一番上に大きな画像（ヒーロー）を足す
                </button>
              )}

              {/* 本体 (body) */}
              <div className="text-[11px] font-medium text-gray-500 pt-1">本体</div>
              <PartPalette onAdd={handleAdd} />
              {card && card.parts.length > 0 ? (
                <PartTree parts={card.parts} depth={0} {...treeHandlersFor('body')} />
              ) : (
                <p className="text-xs text-gray-400 py-4 text-center">
                  まだ部品がありません。「＋ 部品を足す」から始めましょう。
                </p>
              )}

              {/* 下のボタン帯 (footer / batch C-core)。 */}
              {card?.footer && card.footer.length > 0 ? (
                <RegionEditor
                  title="下のボタン帯（フッター）" hint="カードの一番下に出る帯です。ボタン向き。"
                  region="footer" parts={card.footer}
                  onAddTop={(region, kind) => handleAdd(kind, undefined, region)}
                  handlers={treeHandlersFor('footer')}
                />
              ) : (
                <button type="button" onClick={() => handleAdd('button', undefined, 'footer')}
                  className="w-full min-h-[40px] border border-dashed border-gray-300 text-gray-600 rounded-md px-3 py-2 text-xs hover:border-green-500 hover:bg-green-50">
                  ＋ 下のボタン帯（フッター）を足す
                </button>
              )}

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

/** step='template': どれから作るかの選択画面 (まっさら + テンプレ + 完成見本ギャラリー)。サムネは FlexPreview 実物。 */
function TemplateStep({ onPick }: { onPick: (tpl: FlexTemplate | null) => void }) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-6">
      <div>
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

      {/* 完成見本ギャラリー (A4)。owner が「作りたい形」を実描画サムネで選べる。選ぶとその形から編集開始。 */}
      <div>
        <p className="text-sm font-medium text-gray-800 mb-1">完成見本ギャラリー</p>
        <p className="text-xs text-gray-500 mb-4">選ぶとこの形から作れます。あとから自由に編集できます。</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {GALLERY_TEMPLATES.map((tpl) => (
            <button
              key={tpl.key}
              type="button"
              onClick={() => onPick(tpl)}
              className="flex flex-col items-center gap-2 p-2 border border-gray-200 rounded-lg text-center hover:border-green-500 hover:bg-green-50 focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              <div className="w-full bg-slate-100 rounded p-1 flex justify-center overflow-hidden" style={{ maxHeight: 150 }}>
                <FlexPreview content={JSON.stringify(buildModelToFlex(tpl.model))} maxWidth={140} />
              </div>
              <span className="text-sm font-medium text-gray-700">{tpl.label}</span>
              {tpl.description && <span className="text-[11px] text-gray-500 leading-snug">{tpl.description}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
