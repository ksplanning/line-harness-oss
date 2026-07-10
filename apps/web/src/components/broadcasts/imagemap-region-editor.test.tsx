// @vitest-environment jsdom
/**
 * T-A1 (H-1) — ドラッグ式 ImageMap 領域エディタ (G65)。
 * ベース画像上でドラッグして矩形を描き / 選択 / 移動 / リサイズ / 削除でき、出力は
 * broadcast-media の MediaRegion 配列 (数値入力と同型)。50 area 上限・範囲外 clamp を固定する。
 *
 * jsdom は getBoundingClientRect が 0 を返すため、canvas 要素の rect を 1040x1040 (scale=1)
 * にモックし、client 座標 = 画像座標 として決定的にドラッグを検証する。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import ImagemapRegionEditor from './imagemap-region-editor'
import type { MediaRegion } from '@/lib/broadcast-media'

afterEach(() => cleanup())

const R = (o: Partial<MediaRegion>): MediaRegion => ({ x: '0', y: '0', width: '100', height: '100', actionType: 'uri', value: '', ...o })

function mockCanvasRect(container: HTMLElement, size = 1040) {
  const canvas = container.querySelector('[data-testid="imagemap-canvas"]') as HTMLElement
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: size, bottom: size, width: size, height: size, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  return canvas
}

function lastCall(onChange: ReturnType<typeof vi.fn>): MediaRegion[] {
  return onChange.mock.calls[onChange.mock.calls.length - 1][0] as MediaRegion[]
}

describe('T-A1 ImagemapRegionEditor', () => {
  it('空白をドラッグすると新しい矩形が MediaRegion として emit される', () => {
    const onChange = vi.fn()
    const { container } = render(
      <ImagemapRegionEditor imageUrl="https://x/im" baseW={1040} baseH={1040} regions={[]} onChange={onChange} />,
    )
    const canvas = mockCanvasRect(container)
    fireEvent.mouseDown(canvas, { clientX: 100, clientY: 100 })
    fireEvent.mouseMove(window, { clientX: 300, clientY: 400 })
    fireEvent.mouseUp(window, { clientX: 300, clientY: 400 })
    expect(onChange).toHaveBeenCalled()
    const regions = lastCall(onChange)
    expect(regions).toHaveLength(1)
    expect(regions[0]).toMatchObject({ x: '100', y: '100', width: '200', height: '300', actionType: 'uri' })
  })

  it('端の外へドラッグして描いた矩形は画像境界内に収まる (onUp clamp / G65 backlog)', () => {
    const onChange = vi.fn()
    const { container } = render(
      <ImagemapRegionEditor imageUrl="https://x/im" baseW={1040} baseH={1040} regions={[]} onChange={onChange} />,
    )
    const canvas = mockCanvasRect(container)
    // 右下 (900,900) から画像外 (2000,2000) までドラッグ → 座標が境界を越えない (端に収まる)。
    fireEvent.mouseDown(canvas, { clientX: 900, clientY: 900 })
    fireEvent.mouseMove(window, { clientX: 2000, clientY: 2000 })
    fireEvent.mouseUp(window, { clientX: 2000, clientY: 2000 })
    const r = lastCall(onChange)[0]
    expect(Number(r.x)).toBeGreaterThanOrEqual(0)
    expect(Number(r.y)).toBeGreaterThanOrEqual(0)
    expect(Number(r.x) + Number(r.width)).toBeLessThanOrEqual(1040)
    expect(Number(r.y) + Number(r.height)).toBeLessThanOrEqual(1040)
    // 始点 (900) は保たれ、端 (1040) までの帯として収まる (全幅化しない)。
    expect(Number(r.x)).toBe(900)
    expect(Number(r.width)).toBe(140)
  })

  it('既存 regions を矩形として描画する (数値入力と同じ配列を受け取る)', () => {
    const { container } = render(
      <ImagemapRegionEditor imageUrl="https://x/im" baseW={1040} baseH={1040}
        regions={[R({ x: '0', y: '0', width: '520', height: '520' }), R({ x: '520', y: '0', width: '520', height: '520' })]}
        onChange={vi.fn()} />,
    )
    expect(container.querySelectorAll('[data-testid^="region-"]')).toHaveLength(2)
  })

  it('矩形を選ぶと飛び先パネルが出て、種類/値の変更が emit される', () => {
    const onChange = vi.fn()
    const { container, getByLabelText } = render(
      <ImagemapRegionEditor imageUrl="https://x/im" baseW={1040} baseH={1040}
        regions={[R({ x: '0', y: '0', width: '300', height: '300' })]} onChange={onChange} />,
    )
    const canvas = mockCanvasRect(container)
    const region = container.querySelector('[data-testid="region-0"]') as HTMLElement
    fireEvent.mouseDown(region, { clientX: 50, clientY: 50 })
    fireEvent.mouseUp(window, { clientX: 50, clientY: 50 }) // 動かさず選択のみ
    const valueInput = getByLabelText('飛び先や送る言葉') as HTMLInputElement
    fireEvent.change(valueInput, { target: { value: 'https://x/lp' } })
    expect(lastCall(onChange)[0].value).toBe('https://x/lp')
  })

  it('選んだ矩形をドラッグで移動でき、範囲外には出ない (clamp)', () => {
    const onChange = vi.fn()
    const { container } = render(
      <ImagemapRegionEditor imageUrl="https://x/im" baseW={1040} baseH={1040}
        regions={[R({ x: '100', y: '100', width: '200', height: '200' })]} onChange={onChange} />,
    )
    const canvas = mockCanvasRect(container)
    const region = container.querySelector('[data-testid="region-0"]') as HTMLElement
    // (150,150) を掴んで大きく右下 (2000,2000) へ → base(1040) 外に出ようとしても clamp。
    fireEvent.mouseDown(region, { clientX: 150, clientY: 150 })
    fireEvent.mouseMove(window, { clientX: 2000, clientY: 2000 })
    fireEvent.mouseUp(window, { clientX: 2000, clientY: 2000 })
    const r = lastCall(onChange)[0]
    expect(Number(r.x) + Number(r.width)).toBeLessThanOrEqual(1040)
    expect(Number(r.y) + Number(r.height)).toBeLessThanOrEqual(1040)
    expect(Number(r.width)).toBe(200) // 幅は保たれ、位置だけ収まる
  })

  it('選んだ矩形を se ハンドルでリサイズできる', () => {
    const onChange = vi.fn()
    const { container } = render(
      <ImagemapRegionEditor imageUrl="https://x/im" baseW={1040} baseH={1040}
        regions={[R({ x: '0', y: '0', width: '100', height: '100' })]} onChange={onChange} />,
    )
    const canvas = mockCanvasRect(container)
    const region = container.querySelector('[data-testid="region-0"]') as HTMLElement
    fireEvent.mouseDown(region, { clientX: 10, clientY: 10 })
    fireEvent.mouseUp(window, { clientX: 10, clientY: 10 }) // 選択のみ
    const handle = container.querySelector('[data-testid="handle-0-se"]') as HTMLElement
    fireEvent.mouseDown(handle, { clientX: 100, clientY: 100 })
    fireEvent.mouseMove(window, { clientX: 250, clientY: 200 })
    fireEvent.mouseUp(window, { clientX: 250, clientY: 200 })
    const r = lastCall(onChange)[0]
    expect(Number(r.width)).toBe(250)
    expect(Number(r.height)).toBe(200)
  })

  it('削除ボタンで矩形を除去する', () => {
    const onChange = vi.fn()
    const { container, getByRole } = render(
      <ImagemapRegionEditor imageUrl="https://x/im" baseW={1040} baseH={1040}
        regions={[R({ x: '0', y: '0', width: '300', height: '300' })]} onChange={onChange} />,
    )
    const canvas = mockCanvasRect(container)
    const region = container.querySelector('[data-testid="region-0"]') as HTMLElement
    fireEvent.mouseDown(region, { clientX: 20, clientY: 20 })
    fireEvent.mouseUp(window, { clientX: 20, clientY: 20 })
    fireEvent.click(getByRole('button', { name: 'この領域を削除' }))
    expect(lastCall(onChange)).toHaveLength(0)
  })

  it('50 個を超える領域は作れない (LINE 上限)', () => {
    const onChange = vi.fn()
    const full = Array.from({ length: 50 }, (_, i) => R({ x: String(i), y: '0', width: '20', height: '20' }))
    const { container, getByText } = render(
      <ImagemapRegionEditor imageUrl="https://x/im" baseW={1040} baseH={1040} regions={full} onChange={onChange} />,
    )
    const canvas = mockCanvasRect(container)
    fireEvent.mouseDown(canvas, { clientX: 500, clientY: 500 })
    fireEvent.mouseMove(window, { clientX: 700, clientY: 700 })
    fireEvent.mouseUp(window, { clientX: 700, clientY: 700 })
    // 追加 (51 個目) は emit されない
    const added = onChange.mock.calls.find((c) => (c[0] as MediaRegion[]).length > 50)
    expect(added).toBeUndefined()
    expect(getByText(/最大 50/)).toBeTruthy()
  })
})
