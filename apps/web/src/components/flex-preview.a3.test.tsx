// @vitest-environment jsdom
/**
 * T-A3 (batch A) — プレビュー忠実度。
 *
 *  - bubble に明示フォントスタック(CJK + emoji フォールバック)を付与し、
 *    owner 環境でも本文/絵文字が字形フォント依存で豆腐化しない。
 *  - bubble.size(kilo/mega/giga)で幅が変わる(既存挙動の回帰固定)。
 *  - 既存の text/button/carousel 描画に回帰が無い。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import FlexPreview from './flex-preview'

afterEach(() => cleanup())

const bubble = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'bubble',
    ...extra,
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        { type: 'text', text: 'こんにちは😀 春の新色ネイル', weight: 'bold' },
        { type: 'button', style: 'primary', action: { type: 'uri', label: '予約する', uri: 'https://x' } },
      ],
    },
  })

describe('T-A3 flex-preview: 忠実度 + フォント', () => {
  it('bubble に CJK + emoji フォールバックの明示フォントスタックが付く', () => {
    const { container } = render(<FlexPreview content={bubble()} />)
    const card = container.querySelector('div') as HTMLElement
    const ff = card.style.fontFamily
    // CJK フォントと emoji フォールバックの両方が明示されている(body 継承任せにしない)。
    expect(ff).toMatch(/Hiragino|Noto Sans JP|Yu Gothic/)
    expect(ff).toMatch(/Emoji/)
  })

  it('本文と絵文字・ボタン文言が描画される(既存描画の回帰なし)', () => {
    const { container } = render(<FlexPreview content={bubble()} />)
    expect(container.textContent).toContain('こんにちは😀 春の新色ネイル')
    expect(container.textContent).toContain('予約する')
  })

  it('bubble.size で幅が変わる(giga > kilo)', () => {
    const giga = render(<FlexPreview content={bubble({ size: 'giga' })} />)
    const kilo = render(<FlexPreview content={bubble({ size: 'kilo' })} />)
    const wOf = (c: HTMLElement) => parseInt((c.querySelector('div') as HTMLElement).style.width, 10)
    expect(wOf(giga.container)).toBeGreaterThan(wOf(kilo.container))
  })
})
