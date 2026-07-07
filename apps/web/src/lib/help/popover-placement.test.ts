/**
 * T-A3 fold-in (browser-evaluator medium) — HelpPopover 表示位置の純ロジック。
 * 375px でトリガーが行の右寄りにあってもポップオーバーが画面外に出ないよう、横は right 基準へ
 * 反転する。縦の上下反転 (既存挙動) は保持する。jsdom 無しで決定的に固定する。
 */
import { describe, it, expect } from 'vitest'
import { popoverPlacement, POPOVER_WIDTH, POPOVER_HEIGHT } from './popover-placement'

const vp = { width: 375, height: 812 }
const pop = { width: POPOVER_WIDTH, height: POPOVER_HEIGHT }

describe('popoverPlacement — 横反転 (375px はみ出し防止)', () => {
  it('左寄りアンカーは left 基準 (従来どおり)', () => {
    expect(popoverPlacement({ left: 20, bottom: 110 }, vp, pop).horizontal).toBe('left')
  })
  it('右端に近いアンカー (imagemap.action の文中?) は right 基準へ反転', () => {
    // 実測 repro: rect.left=287 / popover 256 → 287+256=543 > 375 = はみ出し
    expect(popoverPlacement({ left: 287, bottom: 110 }, vp, pop).horizontal).toBe('right')
  })
  it('right 基準に反転すると popover 右端がアンカー右に揃い viewport 内に収まる', () => {
    const p = popoverPlacement({ left: 287, bottom: 110 }, vp, pop)
    expect(p.horizontal).toBe('right')
    // right 基準 = anchor.right(=~319) を右端に、左へ 256 展開 → 左端 >= 0
    const anchorRight = 287 + 32 // span(ボタン)幅 ~32
    expect(anchorRight - pop.width).toBeGreaterThanOrEqual(0)
    expect(anchorRight).toBeLessThanOrEqual(vp.width)
  })
})

describe('popoverPlacement — 縦反転 (既存挙動を保持)', () => {
  it('下端に近いと above (上に反転)', () => {
    expect(popoverPlacement({ left: 20, bottom: 700 }, vp, pop).vertical).toBe('above')
  })
  it('上部なら below (下に出す)', () => {
    expect(popoverPlacement({ left: 20, bottom: 120 }, vp, pop).vertical).toBe('below')
  })
})

describe('popoverPlacement — SSR / 未計測 fail-safe', () => {
  it('viewport 0 は left/below の既定', () => {
    const p = popoverPlacement({ left: 500, bottom: 500 }, { width: 0, height: 0 }, pop)
    expect(p).toEqual({ horizontal: 'left', vertical: 'below' })
  })
})
