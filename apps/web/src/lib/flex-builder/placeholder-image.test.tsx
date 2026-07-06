// @vitest-environment jsdom
/**
 * Bug1 回帰固定 (batch A) — 見本テンプレの画像プレースホルダに外部依存も豆腐も無いこと。
 *
 *   - NAIL_TEMPLATES / GALLERY_TEMPLATES の image url に placehold.co (外部・CJK 非対応) が残っていない
 *   - プレースホルダは sentinel https URL = validateFlex を通る (image_not_https にならない)
 *   - FlexPreview は sentinel を外部 <img> で取りに行かず、ローカルのラベル付きプレースホルダで描く
 *     (CJK ラベルはブラウザのローカルフォントで描画 = 豆腐が構造的に不可能・外部依存ゼロ)
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { NAIL_TEMPLATES, GALLERY_TEMPLATES } from './templates'
import { buildModelToFlex } from './to-flex'
import { validateFlex } from './validate'
import { placeholderImageUrl, isPlaceholderImageUrl, parsePlaceholderImageUrl } from './placeholder-image'
import FlexPreview from '@/components/flex-preview'

afterEach(() => cleanup())

const allTemplates = [...NAIL_TEMPLATES, ...GALLERY_TEMPLATES]

function imageUrlsOf(): string[] {
  const urls: string[] = []
  for (const t of allTemplates) {
    for (const card of t.model.cards) {
      for (const p of card.parts) {
        if (p.kind === 'image' && p.url) urls.push(p.url)
      }
    }
  }
  return urls
}

describe('Bug1 プレースホルダ画像', () => {
  it('どのテンプレ画像 url にも placehold.co が残っていない', () => {
    for (const url of imageUrlsOf()) {
      expect(url).not.toContain('placehold.co')
    }
  })

  it('全テンプレ画像 url は sentinel プレースホルダ (ローカル描画対象) かつ https', () => {
    const urls = imageUrlsOf()
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) {
      expect(url.startsWith('https://')).toBe(true)
      expect(isPlaceholderImageUrl(url)).toBe(true)
    }
  })

  it('sentinel url は validateFlex を通る (image_not_https を出さない)', () => {
    for (const t of allTemplates) {
      const r = validateFlex(buildModelToFlex(t.model))
      if (!r.ok) throw new Error(`${t.key}: ${JSON.stringify(r.errors)}`)
      expect(r.ok).toBe(true)
    }
  })

  it('parse は label/bg/fg を返し、非 sentinel は null', () => {
    const ph = parsePlaceholderImageUrl(placeholderImageUrl({ label: 'テスト画像', bg: '06C755', fg: 'FFFFFF' }))
    expect(ph).toMatchObject({ label: 'テスト画像', bg: '#06C755', fg: '#FFFFFF' })
    expect(parsePlaceholderImageUrl('https://example.com/real.png')).toBeNull()
  })

  it('FlexPreview は sentinel を外部 <img> で取りに行かず、ローカルのラベル付きプレースホルダで描く', () => {
    const bubble = JSON.stringify({
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical',
        contents: [{ type: 'image', url: placeholderImageUrl({ label: 'サロンの写真' }) }],
      },
    })
    const { container } = render(<FlexPreview content={bubble} />)
    // 外部画像を取りに行く <img src="https://placeholder..."> は描かれない。
    const imgs = Array.from(container.querySelectorAll('img'))
    expect(imgs.some((i) => (i.getAttribute('src') ?? '').includes('placeholder.line-harness.local'))).toBe(false)
    // ラベルと「見本」注記がローカルで描かれる (CJK はブラウザフォント描画 = 豆腐にならない)。
    expect(container.textContent).toContain('サロンの写真')
    expect(container.textContent).toContain('見本')
  })
})
