// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

const { uploadMock } = vi.hoisted(() => ({ uploadMock: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: {
    uploads: {
      image: (...args: unknown[]) => uploadMock(...args),
    },
  },
}))

import ImageUploader from './image-uploader'

const MIB = 1024 * 1024
const originalCanvasDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'toBlob')
const originalToDataUrlDescriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'toDataURL')

beforeEach(() => {
  uploadMock.mockReset()
  uploadMock.mockImplementation(async (blob: Blob) => {
    const role = blob.size === 2 * MIB ? 'original' : 'preview'
    return {
      success: true,
      data: {
        id: role,
        key: `media/${role}.jpg`,
        url: `https://worker.test/images/media/${role}.jpg`,
        mimeType: blob.type,
        size: blob.size,
      },
    }
  })

  // The production implementation may use createImageBitmap or Image + canvas.
  // Keep both browser paths deterministic; the RED must fail on behavior, not jsdom gaps.
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 2400, height: 1600, close: vi.fn() })))
  vi.stubGlobal('Image', class {
    naturalWidth = 2400
    naturalHeight = 1600
    width = 2400
    height = 1600
    onload: ((event: Event) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    set src(_value: string) { queueMicrotask(() => this.onload?.(new Event('load'))) }
  })
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: vi.fn(() => 'blob:line-image-test'),
    revokeObjectURL: vi.fn(),
  })
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as never)
  Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
    configurable: true,
    value: (callback: BlobCallback) => callback(new Blob([new Uint8Array(512 * 1024)], { type: 'image/jpeg' })),
  })
  Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', {
    configurable: true,
    value: () => 'data:image/jpeg;base64,AA==',
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (originalCanvasDescriptor) Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', originalCanvasDescriptor)
  else delete (HTMLCanvasElement.prototype as { toBlob?: unknown }).toBlob
  if (originalToDataUrlDescriptor) Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', originalToDataUrlDescriptor)
  else delete (HTMLCanvasElement.prototype as { toDataURL?: unknown }).toDataURL
})

function chooseFile(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  expect(input).toBeTruthy()
  fireEvent.change(input, { target: { files: [file] } })
}

describe('ImageUploader line-image official limits', () => {
  it('accepts a 2MiB JPEG, uploads original and <=1MiB preview, and emits distinct URLs', async () => {
    const onChange = vi.fn()
    const { container } = render(<ImageUploader mode="line-image" value={null} onChange={onChange} />)
    chooseFile(container, new File([new Uint8Array(2 * MIB)], 'two-mib.jpg', { type: 'image/jpeg' }))

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(2))
    const uploaded = uploadMock.mock.calls.map(([blob]) => blob as Blob)
    expect(uploaded.some((blob) => blob.size === 2 * MIB)).toBe(true)
    expect(uploaded.some((blob) => blob.size <= MIB)).toBe(true)
    expect(onChange).toHaveBeenLastCalledWith({
      mode: 'line-image',
      originalContentUrl: 'https://worker.test/images/media/original.jpg',
      previewImageUrl: 'https://worker.test/images/media/preview.jpg',
    })
  })

  it('rejects a JPEG over 10MiB with a loud 10MB error before upload', async () => {
    const { container } = render(<ImageUploader mode="line-image" value={null} onChange={vi.fn()} />)
    chooseFile(container, new File([new Uint8Array(10 * MIB + 1)], 'too-large.jpg', { type: 'image/jpeg' }))

    await waitFor(() => expect(container.textContent).toMatch(/10\s*MB/))
    expect(uploadMock).not.toHaveBeenCalled()
  })
})

describe('ImageUploader sender icon limits', () => {
  it('advertises PNG / 1MB / 1:1 and restricts the file picker to PNG', () => {
    const { container } = render(
      <ImageUploader mode="url" usage="sender-icon" value={null} onChange={vi.fn()} />,
    )

    expect(container.textContent).toMatch(/PNG.*1MB.*1:1/)
    expect((container.querySelector('input[type="file"]') as HTMLInputElement).accept).toBe('image/png')
  })

  it('loudly rejects a JPEG before upload', async () => {
    const { container } = render(
      <ImageUploader mode="url" usage="sender-icon" value={null} onChange={vi.fn()} />,
    )
    chooseFile(container, new File([new Uint8Array(10)], 'not-png.jpg', { type: 'image/jpeg' }))

    await waitFor(() => expect(container.textContent).toMatch(/PNG/))
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('loudly rejects a PNG over 1MiB before upload', async () => {
    const { container } = render(
      <ImageUploader mode="url" usage="sender-icon" value={null} onChange={vi.fn()} />,
    )
    chooseFile(container, new File([new Uint8Array(MIB + 1)], 'too-large.png', { type: 'image/png' }))

    await waitFor(() => expect(container.textContent).toMatch(/1\s*MB/))
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('loudly rejects a non-square PNG before upload', async () => {
    const { container } = render(
      <ImageUploader mode="url" usage="sender-icon" value={null} onChange={vi.fn()} />,
    )
    chooseFile(container, new File([new Uint8Array(10)], 'wide.png', { type: 'image/png' }))

    await waitFor(() => expect(container.textContent).toMatch(/正方形|1:1/))
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('accepts a square PNG within 1MiB', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 512, height: 512, close: vi.fn() })))
    const { container } = render(
      <ImageUploader mode="url" usage="sender-icon" value={null} onChange={vi.fn()} />,
    )
    chooseFile(container, new File([new Uint8Array(10)], 'square.png', { type: 'image/png' }))

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1))
  })
})

describe('ImageUploader Flex image dimensions', () => {
  it.each(['flex-image', 'flex-icon'] as const)('%s rejects an image larger than 1024x1024 before upload', async (usage) => {
    const { container } = render(
      <ImageUploader mode="url" usage={usage} value={null} onChange={vi.fn()} />,
    )
    chooseFile(container, new File([new Uint8Array(10)], 'too-wide.png', { type: 'image/png' }))

    await waitFor(() => expect(container.textContent).toMatch(/1024/))
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('rejects an animated PNG over the LINE 300KB Flex ceiling before upload', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 512, height: 512, close: vi.fn() })))
    const bytes = new Uint8Array(300 * 1024 + 1)
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    // Empty acTL chunk is sufficient for format detection in this validation test.
    bytes.set([0, 0, 0, 0, 0x61, 0x63, 0x54, 0x4c, 0, 0, 0, 0], 8)
    const { container } = render(
      <ImageUploader mode="url" usage="flex-image" value={null} onChange={vi.fn()} />,
    )
    chooseFile(container, new File([bytes], 'animated.png', { type: 'image/png' }))

    await waitFor(() => expect(container.textContent).toMatch(/300\s*KB/))
    expect(uploadMock).not.toHaveBeenCalled()
  })
})
