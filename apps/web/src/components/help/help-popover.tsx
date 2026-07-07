'use client'

/**
 * 共通ヘルプ (G66 / H-1)。ラベルの横に「？」を置き、押すと画像+短文のポップオーバーを開く。
 * 内容は help-catalog (静的) 引き。375px で画面外に出ないよう、開く位置が画面下端に近ければ
 * 上に反転し、幅は viewport を超えない。Esc / 外側クリック / 「閉じる」で閉じ、role=dialog。
 */
import { useEffect, useRef, useState } from 'react'
import { HelpIcon } from '@/components/shared/icons'
import { getHelp } from '@/lib/help/help-catalog'
import { popoverPlacement, type PopoverPlacement } from '@/lib/help/popover-placement'

export default function HelpPopover({ helpKey, label }: { helpKey: string; label?: string }) {
  const entry = getHelp(helpKey)
  const [open, setOpen] = useState(false)
  const [placement, setPlacement] = useState<PopoverPlacement>({ horizontal: 'left', vertical: 'below' })
  const rootRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  // 未登録 helpKey は静かに非表示 (実 UI に「？」が増殖しない fail-safe)。
  if (!entry) return null

  const title = label ?? entry.title

  function toggle() {
    if (!open && rootRef.current && typeof window !== 'undefined') {
      const rect = rootRef.current.getBoundingClientRect()
      // 縦=下端近くは上に反転 / 横=右にはみ出すなら right 基準へ (375px で画面外に出ない)。
      setPlacement(
        popoverPlacement(
          { left: rect.left, bottom: rect.bottom },
          { width: window.innerWidth || 0, height: window.innerHeight || 0 },
        ),
      )
    }
    setOpen((v) => !v)
  }

  return (
    <span ref={rootRef} className="relative inline-flex align-middle">
      <button
        type="button"
        onClick={toggle}
        aria-label={`${title}のヘルプ`}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="inline-flex items-center justify-center min-w-[32px] min-h-[32px] rounded-full text-gray-400 hover:text-green-600 focus:outline-none focus:ring-2 focus:ring-green-500"
      >
        <HelpIcon className="w-4 h-4" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={title}
          className={`absolute z-30 ${placement.horizontal === 'right' ? 'right-0' : 'left-0'} ${placement.vertical === 'above' ? 'bottom-9' : 'top-9'} w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-gray-200 bg-white p-3 shadow-lg`}
        >
          <p className="text-xs font-semibold text-gray-900 mb-1.5">{entry.title}</p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={entry.imageSrc}
            alt={entry.altText}
            width={720}
            height={720}
            loading="lazy"
            className="w-full h-auto rounded border border-gray-100 bg-gray-50"
          />
          <p className="mt-2 text-xs leading-relaxed text-gray-600">{entry.text}</p>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="mt-2 min-h-[32px] text-[11px] text-gray-400 hover:text-gray-700"
          >
            閉じる
          </button>
        </div>
      )}
    </span>
  )
}
