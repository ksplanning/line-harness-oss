// @vitest-environment jsdom
/**
 * T-A2 / T-A4 / T-A5 (H-1) — broadcast-media-inputs の imagemap: ドラッグ既定 + 数値併存 +
 * 保存済み JSON 復元 + ImageMap 3 ヘルプ配置。ドラッグと数値は同一 s.regions を共有するため、
 * 片方の変更が messageContent JSON に反映される (双方向 round-trip の土台)。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('@/components/shared/image-uploader', () => ({ default: () => null }))

import BroadcastMediaInputs from './broadcast-media-inputs'

afterEach(() => cleanup())

const imagemapJson = (
  regions: Array<{ x: number; y: number; width: number; height: number; type?: string }>,
) =>
  JSON.stringify({
    baseUrl: 'https://x/im',
    altText: 'リッチメッセージ',
    baseSize: { width: 1040, height: 1040 },
    actions: regions.map((r) => ({ type: r.type ?? 'uri', linkUri: 'https://x/lp', area: { x: r.x, y: r.y, width: r.width, height: r.height } })),
  })

describe('T-A2/T-A4/T-A5 BroadcastMediaInputs imagemap', () => {
  it('ドラッグモードが既定 (Q4)・数値モードに切替えると数値入力が併存 (T-A5)', () => {
    // ベース画像があるとドラッグキャンバスが出る (無い時は「先に画像を選ぶ」ヒント)。
    const { container } = render(<BroadcastMediaInputs messageType="imagemap" onChange={vi.fn()} initialContent={imagemapJson([])} />)
    expect(container.querySelector('[data-testid="imagemap-canvas"]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /数値/ }))
    expect(container.querySelector('[data-testid="imagemap-canvas"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /領域を追加/ }))
    expect(screen.getAllByPlaceholderText('幅').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /ドラッグ/ }))
    expect(container.querySelector('[data-testid="imagemap-canvas"]')).toBeTruthy()
  })

  it('保存済み imagemap JSON を初期表示で復元する (再編集経路 / T-A2)', () => {
    const { container } = render(
      <BroadcastMediaInputs
        messageType="imagemap"
        onChange={vi.fn()}
        initialContent={imagemapJson([
          { x: 0, y: 0, width: 520, height: 520 },
          { x: 520, y: 0, width: 520, height: 520 },
        ])}
      />,
    )
    expect(container.querySelectorAll('[data-testid^="region-"]')).toHaveLength(2)
  })

  it('数値モードでの x 変更が messageContent JSON に反映される (数値⇄ドラッグ 同一 state)', () => {
    const onChange = vi.fn()
    render(
      <BroadcastMediaInputs
        messageType="imagemap"
        onChange={onChange}
        initialContent={imagemapJson([{ x: 0, y: 0, width: 300, height: 300 }])}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /数値/ }))
    fireEvent.change(screen.getByPlaceholderText('x'), { target: { value: '200' } })
    const lastJson = onChange.mock.calls[onChange.mock.calls.length - 1][0] as string
    expect(JSON.parse(lastJson).actions[0].area.x).toBe(200)
  })

  it('ImageMap の 3 ヘルプが配置され、押すと ImageMap ガイド画像が開く (T-A4)', () => {
    render(<BroadcastMediaInputs messageType="imagemap" onChange={vi.fn()} />)
    const helps = screen.getAllByRole('button', { name: /ヘルプ/ })
    expect(helps.length).toBeGreaterThanOrEqual(3)
    fireEvent.click(helps[0])
    const img = screen.getByRole('dialog').querySelector('img') as HTMLImageElement
    expect(img.getAttribute('src')).toMatch(/\/help\/imagemap-/)
  })
})
