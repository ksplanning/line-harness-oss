// @vitest-environment jsdom
/**
 * PermissionMatrix (G64 R-2 / T-B1) — 19 トグル render / トグル操作で onChange / staff_admin 警告 /
 * featuresToRecord がテンプレ features を 19 の Record に正規化する (T-B2 の素材)。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { FEATURE_KEYS, FEATURE_LABELS } from '@line-crm/shared'
import { PermissionMatrix, featuresToRecord } from './permission-matrix'

afterEach(() => cleanup())

describe('PermissionMatrix', () => {
  it('19 機能の行 (switch) を描画する', () => {
    render(<PermissionMatrix value={{}} onChange={() => {}} />)
    const switches = screen.getAllByRole('switch')
    expect(switches.length).toBe(FEATURE_KEYS.length)
    expect(FEATURE_KEYS.length).toBe(19)
    // 代表ラベルが出ている
    expect(screen.getByText(FEATURE_LABELS.chat)).toBeTruthy()
    expect(screen.getByText(FEATURE_LABELS.staff_admin)).toBeTruthy()
  })

  it('トグルクリックで onChange(feature, !current) を呼ぶ', () => {
    const onChange = vi.fn()
    render(<PermissionMatrix value={{ chat: false }} onChange={onChange} />)
    const chatSwitch = screen.getByRole('switch', { name: FEATURE_LABELS.chat })
    expect(chatSwitch.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(chatSwitch)
    expect(onChange).toHaveBeenCalledWith('chat', true)
  })

  it('ON の値は aria-checked=true になる', () => {
    render(<PermissionMatrix value={{ broadcast: true }} onChange={() => {}} />)
    const s = screen.getByRole('switch', { name: FEATURE_LABELS.broadcast })
    expect(s.getAttribute('aria-checked')).toBe('true')
  })

  it('staff_admin を ON にすると警告文を表示する (self-lockout 予防)', () => {
    const { rerender } = render(<PermissionMatrix value={{ staff_admin: false }} onChange={() => {}} />)
    expect(screen.queryByText(/他のスタッフや権限を変更できる/)).toBeNull()
    rerender(<PermissionMatrix value={{ staff_admin: true }} onChange={() => {}} />)
    expect(screen.getByText(/他のスタッフや権限を変更できる/)).toBeTruthy()
  })

  it('disabled のときトグルは無効化される', () => {
    render(<PermissionMatrix value={{}} onChange={() => {}} disabled />)
    const s = screen.getAllByRole('switch')[0] as HTMLButtonElement
    expect(s.disabled).toBe(true)
  })
})

describe('featuresToRecord (T-B2 テンプレ適用の素材)', () => {
  it('テンプレ features を 19 feature の Record に正規化する (含=true / 未含=false)', () => {
    const rec = featuresToRecord(['chat', 'friend'])
    expect(Object.keys(rec).length).toBe(19)
    expect(rec.chat).toBe(true)
    expect(rec.friend).toBe(true)
    expect(rec.broadcast).toBe(false)
    expect(rec.staff_admin).toBe(false)
  })
})
