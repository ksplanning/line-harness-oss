'use client'

/**
 * 部品パレット (F2)。「＋ 部品を足す」を押すと 6 種を大きなタップ標的で表示。
 * 追加すると部品リスト末尾に足され、自動選択される (追加→即編集の一気通貫)。
 * 専門語ゼロ・日本語ラベル (おばあちゃん基準)。
 */
import { useState, type ComponentType, type SVGProps } from 'react'
import type { PartKind } from '@/lib/flex-builder/types'
import {
  HeadingIcon,
  BodyTextIcon,
  ImageIcon,
  ButtonIcon,
  SeparatorIcon,
  SpacerIcon,
} from '@/components/shared/icons'

interface PaletteItem {
  kind: PartKind
  Icon: ComponentType<SVGProps<SVGSVGElement>>
  label: string
  hint: string
}

// 装飾は絵文字文字でなく inline SVG (M-19: VS16 無し text-presentation 絵文字の豆腐を根絶)。
const ITEMS: PaletteItem[] = [
  { kind: 'heading', Icon: HeadingIcon, label: '見出し', hint: '大きい太字の文字' },
  { kind: 'body', Icon: BodyTextIcon, label: '本文', hint: '説明の文章' },
  { kind: 'image', Icon: ImageIcon, label: '画像', hint: '写真・バナー' },
  { kind: 'button', Icon: ButtonIcon, label: 'ボタン', hint: '押すとリンク先へ飛ぶ' },
  { kind: 'separator', Icon: SeparatorIcon, label: '区切り線', hint: '上下を仕切る細い線' },
  { kind: 'spacer', Icon: SpacerIcon, label: '余白', hint: 'すき間をあける' },
]

export default function PartPalette({ onAdd }: { onAdd: (kind: PartKind) => void }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full min-h-[44px] border border-dashed border-green-400 text-green-700 rounded-md px-3 py-2 text-sm font-medium hover:bg-green-50 focus:outline-none focus:ring-2 focus:ring-green-500"
      >
        {open ? '▾ 部品を足す' : '＋ 部品を足す'}
      </button>
      {open && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          {ITEMS.map((it) => (
            <button
              key={it.kind}
              type="button"
              onClick={() => {
                onAdd(it.kind)
                setOpen(false)
              }}
              className="flex items-start gap-2 min-h-[44px] border border-gray-300 rounded-md px-3 py-2 text-left hover:border-green-500 hover:bg-green-50 focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              <span className="text-lg leading-none text-gray-600" aria-hidden>
                <it.Icon />
              </span>
              <span>
                <span className="block text-sm font-medium text-gray-900">{it.label}</span>
                <span className="block text-[11px] text-gray-500">{it.hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
