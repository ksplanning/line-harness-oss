'use client'

/**
 * 選択中部品の編集フォーム (F3 + batch B 装飾拡張)。kind に応じて入力欄が切り替わる。
 * heading/body/separator/spacer + image(ImageUploader 埋込 / F5)/button(link-picker / F6)。
 * batch B: text(色/整列/サイズ/装飾/行間/最大行) / image(サイズ/整列) / button(高さ) / separator(色) /
 *   全部品の上マージン。専門語ゼロ・トグルボタン群 (enum 名/数値を極力出さない)。
 */
import ImageUploader from '@/components/shared/image-uploader'
import PersonalizedTextEditor, { type PersonalizedTextEditorMode } from '@/components/shared/personalized-text-editor'
import LinkPicker from './link-picker'
import { BUTTON_STYLE_OPTIONS } from '@/lib/flex-builder/link'
import type { BuilderPart, ImageAspect, ButtonStyle, LinkSpec } from '@/lib/flex-builder/types'

interface Props {
  part: BuilderPart
  onChange: (patch: Partial<BuilderPart>) => void
  textEditorMode?: PersonalizedTextEditorMode
}

const inputCls =
  'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500'

// ---- 共通トグル群 ----
interface Opt { v: string; label: string }

function ToggleGroup({ label, options, value, fallback, onPick }: {
  label: string
  options: Opt[]
  value: string | undefined
  fallback: string // 未指定時に「選択中」に見せる既定値
  onPick: (v: string | undefined) => void
}) {
  const current = value ?? fallback
  return (
    <div>
      <label className="block text-xs text-gray-600 mb-1">{label}</label>
      <div className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o.v}
            type="button"
            onClick={() => onPick(o.v === fallback ? undefined : o.v)}
            className={`min-h-[40px] px-3 rounded-md border text-sm ${
              current === o.v ? 'border-green-500 text-green-700 bg-green-50' : 'border-gray-300 text-gray-600'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

const PRESET_COLORS: { v: string; label: string }[] = [
  { v: '#111111', label: '黒' },
  { v: '#666666', label: 'グレー' },
  { v: '#06C755', label: '緑' },
  { v: '#E53935', label: '赤' },
  { v: '#1E88E5', label: '青' },
  { v: '#FF9800', label: 'オレンジ' },
]

function ColorPicker({ label, value, onPick }: {
  label: string
  value: string | undefined
  onPick: (v: string | undefined) => void
}) {
  return (
    <div>
      <label className="block text-xs text-gray-600 mb-1">{label}</label>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onPick(undefined)}
          className={`min-h-[36px] px-2 rounded-md border text-xs ${!value ? 'border-green-500 text-green-700 bg-green-50' : 'border-gray-300 text-gray-500'}`}
        >
          既定
        </button>
        {PRESET_COLORS.map((c) => (
          <button
            key={c.v}
            type="button"
            aria-label={c.label}
            onClick={() => onPick(c.v)}
            className={`w-8 h-8 rounded-full border-2 ${value?.toLowerCase() === c.v.toLowerCase() ? 'border-green-600 ring-2 ring-green-300' : 'border-gray-200'}`}
            style={{ backgroundColor: c.v }}
          />
        ))}
        <input
          type="text"
          value={value ?? ''}
          onChange={(e) => onPick(e.target.value ? e.target.value : undefined)}
          placeholder="#色コード"
          className="w-24 border border-gray-300 rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-green-500"
        />
      </div>
    </div>
  )
}

const ALIGN_OPTS: Opt[] = [{ v: 'start', label: '左' }, { v: 'center', label: '中央' }, { v: 'end', label: '右' }]
const TEXT_SIZE_OPTS: Opt[] = [{ v: 'sm', label: '小' }, { v: 'md', label: '中' }, { v: 'lg', label: '大' }, { v: 'xl', label: '特大' }, { v: 'xxl', label: '最大' }]
const DECO_OPTS: Opt[] = [{ v: 'none', label: 'なし' }, { v: 'underline', label: '下線' }, { v: 'line-through', label: '取消線' }]
const MARGIN_OPTS: Opt[] = [{ v: 'none', label: 'なし' }, { v: 'sm', label: '小' }, { v: 'md', label: '中' }, { v: 'lg', label: '大' }]
const IMG_SIZE_OPTS: Opt[] = [{ v: 'sm', label: '小' }, { v: 'md', label: '中' }, { v: 'lg', label: '大' }, { v: 'full', label: '最大' }]
const BTN_HEIGHT_OPTS: Opt[] = [{ v: 'sm', label: '低い' }, { v: 'md', label: '普通' }]

/** 上マージン (全部品共通)。 */
function MarginControl({ part, onChange }: Props) {
  const margin = 'margin' in part ? (part.margin as string | undefined) : undefined
  return (
    <ToggleGroup label="上の余白" options={MARGIN_OPTS} value={margin} fallback="none"
      onPick={(v) => onChange({ margin: v } as Partial<BuilderPart>)} />
  )
}

export default function PartEditor({ part, onChange, textEditorMode = 'emoji-only' }: Props) {
  if (part.kind === 'heading' || part.kind === 'body') {
    return (
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-gray-600 mb-1">
            {part.kind === 'heading' ? '見出しの文字' : '本文の文字'}
          </label>
          <PersonalizedTextEditor
            mode={textEditorMode}
            rows={part.kind === 'heading' ? 2 : 4}
            value={part.text}
            onChange={(text) => onChange({ text } as Partial<BuilderPart>)}
            ariaLabel={part.kind === 'heading' ? '見出しの文字' : '本文の文字'}
            className={`${inputCls} resize-y`}
            placeholder={part.kind === 'heading' ? '例: 春の新色ネイル 20%OFF' : '例: 3月末まで全メニュー20%OFF'}
          />
        </div>
        <ColorPicker label="文字の色" value={part.color} onPick={(v) => onChange({ color: v } as Partial<BuilderPart>)} />
        <ToggleGroup label="文字の位置" options={ALIGN_OPTS} value={part.align} fallback="start"
          onPick={(v) => onChange({ align: v } as Partial<BuilderPart>)} />
        <ToggleGroup label="文字の大きさ" options={TEXT_SIZE_OPTS} value={part.size} fallback={part.kind === 'heading' ? 'lg' : 'md'}
          onPick={(v) => onChange({ size: v } as Partial<BuilderPart>)} />
        <ToggleGroup label="下線・取消線" options={DECO_OPTS} value={part.decoration} fallback="none"
          onPick={(v) => onChange({ decoration: v } as Partial<BuilderPart>)} />
        <details className="text-xs">
          <summary className="cursor-pointer text-gray-500">くわしい設定 (行間・最大行数)</summary>
          <div className="mt-2 space-y-2">
            <div>
              <label className="block text-gray-600 mb-1">行の間隔</label>
              <input type="text" value={part.lineSpacing ?? ''} placeholder="例: 10px"
                onChange={(e) => onChange({ lineSpacing: e.target.value || undefined } as Partial<BuilderPart>)}
                className="w-32 border border-gray-300 rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-green-500" />
            </div>
            <div>
              <label className="block text-gray-600 mb-1">最大行数 (0=無制限)</label>
              <input type="number" min={0} value={part.maxLines ?? ''}
                onChange={(e) => onChange({ maxLines: e.target.value === '' ? undefined : Number(e.target.value) } as Partial<BuilderPart>)}
                className="w-24 border border-gray-300 rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-green-500" />
            </div>
          </div>
        </details>
        <MarginControl part={part} onChange={onChange} />
      </div>
    )
  }

  if (part.kind === 'icon') {
    const ICON_SIZE_OPTS: Opt[] = [{ v: 'xs', label: '極小' }, { v: 'sm', label: '小' }, { v: 'md', label: '中' }, { v: 'lg', label: '大' }, { v: 'xl', label: '特大' }]
    return (
      <div className="space-y-3">
        <p className="text-xs text-gray-500">文字の横に置く小さな画像です（「箱」を「よこ」にして文字と並べると効果的）。</p>
        <div>
          <label className="block text-xs text-gray-600 mb-1">アイコン画像</label>
          <ImageUploader
            mode="url"
            value={part.url ? { mode: 'url', url: part.url } : null}
            onChange={(next) => onChange({ url: next && next.mode === 'url' ? next.url : '' } as Partial<BuilderPart>)}
          />
        </div>
        <ToggleGroup label="大きさ" options={ICON_SIZE_OPTS} value={part.size} fallback="md"
          onPick={(v) => onChange({ size: v ?? 'md' } as Partial<BuilderPart>)} />
        <MarginControl part={part} onChange={onChange} />
      </div>
    )
  }

  if (part.kind === 'richtext') {
    const WEIGHT_OPTS: Opt[] = [{ v: 'regular', label: '標準' }, { v: 'bold', label: '太字' }]
    const SPAN_SIZE_OPTS: Opt[] = [{ v: 'sm', label: '小' }, { v: 'md', label: '中' }, { v: 'lg', label: '大' }, { v: 'xl', label: '特大' }]
    const updateRun = (i: number, patch: Record<string, unknown>) =>
      onChange({ runs: part.runs.map((r, j) => (j === i ? { ...r, ...patch } : r)) } as Partial<BuilderPart>)
    return (
      <div className="space-y-3">
        <p className="text-xs text-gray-500">語ごとに色・大きさ・太さを変えられる文です。「区間」を足して部分的に飾ります。</p>
        {part.runs.map((run, i) => (
          <div key={i} className="rounded-md border border-gray-200 p-2 space-y-2 bg-white">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-gray-600">区間 {i + 1}</span>
              {part.runs.length > 1 && (
                <button type="button" onClick={() => onChange({ runs: part.runs.filter((_, j) => j !== i) } as Partial<BuilderPart>)}
                  className="text-xs text-red-600 px-2 py-1 hover:bg-red-50 rounded" aria-label={`区間 ${i + 1} を消す`}>消す</button>
              )}
            </div>
            <PersonalizedTextEditor
              mode={textEditorMode}
              multiline={false}
              value={run.text}
              onChange={(text) => updateRun(i, { text })}
              ariaLabel={`区間 ${i + 1} の文字`}
              className={inputCls}
              placeholder="この区間の文字"
            />
            <ColorPicker label="色" value={run.color} onPick={(v) => updateRun(i, { color: v })} />
            <div className="flex gap-3">
              <ToggleGroup label="太さ" options={WEIGHT_OPTS} value={run.weight} fallback="regular" onPick={(v) => updateRun(i, { weight: v })} />
              <ToggleGroup label="大きさ" options={SPAN_SIZE_OPTS} value={run.size} fallback="md" onPick={(v) => updateRun(i, { size: v })} />
            </div>
          </div>
        ))}
        <button type="button" onClick={() => onChange({ runs: [...part.runs, { text: '' }] } as Partial<BuilderPart>)}
          className="w-full min-h-[40px] border border-dashed border-green-400 text-green-700 rounded-md px-3 py-2 text-xs hover:bg-green-50">
          ＋ 区間を足す
        </button>
        <ToggleGroup label="文全体の位置" options={ALIGN_OPTS} value={part.align} fallback="start"
          onPick={(v) => onChange({ align: v } as Partial<BuilderPart>)} />
        <MarginControl part={part} onChange={onChange} />
      </div>
    )
  }

  if (part.kind === 'box') {
    const LAYOUT_OPTS: Opt[] = [{ v: 'vertical', label: 'たて' }, { v: 'horizontal', label: 'よこ' }]
    const CORNER_OPTS: Opt[] = [{ v: 'none', label: 'なし' }, { v: 'sm', label: '小' }, { v: 'md', label: '中' }, { v: 'lg', label: '大' }]
    const PAD_OPTS: Opt[] = [{ v: 'none', label: 'なし' }, { v: 'sm', label: '小' }, { v: 'md', label: '中' }, { v: 'lg', label: '大' }]
    const SPACING_OPTS: Opt[] = [{ v: 'none', label: 'なし' }, { v: 'sm', label: '小' }, { v: 'md', label: '中' }, { v: 'lg', label: '大' }]
    const JUSTIFY_OPTS: Opt[] = [{ v: 'flex-start', label: '左/上寄せ' }, { v: 'center', label: '中央' }, { v: 'flex-end', label: '右/下寄せ' }, { v: 'space-between', label: '両端に離す' }]
    const ALIGNITEMS_OPTS: Opt[] = [{ v: 'flex-start', label: '手前' }, { v: 'center', label: '中央' }, { v: 'flex-end', label: '奥' }]
    return (
      <div className="space-y-3">
        <p className="text-xs text-gray-500">中に部品を入れて、たて/よこに並べる箱です。下の「＋ この箱に部品を足す」から中身を追加します。</p>
        <ToggleGroup label="並べる向き" options={LAYOUT_OPTS} value={part.layout} fallback="horizontal"
          onPick={(v) => onChange({ layout: (v ?? 'horizontal') as 'vertical' | 'horizontal' } as Partial<BuilderPart>)} />
        <ColorPicker label="背景の色" value={part.backgroundColor} onPick={(v) => onChange({ backgroundColor: v } as Partial<BuilderPart>)} />
        <ToggleGroup label="角の丸み" options={CORNER_OPTS} value={part.cornerRadius} fallback="none"
          onPick={(v) => onChange({ cornerRadius: v } as Partial<BuilderPart>)} />
        <ToggleGroup label="内側の余白" options={PAD_OPTS} value={part.paddingAll} fallback="none"
          onPick={(v) => onChange({ paddingAll: v } as Partial<BuilderPart>)} />
        <ToggleGroup label="中身のすき間" options={SPACING_OPTS} value={part.spacing} fallback="none"
          onPick={(v) => onChange({ spacing: v } as Partial<BuilderPart>)} />
        <details className="text-xs">
          <summary className="cursor-pointer text-gray-500">くわしい設定 (そろえ・枠線・幅/高さ)</summary>
          <div className="mt-2 space-y-3">
            <ToggleGroup label="横のそろえ方" options={JUSTIFY_OPTS} value={part.justifyContent} fallback="flex-start"
              onPick={(v) => onChange({ justifyContent: v } as Partial<BuilderPart>)} />
            <ToggleGroup label="縦のそろえ方" options={ALIGNITEMS_OPTS} value={part.alignItems} fallback="flex-start"
              onPick={(v) => onChange({ alignItems: v } as Partial<BuilderPart>)} />
            <ColorPicker label="枠線の色" value={part.borderColor}
              onPick={(v) => onChange({ borderColor: v, borderWidth: v ? (part.borderWidth ?? '1px') : undefined } as Partial<BuilderPart>)} />
            <div className="flex gap-3">
              <div>
                <label className="block text-gray-600 mb-1">幅 (例 100px / 50%)</label>
                <input type="text" value={part.width ?? ''} placeholder="自動"
                  onChange={(e) => onChange({ width: e.target.value || undefined } as Partial<BuilderPart>)}
                  className="w-28 border border-gray-300 rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-green-500" />
              </div>
              <div>
                <label className="block text-gray-600 mb-1">高さ (例 60px)</label>
                <input type="text" value={part.height ?? ''} placeholder="自動"
                  onChange={(e) => onChange({ height: e.target.value || undefined } as Partial<BuilderPart>)}
                  className="w-28 border border-gray-300 rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-green-500" />
              </div>
            </div>
          </div>
        </details>
        <details className="text-xs">
          <summary className="cursor-pointer text-gray-500">重ね・グラデーション（上級）</summary>
          <div className="mt-2 space-y-3">
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={Boolean(part.background)}
                onChange={(e) => onChange({ background: e.target.checked ? { type: 'linearGradient', angle: '90deg', startColor: '#06C755', endColor: '#03793C' } : undefined } as Partial<BuilderPart>)}
                className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500" />
              <span className="text-gray-600">グラデーション背景を使う</span>
            </label>
            {part.background && (
              <div className="space-y-2 pl-1">
                <ColorPicker label="開始の色" value={part.background.startColor}
                  onPick={(v) => onChange({ background: { ...part.background!, startColor: v ?? '#06C755' } } as Partial<BuilderPart>)} />
                <ColorPicker label="終わりの色" value={part.background.endColor}
                  onPick={(v) => onChange({ background: { ...part.background!, endColor: v ?? '#03793C' } } as Partial<BuilderPart>)} />
                <div>
                  <label className="block text-gray-600 mb-1">向き（角度）</label>
                  <input type="text" value={part.background.angle} placeholder="例: 90deg"
                    onChange={(e) => onChange({ background: { ...part.background!, angle: e.target.value } } as Partial<BuilderPart>)}
                    className="w-28 border border-gray-300 rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-green-500" />
                </div>
              </div>
            )}
            <ToggleGroup label="重ね方" options={[{ v: 'relative', label: '通常' }, { v: 'absolute', label: '重ねる' }]} value={part.position} fallback="relative"
              onPick={(v) => onChange({ position: v } as Partial<BuilderPart>)} />
            {part.position === 'absolute' && (
              <div className="flex gap-3 pl-1">
                <div>
                  <label className="block text-gray-600 mb-1">上から (例 10px)</label>
                  <input type="text" value={part.offsetTop ?? ''} placeholder="0"
                    onChange={(e) => onChange({ offsetTop: e.target.value || undefined } as Partial<BuilderPart>)}
                    className="w-24 border border-gray-300 rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-green-500" />
                </div>
                <div>
                  <label className="block text-gray-600 mb-1">左から (例 10px)</label>
                  <input type="text" value={part.offsetStart ?? ''} placeholder="0"
                    onChange={(e) => onChange({ offsetStart: e.target.value || undefined } as Partial<BuilderPart>)}
                    className="w-24 border border-gray-300 rounded-md px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-green-500" />
                </div>
              </div>
            )}
          </div>
        </details>
        <MarginControl part={part} onChange={onChange} />
      </div>
    )
  }

  if (part.kind === 'separator') {
    return (
      <div className="space-y-3">
        <p className="text-xs text-gray-500">上下を仕切る細い線です。</p>
        <ColorPicker label="線の色" value={part.color} onPick={(v) => onChange({ color: v } as Partial<BuilderPart>)} />
        <MarginControl part={part} onChange={onChange} />
      </div>
    )
  }

  if (part.kind === 'spacer') {
    const sizes: Opt[] = [{ v: 'sm', label: '小' }, { v: 'md', label: '中' }, { v: 'lg', label: '大' }]
    return (
      <div>
        <label className="block text-xs text-gray-600 mb-1">すき間の大きさ</label>
        <div className="flex gap-2">
          {sizes.map((s) => (
            <button
              key={s.v}
              type="button"
              onClick={() => onChange({ size: s.v } as Partial<BuilderPart>)}
              className={`min-h-[44px] px-4 rounded-md border text-sm ${
                (part.size ?? 'md') === s.v
                  ? 'border-green-500 text-green-700 bg-green-50'
                  : 'border-gray-300 text-gray-600'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
    )
  }

  if (part.kind === 'image') {
    const aspects: { v: ImageAspect; label: string }[] = [
      { v: 'original', label: 'そのまま' },
      { v: 'landscape', label: '横長' },
      { v: 'square', label: '正方形' },
    ]
    return (
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-gray-600 mb-1">画像</label>
          <ImageUploader
            mode="url"
            value={part.url ? { mode: 'url', url: part.url } : null}
            onChange={(next) =>
              onChange({ url: next && next.mode === 'url' ? next.url : '' } as Partial<BuilderPart>)
            }
          />
        </div>
        <div>
          <label className="block text-xs text-gray-600 mb-1">画像の形</label>
          <div className="flex gap-2">
            {aspects.map((a) => (
              <button
                key={a.v}
                type="button"
                onClick={() => onChange({ aspect: a.v } as Partial<BuilderPart>)}
                className={`min-h-[44px] px-3 rounded-md border text-sm ${
                  (part.aspect ?? 'original') === a.v
                    ? 'border-green-500 text-green-700 bg-green-50'
                    : 'border-gray-300 text-gray-600'
                }`}
              >
                {a.label}
              </button>
            ))}
          </div>
        </div>
        <ToggleGroup label="画像の大きさ" options={IMG_SIZE_OPTS} value={part.size} fallback="full"
          onPick={(v) => onChange({ size: v } as Partial<BuilderPart>)} />
        <ToggleGroup label="画像の位置" options={ALIGN_OPTS} value={part.align} fallback="center"
          onPick={(v) => onChange({ align: v } as Partial<BuilderPart>)} />
        <label className="inline-flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={Boolean(part.rounded)}
            onChange={(e) => onChange({ rounded: e.target.checked } as Partial<BuilderPart>)}
            className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
          />
          <span className="text-xs text-gray-600">角を少し丸くする</span>
        </label>
        <div>
          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={Boolean(part.tapLink)}
              onChange={(e) =>
                onChange({
                  tapLink: e.target.checked ? { type: 'url', uri: '' } : undefined,
                } as Partial<BuilderPart>)
              }
              className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
            />
            <span className="text-xs text-gray-600">画像を押したら移動する</span>
          </label>
          {part.tapLink && (
            <div className="mt-2">
              <LinkPicker
                value={part.tapLink}
                onChange={(link: LinkSpec) => onChange({ tapLink: link } as Partial<BuilderPart>)}
              />
            </div>
          )}
        </div>
        <MarginControl part={part} onChange={onChange} />
      </div>
    )
  }

  // video は hero 専用でモーダル側が編集する (PartEditor では扱わない = exhaustive 用ガード)。
  if (part.kind !== 'button') return null

  // button
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-gray-600 mb-1">ボタンの文字</label>
        <PersonalizedTextEditor
          mode={textEditorMode}
          multiline={false}
          value={part.label}
          onChange={(label) => onChange({ label } as Partial<BuilderPart>)}
          ariaLabel="ボタンの文字"
          className={inputCls}
          placeholder="例: 予約する"
        />
      </div>
      <LinkPicker
        value={part.link}
        onChange={(link: LinkSpec) => onChange({ link } as Partial<BuilderPart>)}
      />
      <div>
        <label className="block text-xs text-gray-600 mb-1">ボタンの色</label>
        <div className="flex gap-2">
          {BUTTON_STYLE_OPTIONS.map((s: { value: ButtonStyle; label: string }) => (
            <button
              key={s.value}
              type="button"
              onClick={() => onChange({ style: s.value } as Partial<BuilderPart>)}
              className={`min-h-[44px] px-3 rounded-md border text-sm ${
                part.style === s.value
                  ? 'border-green-500 text-green-700 bg-green-50'
                  : 'border-gray-300 text-gray-600'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <ToggleGroup label="ボタンの高さ" options={BTN_HEIGHT_OPTS} value={part.height} fallback="md"
        onPick={(v) => onChange({ height: v } as Partial<BuilderPart>)} />
      <MarginControl part={part} onChange={onChange} />
    </div>
  )
}
