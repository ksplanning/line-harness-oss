'use client'

/**
 * 選択中部品の編集フォーム (F3)。kind に応じて入力欄が切り替わる。
 * C2: heading/body/separator/spacer を実装。
 * C3: image(ImageUploader 埋込)/button(link-picker) を差し替え・拡張する。
 * 専門語ゼロ・日本語ラベル。
 */
import type { BuilderPart } from '@/lib/flex-builder/types'

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

  // image / button は C3 で ImageUploader / link-picker を埋め込む (C2 は最小欄)。
  if (part.kind === 'image') {
    return (
      <div>
        <label className="block text-xs text-gray-600 mb-1">画像のリンク先 (この欄は次の工程でアップローダに置き換わります)</label>
        <input
          type="text"
          value={part.url}
          onChange={(e) => onChange({ url: e.target.value } as Partial<BuilderPart>)}
          className={inputCls}
          placeholder="https://..."
        />
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
      <div>
        <label className="block text-xs text-gray-600 mb-1">リンク先 (この欄は次の工程で選択式に置き換わります)</label>
        <input
          type="text"
          value={part.link.uri}
          onChange={(e) =>
            onChange({ link: { type: 'url', uri: e.target.value } } as Partial<BuilderPart>)
          }
          className={inputCls}
          placeholder="https://..."
        />
      </div>
    </div>
  )
}
