// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import ImageFieldPanel from './image-field-panel'
import type { HarnessFieldConfig } from '@line-crm/shared'

afterEach(() => cleanup())

const setup = (config: HarnessFieldConfig = { imageWidth: 'medium' }) => {
  const onChange = vi.fn()
  render(<ImageFieldPanel config={config} onChange={onChange} />)
  return { onChange }
}

describe('T-B1 ImageFieldPanel (差し込み画像設定 UI)', () => {
  it('幅プリセット 小/中/全幅 を表示し medium が active・AI 生成ボタンは無い', () => {
    setup({ imageWidth: 'medium' })
    expect(screen.getByRole('button', { name: '小（40%）' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '中（70%）' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: '全幅（100%）' })).toBeTruthy()
    // excluded_scope: AI 生成ボタンを付けない
    expect(screen.queryByText(/AI|生成|自動作成/)).toBeNull()
  })

  it('全幅ボタンで imageWidth:full を onChange', () => {
    const { onChange } = setup({ imageWidth: 'medium' })
    fireEvent.click(screen.getByRole('button', { name: '全幅（100%）' }))
    expect(onChange).toHaveBeenCalledWith({ imageWidth: 'full' })
  })

  it('URL 入力で imageUrl を onChange (imageUpload はクリア)', () => {
    const { onChange } = setup()
    fireEvent.change(screen.getByLabelText('画像URL'), { target: { value: 'https://cdn.test/a.png' } })
    expect(onChange).toHaveBeenCalledWith({ imageUrl: 'https://cdn.test/a.png', imageUpload: undefined })
  })

  it('代替テキスト入力で imageAlt を onChange', () => {
    const { onChange } = setup()
    fireEvent.change(screen.getByLabelText('代替テキスト'), { target: { value: 'バナー' } })
    expect(onChange).toHaveBeenCalledWith({ imageAlt: 'バナー' })
  })

  it('10MB 超のファイルは error 表示し onChange しない', () => {
    const { onChange } = setup()
    const big = new File(['x'], 'big.png', { type: 'image/png' })
    Object.defineProperty(big, 'size', { value: 11 * 1024 * 1024 })
    fireEvent.change(screen.getByLabelText('画像ファイル'), { target: { files: [big] } })
    expect(screen.getByRole('alert').textContent).toMatch(/10MB/)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('正常ファイルは imageUpload(replace) を onChange (dataURL 化)', async () => {
    const { onChange } = setup()
    const file = new File(['abc'], 'ok.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText('画像ファイル'), { target: { files: [file] } })
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    const patch = onChange.mock.calls[0][0]
    expect(patch.imageUpload.intent).toBe('replace')
    expect(patch.imageUpload.dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(patch.imageUrl).toBeUndefined()
  })

  it('既存 imageUrl があるとプレビュー img を表示', () => {
    setup({ imageWidth: 'small', imageUrl: 'https://cdn.test/a.png', imageAlt: '写真' })
    const img = screen.getByAltText('写真') as HTMLImageElement
    expect(img.src).toContain('cdn.test/a.png')
  })
})
