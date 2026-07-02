'use client'

/**
 * 選択中部品の編集フォーム (F3)。kind に応じて入力欄が切り替わる。
 * heading/body/separator/spacer + image(ImageUploader 埋込 / F5)/button(link-picker / F6)。
 * 専門語ゼロ・日本語ラベル。
 */
import ImageUploader from '@/components/shared/image-uploader'
import LinkPicker from './link-picker'
import { BUTTON_STYLE_OPTIONS } from '@/lib/flex-builder/link'
import type { BuilderPart, ImageAspect, ButtonStyle, LinkSpec } from '@/lib/flex-builder/types'

interface Props {
  part: BuilderPart
  onChange: (patch: Partial<BuilderPart>) => void
}

const inputCls =
  'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500'

export default function PartEditor({ part, onChange }: Props) {
  if (part.kind === 'heading' || part.kind === 'body') {
    return (
      <div>
        <label className="block text-xs text-gray-600 mb-1">
          {part.kind === 'heading' ? '見出しの文字' : '本文の文字'}
        </label>
        <textarea
          rows={part.kind === 'heading' ? 2 : 4}
          value={part.text}
          onChange={(e) => onChange({ text: e.target.value } as Partial<BuilderPart>)}
          className={`${inputCls} resize-y`}
          placeholder={part.kind === 'heading' ? '例: 春の新色ネイル 20%OFF' : '例: 3月末まで全メニュー20%OFF'}
        />
      </div>
    )
  }

  if (part.kind === 'separator') {
    return <p className="text-xs text-gray-500">上下を仕切る細い線です。設定はありません。</p>
  }

  if (part.kind === 'spacer') {
    const sizes: { v: string; label: string }[] = [
      { v: 'sm', label: '小' },
      { v: 'md', label: '中' },
      { v: 'lg', label: '大' },
    ]
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
      </div>
    )
  }

  // button
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-gray-600 mb-1">ボタンの文字</label>
        <input
          type="text"
          value={part.label}
          onChange={(e) => onChange({ label: e.target.value } as Partial<BuilderPart>)}
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
    </div>
  )
}
