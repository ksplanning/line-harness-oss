// @vitest-environment jsdom
/**
 * form-route-branching (T-D2) — DesignPanel の表示形式スイッチ + 逆ガード警告。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import DesignPanel from './design-panel'

afterEach(() => cleanup())

describe('T-D2 — DesignPanel 表示形式スイッチ', () => {
  it('onFormTypeChange 接続時にスイッチを描画し、クリックで multi_step/simple を切替える', () => {
    const onFormTypeChange = vi.fn()
    render(<DesignPanel design={{}} images={{}} onChange={vi.fn()} onImagesChange={vi.fn()} formType="simple" onFormTypeChange={onFormTypeChange} />)
    expect(screen.getByTestId('formtype-switch')).toBeTruthy()
    fireEvent.click(screen.getByTestId('formtype-multi_step'))
    expect(onFormTypeChange).toHaveBeenCalledWith('multi_step')
    fireEvent.click(screen.getByTestId('formtype-simple'))
    expect(onFormTypeChange).toHaveBeenCalledWith('simple')
  })

  it('現在の formType が aria-pressed で示される (multi_step)', () => {
    render(<DesignPanel design={{}} images={{}} onChange={vi.fn()} onImagesChange={vi.fn()} formType="multi_step" onFormTypeChange={vi.fn()} />)
    expect((screen.getByTestId('formtype-multi_step') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByTestId('formtype-simple') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('false')
  })

  it('onFormTypeChange 未接続なら スイッチ非表示 (後方互換)', () => {
    render(<DesignPanel design={{}} images={{}} onChange={vi.fn()} onImagesChange={vi.fn()} />)
    expect(screen.queryByTestId('formtype-switch')).toBeNull()
  })

  it('逆ガード: jump rule 存在 ∧ simple → 警告を出す (許可はする)', () => {
    render(<DesignPanel design={{}} images={{}} onChange={vi.fn()} onImagesChange={vi.fn()} formType="simple" onFormTypeChange={vi.fn()} hasJumpRule />)
    expect(screen.getByTestId('formtype-reverse-guard')).toBeTruthy()
    expect(screen.getByTestId('formtype-reverse-guard').textContent).toMatch(/1画面表示|動作しません/)
  })

  it('逆ガード: jump rule 存在 ∧ multi_step → 警告なし', () => {
    render(<DesignPanel design={{}} images={{}} onChange={vi.fn()} onImagesChange={vi.fn()} formType="multi_step" onFormTypeChange={vi.fn()} hasJumpRule />)
    expect(screen.queryByTestId('formtype-reverse-guard')).toBeNull()
  })

  it('逆ガード: jump rule 無し ∧ simple → 警告なし', () => {
    render(<DesignPanel design={{}} images={{}} onChange={vi.fn()} onImagesChange={vi.fn()} formType="simple" onFormTypeChange={vi.fn()} />)
    expect(screen.queryByTestId('formtype-reverse-guard')).toBeNull()
  })
})
