// @vitest-environment jsdom
/**
 * batch C-core (hero/header/footer) — FlexPreview が bubble ブロックを実際にレンダーする (M-15)。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import FlexPreview from '@/components/flex-preview'
import { buildModelToFlex } from '@/lib/flex-builder/to-flex'
import type { BuilderModel } from '@/lib/flex-builder/types'

afterEach(() => cleanup())

describe('batch C-core FlexPreview: hero/header/footer 描画', () => {
  it('hero 画像・header・body・footer の中身がすべて描画される', () => {
    const m: BuilderModel = {
      cards: [{
        id: 'c',
        hero: { kind: 'image', id: 'hero', url: 'https://x/hero.jpg', aspect: 'landscape', rounded: false },
        header: [{ kind: 'heading', id: 'hh', text: 'ヘッダー文言' }],
        parts: [{ kind: 'body', id: 'b', text: '本文の文言' }],
        footer: [{ kind: 'button', id: 'ft', label: '予約するボタン', style: 'primary', link: { type: 'url', uri: 'https://x/b' } }],
      }],
    }
    const { container } = render(<FlexPreview content={JSON.stringify(buildModelToFlex(m))} />)
    expect(container.textContent).toContain('ヘッダー文言')
    expect(container.textContent).toContain('本文の文言')
    expect(container.textContent).toContain('予約するボタン')
    // hero 画像 (img か placeholder div) が描画されている。
    expect(container.querySelector('img')).not.toBeNull()
  })
})
