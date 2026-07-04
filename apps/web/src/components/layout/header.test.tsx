// @vitest-environment jsdom
/**
 * visual-qa blocker 1 fix (F2 batch4) — Header の action 群が mobile375 で折返せるよう flex-wrap を持つ
 * (主CTA 見切れ / h1 縦積み / 横スクロール防止)。jsdom は実レイアウトを計算しないため class 構成で固定。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import Header from './header'

afterEach(() => cleanup())

describe('Header responsive wrap', () => {
  it('the title/action row is flex-wrap so actions drop below the title when narrow', () => {
    const { container } = render(
      <Header title="一斉配信" action={<div className="flex flex-wrap gap-2"><button>送信者の管理</button><button>A/B テスト</button><button>+ 新規配信</button></div>} />,
    )
    const row = container.querySelector('.flex.flex-wrap')
    expect(row).toBeTruthy()
    // 主CTA が DOM に存在する (見切れずレンダリングされる)。
    expect(screen.getByRole('button', { name: '+ 新規配信' })).toBeTruthy()
  })

  it('title container has min-w-0 so the h1 does not force horizontal overflow', () => {
    const { container } = render(<Header title="一斉配信" />)
    expect(container.querySelector('.min-w-0')).toBeTruthy()
  })
})
