// @vitest-environment jsdom
/**
 * T-A2 (batch A / M-19) — 装飾絵文字 → inline SVG 置換の回帰固定。
 *
 * owner の Windows / 一般フォント環境で豆腐(□)化する VS16 無し text-presentation 絵文字
 * (🅰🖼🗑 等) を Flex ビルダー UI から排除したことを、実レンダリングで assert する。
 *   - 各 builder コンポーネントの描画テキストに装飾絵文字コードポイントが 1 つも残っていない
 *   - 装飾は inline <svg> で描かれている (字形フォント非依存 = 環境差の豆腐ゼロ)
 *
 * 純関数 grep ではなく render 後の DOM を検査する (表示層バグは純関数テストで検知できない教訓 / M-15)。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import PartPalette from './part-palette'
import CardTabs from './card-tabs'
import LinkPicker from './link-picker'
import FlexBuilderModal from './flex-builder-modal'
import type { BuilderModel } from '@/lib/flex-builder/types'

// LinkPicker は tracked 選択時のみ api を触る。テストは url/tel 等なので no-op で十分だが、
// 念のため api を stub して import 副作用を断つ。
vi.mock('@/lib/api', () => ({
  api: { trackedLinks: { list: vi.fn(async () => ({ success: true, data: [] })) } },
}))

afterEach(() => cleanup())

// 排除対象の装飾絵文字 (現状 builder / broadcast-form が装飾に使っていた text-presentation 絵文字)。
// 🅰U+1F170 🖼U+1F5BC 🗑U+1F5D1 は VS16 無しで owner 環境で豆腐化する確定根因 (§0-2)。
const FORBIDDEN = [
  '\u{1F170}', // 🅰 見出し
  '\u{1F4DD}', // 📝 本文
  '\u{1F5BC}', // 🖼 画像
  '\u{1F518}', // 🔘 ボタン
  '\u{2796}', // ➖ 区切り線
  '\u{2B1C}', // ⬜ 余白
  '\u{1F5D1}', // 🗑 削除
  '\u{270E}', // ✎ 編集
  '\u{1F3A8}', // 🎨 パレット
  '\u{1F310}', // 🌐 ウェブページ
  '\u{1F4CA}', // 📊 計測リンク
  '\u{1F4DE}', // 📞 電話
  '\u{1F4C5}', // 📅 予約
  '\u{2191}', // ↑ 上へ移動
  '\u{2193}', // ↓ 下へ移動
]

function assertNoForbidden(container: HTMLElement) {
  const text = container.textContent ?? ''
  for (const ch of FORBIDDEN) {
    expect(text.includes(ch)).toBe(false)
  }
}

describe('T-A2 flex builder: 装飾絵文字 → SVG', () => {
  it('部品パレットは絵文字を使わず SVG アイコンで 6 部品を描く', () => {
    const { container } = render(<PartPalette onAdd={() => {}} />)
    // パレットは折りたたみ。開いてアイコンを描画させる (fireEvent は act でラップされ state 反映)。
    fireEvent.click(container.querySelector('button')!)
    assertNoForbidden(container)
    // 6 部品ぶんの SVG アイコンが出る。
    expect(container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(6)
  })

  it('カードタブの削除ボタンは絵文字でなく SVG', () => {
    const { container } = render(
      <CardTabs
        cardCount={2}
        activeIndex={0}
        onSelect={() => {}}
        onDuplicate={() => {}}
        onMove={() => {}}
        onRemove={() => {}}
      />,
    )
    assertNoForbidden(container)
    expect(container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(1)
  })

  it('リンク選択の 4 種はアイコンが SVG', () => {
    const { container } = render(<LinkPicker value={{ type: 'url', uri: '' }} onChange={() => {}} />)
    assertNoForbidden(container)
    expect(container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(4)
  })

  it('ビルダー本体の部品リスト(アイコン/移動/削除)に装飾絵文字が残っていない', () => {
    const model: BuilderModel = {
      cards: [
        {
          id: 'c1',
          parts: [
            { kind: 'heading', id: 'h1', text: '見出しテキスト' },
            { kind: 'body', id: 'b1', text: '本文テキスト' },
            { kind: 'image', id: 'i1', url: 'https://example.com/x.png', aspect: 'landscape' },
          ],
        },
      ],
    }
    const { container } = render(
      <FlexBuilderModal initialModel={model} onSave={() => {}} onClose={() => {}} />,
    )
    assertNoForbidden(container)
    // 部品アイコン + 移動(上/下) + 削除がすべて SVG で描かれている。
    expect(container.querySelectorAll('svg').length).toBeGreaterThanOrEqual(3)
  })
})
