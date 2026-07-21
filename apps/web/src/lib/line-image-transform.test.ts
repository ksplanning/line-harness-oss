// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createImagemapVariants } from './line-image-transform'

const originalToBlobDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'toBlob')

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalToBlobDescriptor) {
    Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', originalToBlobDescriptor)
  } else {
    delete (HTMLCanvasElement.prototype as { toBlob?: unknown }).toBlob
  }
})

describe('createImagemapVariants', () => {
  it('1040px fixtureから公式5幅と比例高さのcanvas出力を生成する', async () => {
    const close = vi.fn()
    const bitmap = { width: 1040, height: 520, close }
    const createImageBitmapMock = vi.fn(async () => bitmap)
    vi.stubGlobal('createImageBitmap', createImageBitmapMock)

    const drawImage = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as never)

    const canvasOutputs: Array<{ width: number; height: number; type: string | undefined }> = []
    Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
      configurable: true,
      value(this: HTMLCanvasElement, callback: BlobCallback, type?: string) {
        canvasOutputs.push({ width: this.width, height: this.height, type })
        callback(new Blob([new Uint8Array(this.width)], { type }))
      },
    })

    const file = new File([new Uint8Array([1])], 'imagemap.png', { type: 'image/png' })
    const variants = await createImagemapVariants(file)

    expect(createImageBitmapMock).toHaveBeenCalledOnce()
    expect(createImageBitmapMock).toHaveBeenCalledWith(file)
    expect(variants.map(({ width, height, blob }) => ({
      width,
      height,
      size: blob.size,
      type: blob.type,
    }))).toEqual([
      { width: 240, height: 120, size: 240, type: 'image/png' },
      { width: 300, height: 150, size: 300, type: 'image/png' },
      { width: 460, height: 230, size: 460, type: 'image/png' },
      { width: 700, height: 350, size: 700, type: 'image/png' },
      { width: 1040, height: 520, size: 1040, type: 'image/png' },
    ])
    expect(canvasOutputs).toEqual([
      { width: 240, height: 120, type: 'image/png' },
      { width: 300, height: 150, type: 'image/png' },
      { width: 460, height: 230, type: 'image/png' },
      { width: 700, height: 350, type: 'image/png' },
      { width: 1040, height: 520, type: 'image/png' },
    ])
    expect(drawImage.mock.calls.map(([, x, y, width, height]) => ({ x, y, width, height }))).toEqual([
      { x: 0, y: 0, width: 240, height: 120 },
      { x: 0, y: 0, width: 300, height: 150 },
      { x: 0, y: 0, width: 460, height: 230 },
      { x: 0, y: 0, width: 700, height: 350 },
      { x: 0, y: 0, width: 1040, height: 520 },
    ])
    expect(close).toHaveBeenCalledOnce()
  })
})
