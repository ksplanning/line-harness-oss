'use client'

import { FEATURE_KEYS, FEATURE_LABELS, FEATURE_DESCRIPTIONS } from '@line-crm/shared'

/**
 * 権限マトリクス (G64 R-2 の核心 UI)。19 機能エリアを縦に並べ、各行に ON/OFF トグル 1 個。
 * 素人が読めるよう日本語ラベル + 1 行説明を常時表示 (ポップオーバーに隠さない / grandma 基準)。
 * スタッフ管理 (staff_admin) は警告色 + ON 時の注記で self-lockout を UX で予防する。
 * enforcement は worker が正典 (ここは UX のみ)。375px でも縦積みで崩れない。
 */
export function PermissionMatrix({
  value,
  onChange,
  disabled = false,
}: {
  value: Record<string, boolean>
  onChange: (feature: string, allowed: boolean) => void
  disabled?: boolean
}) {
  return (
    <div className="divide-y divide-gray-100 border border-gray-200 rounded-lg overflow-hidden bg-white">
      {FEATURE_KEYS.map((f) => {
        const on = Boolean(value[f])
        const isDanger = f === 'staff_admin'
        return (
          <div key={f} className="flex items-start justify-between gap-3 px-4 py-3">
            <div className="flex-1 min-w-0">
              <span className={`text-sm font-medium ${isDanger ? 'text-red-700' : 'text-gray-900'}`}>
                {FEATURE_LABELS[f]}
              </span>
              <p className="text-xs text-gray-500 mt-0.5 leading-snug">{FEATURE_DESCRIPTIONS[f]}</p>
              {isDanger && on && (
                <p className="text-xs text-red-600 mt-1 font-medium">
                  ⚠️ この役割の人が他のスタッフや権限を変更できるようになります
                </p>
              )}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={on}
              aria-label={FEATURE_LABELS[f]}
              disabled={disabled}
              onClick={() => onChange(f, !on)}
              className={`relative shrink-0 inline-flex items-center min-w-[44px] min-h-[44px] justify-center rounded-lg ${
                disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
              }`}
            >
              <span
                className={`relative block w-12 h-7 rounded-full transition-colors ${on ? '' : 'bg-gray-300'}`}
                style={on ? { backgroundColor: '#06C755' } : {}}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform ${
                    on ? 'translate-x-5' : ''
                  }`}
                />
              </span>
            </button>
          </div>
        )
      })}
    </div>
  )
}

/** テンプレ features 配列 → 19 feature の Record (未含=false)。 */
export function featuresToRecord(features: string[]): Record<string, boolean> {
  const rec: Record<string, boolean> = {}
  for (const f of FEATURE_KEYS) rec[f] = features.includes(f)
  return rec
}
