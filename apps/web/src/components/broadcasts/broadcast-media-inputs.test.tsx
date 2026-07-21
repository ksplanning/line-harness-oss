// @vitest-environment jsdom
/**
 * T-A2 / T-A4 / T-A5 (H-1) — broadcast-media-inputs の imagemap: ドラッグ既定 + 数値併存 +
 * 保存済み JSON 復元 + ImageMap 3 ヘルプ配置。ドラッグと数値は同一 s.regions を共有するため、
 * 片方の変更が messageContent JSON に反映される (双方向 round-trip の土台)。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'

const { videoUploadMock, audioUploadMock, imagemapUploadMock, imagemapVariantsMock } = vi.hoisted(() => ({
  videoUploadMock: vi.fn(),
  audioUploadMock: vi.fn(),
  imagemapUploadMock: vi.fn(),
  imagemapVariantsMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: { uploads: { video: videoUploadMock, audio: audioUploadMock, imagemap: imagemapUploadMock } },
}))

vi.mock('@/lib/line-image-transform', () => ({
  createImagemapVariants: imagemapVariantsMock,
}))

vi.mock('@/components/shared/image-uploader', () => ({ default: () => null }))

import BroadcastMediaInputs from './broadcast-media-inputs'

afterEach(() => cleanup())

beforeEach(() => {
  videoUploadMock.mockReset()
  audioUploadMock.mockReset()
  imagemapUploadMock.mockReset()
  imagemapVariantsMock.mockReset()
  videoUploadMock.mockResolvedValue({ success: true, data: { url: 'https://worker.test/media/video.mp4' } })
  audioUploadMock.mockResolvedValue({ success: true, data: { url: 'https://worker.test/media/audio.m4a' } })
  imagemapVariantsMock.mockResolvedValue([240, 300, 460, 700, 1040].map((width) => ({
    width,
    height: width / 2,
    blob: new Blob([String(width)], { type: 'image/jpeg' }),
  })))
  imagemapUploadMock.mockResolvedValue({
    success: true,
    data: { baseUrl: 'https://worker.test/images/imagemaps/shared-id' },
  })
})

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

  it('保存済み公式JSONを開いただけでは再直列化せず、未編集フィールドを壊さない', () => {
    const onChange = vi.fn()
    const content = JSON.stringify({
      baseUrl: 'https://x/im',
      altText: '既存の代替文',
      baseSize: { width: 1040, height: 1040 },
      actions: [{ type: 'clipboard', clipboardText: '保持する', area: { x: 0, y: 0, width: 1040, height: 1040 } }],
    })
    render(<BroadcastMediaInputs messageType="imagemap" onChange={onChange} initialContent={content} />)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('保存済み imagemap の領域を編集しても clipboard・label・video・altText を保持する', () => {
    const onChange = vi.fn()
    const video = {
      originalContentUrl: 'https://x/video.mp4',
      previewImageUrl: 'https://x/preview.jpg',
      area: { x: 0, y: 0, width: 1040, height: 1040 },
    }
    const content = JSON.stringify({
      baseUrl: 'https://x/im',
      altText: '既存の代替文',
      baseSize: { width: 1040, height: 1040 },
      actions: [
        { type: 'clipboard', label: 'コピー', clipboardText: '保持する', area: { x: 0, y: 0, width: 520, height: 520 } },
        { type: 'uri', label: '開く', linkUri: 'https://x/lp', area: { x: 520, y: 0, width: 520, height: 520 } },
      ],
      video,
    })
    render(<BroadcastMediaInputs messageType="imagemap" onChange={onChange} initialContent={content} />)

    fireEvent.click(screen.getByRole('button', { name: /数値/ }))
    fireEvent.change(screen.getAllByPlaceholderText('x')[0], { target: { value: '10' } })

    const payload = JSON.parse(onChange.mock.calls.at(-1)?.[0] as string)
    expect(payload.altText).toBe('既存の代替文')
    expect(payload.video).toEqual(video)
    expect(payload.actions[0]).toMatchObject({ type: 'clipboard', label: 'コピー', clipboardText: '保持する' })
    expect(payload.actions[0].area.x).toBe(10)
    expect(payload.actions[1]).toMatchObject({ type: 'uri', label: '開く', linkUri: 'https://x/lp' })
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

  it('JPEG/PNG・10MB上限・横幅1040pxをアップロード欄に明記する', () => {
    const { container } = render(<BroadcastMediaInputs messageType="imagemap" onChange={vi.fn()} />)
    const copy = container.textContent ?? ''
    expect(copy).toMatch(/10\s*MB/i)
    expect(copy).toMatch(/JPEG/i)
    expect(copy).toMatch(/PNG/i)
    expect(copy).toMatch(/(?:横)?幅\s*1040\s*px/i)
  })

  it('imagemapの横幅は1040固定で、変更操作でも保存JSONを999pxにしない', () => {
    const onChange = vi.fn()
    render(
      <BroadcastMediaInputs
        messageType="imagemap"
        onChange={onChange}
        initialContent={imagemapJson([{ x: 0, y: 0, width: 520, height: 520 }])}
      />,
    )
    const width = screen.getAllByRole('spinbutton')[0] as HTMLInputElement
    expect(width.value).toBe('1040')
    fireEvent.change(width, { target: { value: '999' } })
    fireEvent.change(screen.getAllByRole('spinbutton')[1], { target: { value: '1039' } })
    const lastJson = onChange.mock.calls.at(-1)?.[0] as string
    expect(JSON.parse(lastJson).baseSize.width).toBe(1040)
  })

  it('imagemap と richvideo の入力欄に公式文字数上限を設定する', () => {
    const imagemap = render(
      <BroadcastMediaInputs
        messageType="imagemap"
        onChange={vi.fn()}
        initialContent={imagemapJson([{ x: 0, y: 0, width: 520, height: 520 }])}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /数値/ }))
    expect((screen.getByPlaceholderText(/飛び先/) as HTMLInputElement).maxLength).toBe(1000)
    imagemap.unmount()

    const richvideo = render(<BroadcastMediaInputs messageType="richvideo" onChange={vi.fn()} />)
    expect((screen.getByLabelText('再生後に出すボタンの文字') as HTMLInputElement).maxLength).toBe(30)
    expect((screen.getByPlaceholderText('ボタンの飛び先 (https://...)') as HTMLInputElement).maxLength).toBe(1000)
    richvideo.unmount()
  })

  it('1040px原稿から5サイズを同じupload idで保存し、baseUrlを反映する', async () => {
    const onChange = vi.fn()
    const { container } = render(<BroadcastMediaInputs messageType="imagemap" onChange={onChange} />)
    const input = container.querySelector('input[type="file"][accept="image/jpeg,image/png"]') as HTMLInputElement
    expect(input).toBeTruthy()
    fireEvent.change(input, { target: { files: [new File(['source'], 'imagemap.png', { type: 'image/png' })] } })

    await waitFor(() => expect(imagemapUploadMock).toHaveBeenCalledTimes(5))
    expect(imagemapUploadMock.mock.calls.map((call) => call[1])).toEqual([240, 300, 460, 700, 1040])
    expect(new Set(imagemapUploadMock.mock.calls.map((call) => call[2])).size).toBe(1)
    const json = onChange.mock.calls.at(-1)?.[0] as string
    expect(JSON.parse(json).baseUrl).toBe('https://worker.test/images/imagemaps/shared-id')
    expect(JSON.parse(json).baseSize).toEqual({ width: 1040, height: 520 })
  })
})

describe('D-2 BroadcastMediaInputs honest media limit copy', () => {
  it('動画欄にMP4形式と実装上限のMB値を表示する', () => {
    const { container } = render(<BroadcastMediaInputs messageType="video" onChange={vi.fn()} />)
    const copy = container.textContent ?? ''
    expect(copy).toMatch(/MP4/i)
    expect(copy).toMatch(/(?:上限|最大|まで)[^。\n]*\d+\s*MB|\d+\s*MB[^。\n]*(?:上限|最大|まで)/i)
  })

  it('動画を画像アップロードと同じ手順で上げられるという現状不一致の案内を出さない', () => {
    const { container } = render(<BroadcastMediaInputs messageType="video" onChange={vi.fn()} />)
    expect(container.textContent).not.toContain('画像アップロードと同じ手順')
  })

  it('音声欄にM4A形式と実装上限のMB値を表示する', () => {
    const { container } = render(<BroadcastMediaInputs messageType="audio" onChange={vi.fn()} />)
    const copy = container.textContent ?? ''
    expect(copy).toMatch(/M4A/i)
    expect(copy).toMatch(/(?:上限|最大|まで)[^。\n]*\d+\s*MB|\d+\s*MB[^。\n]*(?:上限|最大|まで)/i)
  })

  it('MP4を直接アップロードして動画URLへ反映する', async () => {
    const onChange = vi.fn()
    const { container } = render(<BroadcastMediaInputs messageType="video" onChange={onChange} />)
    const input = container.querySelector('input[type="file"][accept="video/mp4"]') as HTMLInputElement
    expect(input).toBeTruthy()
    fireEvent.change(input, { target: { files: [new File(['video'], 'clip.mp4', { type: 'video/mp4' })] } })
    await waitFor(() => expect(videoUploadMock).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      const json = onChange.mock.calls.at(-1)?.[0] as string
      expect(JSON.parse(json).originalContentUrl).toBe('https://worker.test/media/video.mp4')
    })
  })

  it('M4Aを直接アップロードして音声URLへ反映する', async () => {
    const onChange = vi.fn()
    const { container } = render(<BroadcastMediaInputs messageType="audio" onChange={onChange} />)
    const input = container.querySelector('input[type="file"][accept*="audio/mp4"]') as HTMLInputElement
    expect(input).toBeTruthy()
    fireEvent.change(input, { target: { files: [new File(['audio'], 'voice.m4a', { type: 'audio/mp4' })] } })
    await waitFor(() => expect(audioUploadMock).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      const json = onChange.mock.calls.at(-1)?.[0] as string
      expect(JSON.parse(json).originalContentUrl).toBe('https://worker.test/media/audio.m4a')
    })
  })

  it('richvideoは1040px原稿から5サイズを同じupload idで保存し、単一preview URLと分離する', async () => {
    const onChange = vi.fn()
    const initialContent = JSON.stringify({
      baseUrl: 'https://worker.test/images/imagemaps/old-id',
      altText: '動画メッセージ',
      baseSize: { width: 1040, height: 520 },
      actions: [],
      video: {
        originalContentUrl: 'https://worker.test/media/video.mp4',
        previewImageUrl: 'https://worker.test/images/preview.jpg',
        area: { x: 0, y: 0, width: 1040, height: 520 },
      },
    })
    const { container } = render(<BroadcastMediaInputs messageType="richvideo" onChange={onChange} initialContent={initialContent} />)

    const sourceInput = container.querySelector('input[type="file"][accept="image/jpeg,image/png"]') as HTMLInputElement
    expect(sourceInput).toBeTruthy()
    fireEvent.change(sourceInput, { target: { files: [new File(['source'], 'richvideo-base.png', { type: 'image/png' })] } })

    await waitFor(() => expect(imagemapUploadMock).toHaveBeenCalledTimes(5))
    expect(imagemapUploadMock.mock.calls.map((call) => call[1])).toEqual([240, 300, 460, 700, 1040])
    expect(new Set(imagemapUploadMock.mock.calls.map((call) => call[2])).size).toBe(1)
    const payload = JSON.parse(onChange.mock.calls.at(-1)?.[0] as string)
    expect(payload.baseUrl).toBe('https://worker.test/images/imagemaps/shared-id')
    expect(payload.baseSize).toEqual({ width: 1040, height: 520 })
    expect(payload.video.previewImageUrl).toBe('https://worker.test/images/preview.jpg')
    expect(payload.baseUrl).not.toBe(payload.video.previewImageUrl)
    expect(container.textContent).toMatch(/5サイズ/)
    expect(container.textContent).toMatch(/プレビュー画像とは別/)
  })
})
