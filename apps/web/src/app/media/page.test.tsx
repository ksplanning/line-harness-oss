// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

const { listMock, uploadMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  uploadMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    images: {
      list: (...args: unknown[]) => listMock(...args),
      remove: vi.fn(),
    },
    uploads: {
      image: (...args: unknown[]) => uploadMock(...args),
    },
  },
}))

vi.mock('@/components/layout/header', () => ({
  default: ({ title, description, action }: { title: string; description: string; action: React.ReactNode }) => (
    <header>
      <h1>{title}</h1>
      <p>{description}</p>
      {action}
    </header>
  ),
}))

import MediaLibraryPage from './page'

const MIB = 1024 * 1024

beforeEach(() => {
  listMock.mockReset()
  uploadMock.mockReset()
  listMock.mockResolvedValue({ success: true, data: { items: [], cursor: undefined } })
})

afterEach(() => cleanup())

function chooseFile(container: HTMLElement, file: File) {
  const input = container.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [file] } })
}

describe('media library upload contract', () => {
  it('shows the supported image formats and 10MB limit', async () => {
    const { container } = render(<MediaLibraryPage />)
    await waitFor(() => expect(listMock).toHaveBeenCalled())

    expect(container.textContent).toMatch(/JPEG\s*\/\s*PNG\s*\/\s*GIF\s*\/\s*WebP.*10MB/)
    expect((container.querySelector('input[type="file"]') as HTMLInputElement).accept)
      .toBe('image/jpeg,image/png,image/gif,image/webp')
    expect(container.textContent).toMatch(/LINE配信.*Flex.*JPEG.*PNG.*GIF.*WebP.*Webページ用/)
  })

  it('loudly rejects an unsupported image type before upload', async () => {
    const { container } = render(<MediaLibraryPage />)
    await waitFor(() => expect(listMock).toHaveBeenCalled())
    chooseFile(container, new File([new Uint8Array(10)], 'vector.svg', { type: 'image/svg+xml' }))

    await waitFor(() => expect(container.textContent).toMatch(/対応形式は JPEG \/ PNG \/ GIF \/ WebP/))
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('loudly rejects an image over 10MiB before upload', async () => {
    const { container } = render(<MediaLibraryPage />)
    await waitFor(() => expect(listMock).toHaveBeenCalled())
    chooseFile(container, new File([new Uint8Array(10 * MIB + 1)], 'too-large.jpg', { type: 'image/jpeg' }))

    await waitFor(() => expect(container.textContent).toMatch(/10\s*MB/))
    expect(uploadMock).not.toHaveBeenCalled()
  })
})
