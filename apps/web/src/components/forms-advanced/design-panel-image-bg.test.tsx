// @vitest-environment jsdom
/**
 * form-image-decoration (T-B3) — 背景画像の帯/全面 語義是正 + 全面可読性ガード (S-3 honest surface)。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { FormDesign, FormDesignImages } from '@line-crm/shared'
import DesignPanel from './design-panel'

afterEach(() => cleanup())

const setup = (design: FormDesign = {}, images: FormDesignImages = {}) => {
  render(<DesignPanel design={design} images={images} onChange={vi.fn()} onImagesChange={vi.fn()} />)
}

describe('T-B3 DesignPanel 背景画像 帯/全面', () => {
  it("カバーの語義を『背景画像（全面）』に是正 (旧『ヘッダー背景』の誤りを解消)", () => {
    setup()
    expect(screen.getByText('背景画像（全面）')).toBeTruthy()
    expect(screen.queryByText('カバー画像（ヘッダー背景）')).toBeNull()
  })

  it('全面の可読性警告 + 帯(差し込み画像先頭)への誘導を表示 (failure_observable 回避)', () => {
    setup()
    const note = screen.getByTestId('cover-readability-note')
    expect(note.textContent).toMatch(/全面/)
    expect(note.textContent).toMatch(/読みやすさ|読みにく/)
    expect(note.textContent).toMatch(/帯/)
  })
})
