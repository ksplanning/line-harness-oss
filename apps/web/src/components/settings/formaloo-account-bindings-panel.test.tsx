// @vitest-environment jsdom
/**
 * T-B3 (F6-2 / web) — FormalooAccountBindingsPanel component test (populate 経路 dead でない / Codex M#6)。
 *   ① アカウント一覧 + 現在の既定 workspace を出す。
 *   ② active workspace を選ぶと onSet(lineAccountId, workspaceId)。
 *   ③ 「既定なし」を選ぶと onClear(lineAccountId)。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import FormalooAccountBindingsPanel, { type FormalooAccountBindingsPanelProps } from './formaloo-account-bindings-panel'
import type { FormalooWorkspace } from '@/lib/formaloo-workspaces-api'

afterEach(() => cleanup())

const WS: FormalooWorkspace[] = [
  { id: 'fw_1', label: 'A社アカウント', businessSlug: 'acme', isActive: true },
  { id: 'fw_2', label: 'B社', businessSlug: null, isActive: true },
]

function base(over: Partial<FormalooAccountBindingsPanelProps> = {}): FormalooAccountBindingsPanelProps {
  return {
    accounts: [
      { id: 'acc_A', name: 'アカウントA' },
      { id: 'acc_B', name: 'アカウントB' },
    ],
    workspaces: WS,
    bindings: { acc_A: 'fw_1' },
    onSet: vi.fn(),
    onClear: vi.fn(),
    ...over,
  }
}

describe('FormalooAccountBindingsPanel', () => {
  it('① アカウント一覧 + 現在の既定を反映', () => {
    render(<FormalooAccountBindingsPanel {...base()} />)
    expect(screen.getByTestId('ab-item-acc_A').textContent).toContain('アカウントA')
    expect((screen.getByTestId('ab-select-acc_A') as HTMLSelectElement).value).toBe('fw_1')
    // 未設定アカウントは既定なし ('')
    expect((screen.getByTestId('ab-select-acc_B') as HTMLSelectElement).value).toBe('')
  })

  it('② active workspace を選ぶと onSet', () => {
    const p = base()
    render(<FormalooAccountBindingsPanel {...p} />)
    fireEvent.change(screen.getByTestId('ab-select-acc_B'), { target: { value: 'fw_2' } })
    expect(p.onSet).toHaveBeenCalledWith('acc_B', 'fw_2')
  })

  it('③ 既定なしを選ぶと onClear', () => {
    const p = base()
    render(<FormalooAccountBindingsPanel {...p} />)
    fireEvent.change(screen.getByTestId('ab-select-acc_A'), { target: { value: '' } })
    expect(p.onClear).toHaveBeenCalledWith('acc_A')
  })

  it('アカウントが無ければ案内', () => {
    render(<FormalooAccountBindingsPanel {...base({ accounts: [] })} />)
    expect(screen.getByTestId('ab-empty')).toBeTruthy()
    expect(screen.queryByTestId('ab-list')).toBeNull()
  })
})
