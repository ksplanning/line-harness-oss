import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'

const BASE = 'https://worker.example.test'

beforeAll(() => {
  process.env.NEXT_PUBLIC_API_URL = BASE
})

type Captured = { url: string; init?: RequestInit }
let captured: Captured[] = []

beforeEach(() => {
  captured = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    captured.push({ url, init })
    return {
      ok: true,
      status: 201,
      json: async () => ({ success: true, data: { id: 'id-1', url: 'https://cdn.example.test/x' } }),
    } as Response
  }))
})

afterEach(() => vi.unstubAllGlobals())

async function loadApi() {
  return (await import('./api')).api
}

function namedBlob(type: string, name: string): File {
  const blob = new Blob([new Uint8Array([1, 2, 3])], { type })
  return Object.assign(blob, { name, lastModified: 0 }) as File
}

describe('direct media upload API helpers (D-1/D-2)', () => {
  test('image keeps the existing URL and streams the File body without arrayBuffer()', async () => {
    const api = await loadApi()
    const file = namedBlob('image/jpeg', 'photo.jpg')
    await api.uploads.image(file)

    expect(captured[0].url).toBe(`${BASE}/api/images`)
    expect(captured[0].init?.method).toBe('POST')
    expect(captured[0].init?.body).toBe(file)
    expect(new Headers(captured[0].init?.headers).get('Content-Type')).toBe('image/jpeg')
  })

  test.each([
    ['video', 'video/mp4', 'movie.mp4'],
    ['audio', 'audio/mp4', 'sound.m4a'],
  ] as const)('%s sends a streaming body with an explicit upload kind', async (kind, type, name) => {
    const api = await loadApi()
    const file = namedBlob(type, name)
    await api.uploads[kind](file)

    expect(captured[0].url).toBe(`${BASE}/api/images?kind=${kind}`)
    expect(captured[0].init?.body).toBe(file)
    expect(new Headers(captured[0].init?.headers).get('Content-Type')).toBe(type)
  })

  test.each([
    ['video', 'movie.mp4', 'video/mp4'],
    ['audio', 'sound.m4a', 'audio/mp4'],
    ['audio', 'sound.mp3', 'audio/mpeg'],
  ] as const)('%s infers %s media type when the browser leaves File.type empty', async (kind, name, expectedType) => {
    const api = await loadApi()
    const file = namedBlob('', name)
    await api.uploads[kind](file)

    expect(new Headers(captured[0].init?.headers).get('Content-Type')).toBe(expectedType)
  })

  test('imagemap sends an allowed width and optional variant id', async () => {
    const api = await loadApi()
    const file = namedBlob('image/png', 'map.png')
    await api.uploads.imagemap(file, 1040, '123e4567-e89b-42d3-a456-426614174000')

    expect(captured[0].url).toBe(
      `${BASE}/api/images?kind=imagemap&width=1040&id=123e4567-e89b-42d3-a456-426614174000`,
    )
    expect(captured[0].init?.body).toBe(file)
  })
})
