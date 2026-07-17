// @vitest-environment jsdom
/**
 * form-image-decoration (T-B4) — プレビュー自前描画: 差し込み画像 (幅プリセット反映) + 背景全面。
 * hosted は section description の canonical <img> / background_image で実描画 (spike S-1/S-2)。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import type { HarnessField, FormDesign } from '@line-crm/shared'
import FormPreview from './form-preview'

afterEach(() => cleanup())

const fld = (type: HarnessField['type'], config: Record<string, unknown> = {}, over: Partial<HarnessField> = {}): HarnessField =>
  ({ id: `${type}1`, type, label: type, required: false, position: 0, config: config as HarnessField['config'], ...over })

describe('T-B4 preview — 差し込み画像', () => {
  it('imageUrl を当該位置にインライン表示し、幅プリセットを max-width % で反映', () => {
    render(<FormPreview title="t" fields={[fld('image', { imageUrl: 'https://cdn.test/a.png', imageAlt: '写真', imageWidth: 'small' })]} />)
    const box = screen.getByTestId('preview-image')
    const img = box.querySelector('img') as HTMLImageElement
    expect(img.src).toContain('cdn.test/a.png')
    expect(img.alt).toBe('写真')
    expect(img.style.maxWidth).toBe('40%')
  })

  it('全幅は max-width:100%', () => {
    render(<FormPreview title="t" fields={[fld('image', { imageUrl: 'https://cdn.test/a.png', imageWidth: 'full' })]} />)
    const img = screen.getByTestId('preview-image').querySelector('img') as HTMLImageElement
    expect(img.style.maxWidth).toBe('100%')
  })

  it('upload pending (dataURL) もプレビュー表示', () => {
    render(<FormPreview title="t" fields={[fld('image', { imageWidth: 'medium', imageUpload: { intent: 'replace', dataUrl: 'data:image/png;base64,AAAA' } })]} />)
    const img = screen.getByTestId('preview-image').querySelector('img') as HTMLImageElement
    expect(img.src).toContain('data:image/png;base64,AAAA')
  })

  it('画像未設定は「画像未設定」プレースホルダ', () => {
    render(<FormPreview title="t" fields={[fld('image', { imageWidth: 'medium' })]} />)
    expect(screen.getByTestId('preview-image').textContent).toContain('画像未設定')
  })

  it('背景全面: design.backgroundImageUrl があると preview-cover が cover 全面描画', () => {
    const design: FormDesign = { backgroundImageUrl: 'https://cdn.test/bg.jpg' }
    render(<FormPreview title="t" fields={[fld('text', {}, { label: '名前' })]} design={design} />)
    const cover = screen.getByTestId('preview-cover') as HTMLElement
    expect(cover.style.backgroundImage).toContain('cdn.test/bg.jpg')
    expect(cover.style.backgroundSize).toBe('cover')
  })

  it('後方互換: image field 無しのフォームは preview-image を出さない', () => {
    render(<FormPreview title="t" fields={[fld('text', {}, { label: '名前' })]} />)
    expect(screen.queryByTestId('preview-image')).toBeNull()
  })
})
