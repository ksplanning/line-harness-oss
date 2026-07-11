// @vitest-environment jsdom
/**
 * T-A5 (F6-1 / web) — FormalooWorkspacesPanel component test。
 *   ① 一覧表示 (label / business slug / 有効状態)
 *   ② 追加フォーム (label+KEY+SECRET) → onAdd に入力値が渡る
 *   ③ 保存後 KEY/SECRET が画面に再表示されない: password 入力 (マスク) + 追加押下で即クリア
 *   ④ 疎通テスト UI → onTest 呼び出し / 結果表示
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import FormalooWorkspacesPanel, { type FormalooWorkspacesPanelProps } from './formaloo-workspaces-panel'
import type { FormalooWorkspace } from '@/lib/formaloo-workspaces-api'

afterEach(() => cleanup())

const WS: FormalooWorkspace[] = [
  { id: 'fw_1', label: 'A社アカウント', businessSlug: 'acme', isActive: true },
  { id: 'fw_2', label: 'B社', businessSlug: null, isActive: false },
]

function base(over: Partial<FormalooWorkspacesPanelProps> = {}): FormalooWorkspacesPanelProps {
  return {
    workspaces: WS,
    onAdd: vi.fn(),
    onTest: vi.fn(),
    onToggleActive: vi.fn(),
    onRemove: vi.fn(),
    ...over,
  }
}

function fill(testid: string, value: string) {
  fireEvent.change(screen.getByTestId(testid), { target: { value } })
}

describe('FormalooWorkspacesPanel — 一覧 (①)', () => {
  it('label / business slug / 有効状態を出す', () => {
    render(<FormalooWorkspacesPanel {...base()} />)
    expect(screen.getByTestId('ws-item-fw_1').textContent).toContain('A社アカウント')
    expect(screen.getByTestId('ws-item-fw_1').textContent).toContain('acme')
    expect(screen.getByTestId('ws-active-fw_1').textContent).toBe('有効')
    expect(screen.getByTestId('ws-active-fw_2').textContent).toBe('無効')
  })

  it('空なら案内を出す', () => {
    render(<FormalooWorkspacesPanel {...base({ workspaces: [] })} />)
    expect(screen.getByTestId('ws-empty')).toBeTruthy()
    expect(screen.queryByTestId('ws-list')).toBeNull()
  })

  it('無効化 / 削除ボタンが callback を呼ぶ', () => {
    const p = base()
    render(<FormalooWorkspacesPanel {...p} />)
    fireEvent.click(screen.getAllByText('無効化')[0])
    expect(p.onToggleActive).toHaveBeenCalledWith('fw_1', false)
    fireEvent.click(screen.getByText('有効化')) // fw_2 (無効) のみ
    expect(p.onToggleActive).toHaveBeenCalledWith('fw_2', true)
    fireEvent.click(screen.getAllByText('削除')[0])
    expect(p.onRemove).toHaveBeenCalledWith('fw_1')
  })
})

describe('FormalooWorkspacesPanel — 追加 (② ③)', () => {
  it('label+KEY+SECRET を入力して「追加する」で onAdd に渡る', () => {
    const p = base({ workspaces: [] })
    render(<FormalooWorkspacesPanel {...p} />)
    fill('ws-label', 'A社')
    fill('ws-business-slug', 'acme')
    fill('ws-key', 'the-key')
    fill('ws-secret', 'the-secret')
    fireEvent.click(screen.getByTestId('ws-add-btn'))
    expect(p.onAdd).toHaveBeenCalledWith({ label: 'A社', key: 'the-key', secret: 'the-secret', businessSlug: 'acme' })
  })

  it('③ KEY/SECRET は password 入力 (マスク)', () => {
    render(<FormalooWorkspacesPanel {...base({ workspaces: [] })} />)
    expect((screen.getByTestId('ws-key') as HTMLInputElement).type).toBe('password')
    expect((screen.getByTestId('ws-secret') as HTMLInputElement).type).toBe('password')
  })

  it('③ 追加押下で KEY/SECRET が即クリアされ画面に残らない', () => {
    render(<FormalooWorkspacesPanel {...base({ workspaces: [] })} />)
    fill('ws-label', 'A社')
    fill('ws-key', 'plaintext-key-xyz')
    fill('ws-secret', 'plaintext-secret-xyz')
    fireEvent.click(screen.getByTestId('ws-add-btn'))
    expect((screen.getByTestId('ws-key') as HTMLInputElement).value).toBe('')
    expect((screen.getByTestId('ws-secret') as HTMLInputElement).value).toBe('')
  })

  it('label / key / secret のいずれか空だと追加ボタンが無効', () => {
    render(<FormalooWorkspacesPanel {...base({ workspaces: [] })} />)
    expect((screen.getByTestId('ws-add-btn') as HTMLButtonElement).disabled).toBe(true)
    fill('ws-label', 'A社')
    fill('ws-key', 'k')
    expect((screen.getByTestId('ws-add-btn') as HTMLButtonElement).disabled).toBe(true) // secret 未入力
    fill('ws-secret', 's')
    expect((screen.getByTestId('ws-add-btn') as HTMLButtonElement).disabled).toBe(false)
  })

  it('addError を表示する', () => {
    render(<FormalooWorkspacesPanel {...base({ workspaces: [], addError: '接続に失敗しました' })} />)
    expect(screen.getByTestId('ws-add-error').textContent).toContain('接続に失敗しました')
  })
})

describe('FormalooWorkspacesPanel — 疎通テスト (④)', () => {
  it('疎通テストボタンで onTest(key, secret) を呼ぶ', () => {
    const p = base({ workspaces: [] })
    render(<FormalooWorkspacesPanel {...p} />)
    fill('ws-key', 'k1')
    fill('ws-secret', 's1')
    fireEvent.click(screen.getByTestId('ws-test-btn'))
    expect(p.onTest).toHaveBeenCalledWith('k1', 's1')
  })

  it('testResult=ok / ng で結果表示', () => {
    const { rerender } = render(<FormalooWorkspacesPanel {...base({ workspaces: [], testResult: 'ok' })} />)
    expect(screen.getByTestId('ws-test-ok')).toBeTruthy()
    rerender(<FormalooWorkspacesPanel {...base({ workspaces: [], testResult: 'ng' })} />)
    expect(screen.getByTestId('ws-test-ng')).toBeTruthy()
  })
})
