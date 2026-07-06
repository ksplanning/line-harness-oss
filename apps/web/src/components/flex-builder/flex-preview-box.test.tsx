// @vitest-environment jsdom
/**
 * batch C-core (box) — FlexPreview がネスト可能な box を実際にレンダーする (M-15: 表示層の配線確認)。
 *
 *  - 横並び(horizontal) box は flex-direction:row でレンダー = 2カラムが左右に並ぶ。
 *  - ネストした box (box in box) の子テキストまで描画される。
 *  - 背景色/角丸/padding 等の box 装飾が style に反映される。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import FlexPreview from '@/components/flex-preview'
import { buildModelToFlex } from '@/lib/flex-builder/to-flex'
import type { BuilderModel } from '@/lib/flex-builder/types'

afterEach(() => cleanup())

const content = (m: BuilderModel) => JSON.stringify(buildModelToFlex(m))

describe('batch C-core FlexPreview: box 描画', () => {
  it('横並び box は flex-direction:row でレンダーされ、2カラムの中身が両方出る', () => {
    const m: BuilderModel = {
      cards: [{
        id: 'c', parts: [{
          kind: 'box', id: 'row', layout: 'horizontal',
          backgroundColor: '#F5F5F5', cornerRadius: 'md', paddingAll: 'md',
          contents: [
            { kind: 'body', id: 'l', text: '左のカラム' },
            { kind: 'body', id: 'r', text: '右のカラム' },
          ],
        }],
      }],
    }
    const { container } = render(<FlexPreview content={content(m)} />)
    // 横並び box は必ず 1 つは flex-direction:row を持つ (body の縦 box とは別に)。
    const rows = Array.from(container.querySelectorAll('div')).filter(
      (d) => (d as HTMLElement).style.flexDirection === 'row',
    )
    expect(rows.length).toBeGreaterThan(0)
    expect(container.textContent).toContain('左のカラム')
    expect(container.textContent).toContain('右のカラム')
    // 背景色が反映される。
    const bg = Array.from(container.querySelectorAll('div')).some(
      (d) => (d as HTMLElement).style.backgroundColor.replace(/\s/g, '') === 'rgb(245,245,245)',
    )
    expect(bg).toBe(true)
  })

  it('ネストした box (box in box) の子テキストまで描画される', () => {
    const m: BuilderModel = {
      cards: [{
        id: 'c', parts: [{
          kind: 'box', id: 'outer', layout: 'vertical', contents: [
            { kind: 'heading', id: 'h', text: '見出し' },
            {
              kind: 'box', id: 'inner', layout: 'horizontal', contents: [
                { kind: 'body', id: 'a', text: 'ネストA' },
                { kind: 'body', id: 'b', text: 'ネストB' },
              ],
            },
          ],
        }],
      }],
    }
    const { container } = render(<FlexPreview content={content(m)} />)
    expect(container.textContent).toContain('見出し')
    expect(container.textContent).toContain('ネストA')
    expect(container.textContent).toContain('ネストB')
  })
})
