// @vitest-environment jsdom
/**
 * batch B (component) — PartEditor の装飾コントロールが正しい patch を onChange するか (M-15 実レンダー)。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react'
import PartEditor from './part-editor'
import type { BuilderPart } from '@/lib/flex-builder/types'

/** ラベル名のトグル群 (label の親 div) の中で、指定ボタンを押す (同名ボタンの他群との衝突を回避)。 */
function clickInGroup(groupLabel: string, buttonName: string) {
  const group = screen.getByText(groupLabel).parentElement as HTMLElement
  fireEvent.click(within(group).getByRole('button', { name: buttonName }))
}

vi.mock('@/lib/api', () => ({
  api: { trackedLinks: { list: vi.fn(async () => ({ success: true, data: [] })) } },
}))
vi.mock('@/components/shared/image-uploader', () => ({ default: () => null }))

afterEach(() => cleanup())

describe('batch B PartEditor: text 装飾', () => {
  const body: BuilderPart = { kind: 'body', id: 'b', text: 'x' }

  it('変数が解決される利用画面では変数ボタンも表示する', () => {
    render(<PartEditor part={body} onChange={() => {}} textEditorMode="variables-and-emoji" />)

    expect(screen.getByRole('button', { name: '変数を挿入' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '絵文字' })).toBeTruthy()
  })

  it('色の緑スウォッチで color patch', () => {
    const onChange = vi.fn()
    render(<PartEditor part={body} onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('緑'))
    expect(onChange).toHaveBeenCalledWith({ color: '#06C755' })
  })

  it('位置=中央 で align patch, もう一度既定に戻すと undefined', () => {
    const onChange = vi.fn()
    render(<PartEditor part={body} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: '中央' }))
    expect(onChange).toHaveBeenCalledWith({ align: 'center' })
    // fallback (start) を押すと undefined (=既定に戻す)。
    fireEvent.click(screen.getByRole('button', { name: '左' }))
    expect(onChange).toHaveBeenCalledWith({ align: undefined })
  })

  it('下線で decoration patch', () => {
    const onChange = vi.fn()
    render(<PartEditor part={body} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: '下線' }))
    expect(onChange).toHaveBeenCalledWith({ decoration: 'underline' })
  })

  it('上の余白=中 で margin patch (全部品共通)', () => {
    const onChange = vi.fn()
    render(<PartEditor part={body} onChange={onChange} />)
    clickInGroup('上の余白', '中')
    expect(onChange).toHaveBeenCalledWith({ margin: 'md' })
  })
})

describe('batch B PartEditor: image / button', () => {
  it('画像の大きさ=小 で size patch', () => {
    const img: BuilderPart = { kind: 'image', id: 'i', url: 'https://x/a.png' }
    const onChange = vi.fn()
    render(<PartEditor part={img} onChange={onChange} />)
    clickInGroup('画像の大きさ', '小')
    expect(onChange).toHaveBeenCalledWith({ size: 'sm' })
  })

  it('ボタン: メッセージを送る を選ぶと message link に切替 + 高さ patch', () => {
    const btn: BuilderPart = { kind: 'button', id: 'b', label: 'x', style: 'primary', link: { type: 'url', uri: '' } }
    const onChange = vi.fn()
    render(<PartEditor part={btn} onChange={onChange} />)
    fireEvent.click(screen.getByRole('button', { name: 'メッセージを送る' }))
    expect(onChange).toHaveBeenCalledWith({ link: { type: 'message', text: '' } })
    fireEvent.click(screen.getByRole('button', { name: '低い' }))
    expect(onChange).toHaveBeenCalledWith({ height: 'sm' })
  })
})
