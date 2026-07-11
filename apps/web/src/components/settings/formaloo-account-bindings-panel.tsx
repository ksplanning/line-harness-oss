'use client'

import type { FormalooWorkspace } from '@/lib/formaloo-workspaces-api'

// =============================================================================
// アカウント→既定 workspace binding パネル (F6-2 / T-B3 web)。表示専用 (state は親が保持)。
// -----------------------------------------------------------------------------
// 「どの LINE アカウントのフォームを、どのワークスペース(=鍵) を既定にして作るか」を owner が設定する。
// set = 登録済 active workspace を選択 / clear = 「既定なし（環境の鍵）」を選択。設定後、作成 UI の
// workspace セレクタ既定に反映される (populate 経路 = dead でない / Codex M#6)。
// =============================================================================

export interface AccountLite {
  id: string
  name: string
  displayName?: string
}

export interface FormalooAccountBindingsPanelProps {
  accounts: AccountLite[]
  /** active な登録済 workspace のみ (無効値を選ばせない)。 */
  workspaces: FormalooWorkspace[]
  /** lineAccountId → defaultWorkspaceId (未設定は不在)。 */
  bindings: Record<string, string | null>
  onSet: (lineAccountId: string, workspaceId: string) => void
  onClear: (lineAccountId: string) => void
  busy?: boolean
}

export default function FormalooAccountBindingsPanel({
  accounts,
  workspaces,
  bindings,
  onSet,
  onClear,
  busy = false,
}: FormalooAccountBindingsPanelProps) {
  return (
    <div data-testid="account-bindings-panel" className="space-y-3">
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">アカウントごとの既定ワークスペース</h2>
        <p className="text-xs text-gray-400 mb-2">
          フォームを新規作成するとき、どのワークスペース（鍵）に作るかの既定をアカウントごとに設定できます。
          設定しない場合は環境の既定の鍵が使われます。
        </p>
        {accounts.length === 0 ? (
          <div data-testid="ab-empty" className="bg-white rounded-lg border border-gray-200 p-6 text-center text-gray-400 text-sm">
            LINE アカウントがまだありません。
          </div>
        ) : (
          <ul data-testid="ab-list" className="space-y-2">
            {accounts.map((a) => {
              const current = bindings[a.id] ?? ''
              return (
                <li
                  key={a.id}
                  data-testid={`ab-item-${a.id}`}
                  className="bg-white rounded-lg border border-gray-200 px-4 py-3 flex items-center gap-3"
                >
                  <span className="flex-1 min-w-0 text-sm font-medium text-gray-900 truncate">
                    {a.displayName || a.name}
                  </span>
                  <select
                    data-testid={`ab-select-${a.id}`}
                    value={current}
                    disabled={busy}
                    onChange={(e) => {
                      const v = e.target.value
                      if (v) onSet(a.id, v)
                      else onClear(a.id)
                    }}
                    className="border border-gray-300 rounded px-2 py-1 text-sm disabled:opacity-50"
                  >
                    <option value="">既定なし（環境の鍵）</option>
                    {workspaces.map((w) => (
                      <option key={w.id} value={w.id}>{w.label}</option>
                    ))}
                  </select>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
