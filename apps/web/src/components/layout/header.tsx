import React from 'react'

interface HeaderProps {
  title: string
  description?: string
  action?: React.ReactNode
}

export default function Header({ title, description, action }: HeaderProps) {
  return (
    <div className="mb-8">
      {/* flex-wrap + gap: action が多い/画面が狭いと action 群がタイトル下に折返す (mobile375 の
          主CTA 見切れ・h1 縦積み・横スクロールを防ぐ)。広い画面では 1 行に収まり従来と同一 (回帰なし)。 */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight">{title}</h1>
          {description && (
            <p className="mt-1 text-sm text-gray-500">{description}</p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </div>
  )
}
