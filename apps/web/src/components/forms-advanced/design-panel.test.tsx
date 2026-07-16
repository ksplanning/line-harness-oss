// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import { LINE_PRESET_PALETTES, type FormDesign, type FormDesignImages } from '@line-crm/shared'
import DesignPanel from './design-panel'

afterEach(() => cleanup())

function setup(design: FormDesign = {}, images: FormDesignImages = {}) {
  const onChange = vi.fn()
  const onImagesChange = vi.fn()
  render(<DesignPanel design={design} images={images} onChange={onChange} onImagesChange={onImagesChange} />)
  return { onChange, onImagesChange }
}

describe('DesignPanel — 配色プリセット', () => {
  it('4 案のプリセットを描画し、クリックで配色 + presetId を適用する', () => {
    const { onChange } = setup()
    expect(LINE_PRESET_PALETTES.length).toBe(4)
    for (const p of LINE_PRESET_PALETTES) expect(screen.getByTestId(`preset-${p.id}`)).toBeTruthy()

    fireEvent.click(screen.getByTestId('preset-line-green'))
    const green = LINE_PRESET_PALETTES.find((p) => p.id === 'line-green')!
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ ...green.colors, presetId: 'line-green' }))
  })
})

describe('DesignPanel — 個別カラー', () => {
  it('color picker 変更で hex(大文字) を反映し presetId を外す', () => {
    const { onChange } = setup({ themeColor: '#06C755', presetId: 'line-green' })
    fireEvent.change(screen.getByLabelText('テーマ色'), { target: { value: '#285c66' } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ themeColor: '#285C66', presetId: undefined }))
  })

  it('7 色役割すべての color input を出す', () => {
    setup()
    for (const label of ['テーマ色', '背景色', 'ボタン色', '文字色', '入力欄の色', '枠線の色', '送信ボタンの文字色']) {
      expect(screen.getByLabelText(label)).toBeTruthy()
    }
  })
})

describe('DesignPanel — 画像 (ロゴ / カバー)', () => {
  it('既存 URL をプレビュー表示し、削除で remove intent を送る', () => {
    const { onImagesChange } = setup({ logoUrl: 'https://s3/logo.png' })
    expect((screen.getByTestId('image-preview-logo') as HTMLImageElement).getAttribute('src')).toBe('https://s3/logo.png')
    fireEvent.click(screen.getByLabelText('ロゴを削除'))
    expect(onImagesChange).toHaveBeenCalledWith(expect.objectContaining({ logo: { intent: 'remove' } }))
  })

  it('ファイル選択で dataUrl replace intent を送る', async () => {
    const { onImagesChange } = setup()
    const file = new File([new Uint8Array([1, 2, 3])], 'l.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText('ロゴを選ぶ'), { target: { files: [file] } })
    await waitFor(() => expect(onImagesChange).toHaveBeenCalled())
    const arg = onImagesChange.mock.calls[0][0] as FormDesignImages
    expect(arg.logo?.intent).toBe('replace')
    expect(arg.logo?.dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(arg.logo?.mimeType).toBe('image/png')
  })

  it('許可外 mime (svg) は無視する', () => {
    const { onImagesChange } = setup()
    const file = new File([new Uint8Array([1])], 'x.svg', { type: 'image/svg+xml' })
    fireEvent.change(screen.getByLabelText('カバー画像（ヘッダー背景）を選ぶ'), { target: { files: [file] } })
    expect(onImagesChange).not.toHaveBeenCalled()
  })
})
