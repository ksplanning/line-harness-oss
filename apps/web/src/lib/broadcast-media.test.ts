/**
 * T-C8 — broadcast 新種別の client ロジック (buildMediaJson / validateMediaClient)。
 * UI (broadcast-media-inputs.tsx) はこの純ロジックを使うため、種別ごとの直列化・検証を単体で固定。
 */
import { describe, it, expect } from 'vitest'
import { buildMediaJson, validateMediaClient, initialMediaState, type MediaState } from './broadcast-media'

const S = (over: Partial<MediaState>): MediaState => ({ ...initialMediaState, ...over })

describe('T-C8 buildMediaJson — 種別ごとの messageContent 直列化', () => {
  it('video → {originalContentUrl, previewImageUrl}', () => {
    const json = buildMediaJson('video', S({ videoUrl: 'https://x/v.mp4', previewUrl: 'https://x/p.png' }))
    expect(JSON.parse(json)).toEqual({ originalContentUrl: 'https://x/v.mp4', previewImageUrl: 'https://x/p.png' })
  })
  it('audio → duration を秒→ミリ秒に変換', () => {
    const json = buildMediaJson('audio', S({ audioUrl: 'https://x/a.m4a', durationSec: '30' }))
    expect(JSON.parse(json)).toEqual({ originalContentUrl: 'https://x/a.m4a', duration: 30000 })
  })
  it('imagemap → baseSize + actions(area)', () => {
    const json = buildMediaJson('imagemap', S({
      baseUrl: 'https://x/im', baseW: '1040', baseH: '520',
      regions: [{ x: '0', y: '0', width: '520', height: '520', actionType: 'uri', value: 'https://x/lp' }],
    }))
    const p = JSON.parse(json)
    expect(p.baseSize).toEqual({ width: 1040, height: 520 })
    expect(p.actions[0]).toEqual({ type: 'uri', linkUri: 'https://x/lp', area: { x: 0, y: 0, width: 520, height: 520 } })
  })
  it('richvideo → video ブロック + externalLink', () => {
    const json = buildMediaJson('richvideo', S({ videoUrl: 'https://x/v.mp4', previewUrl: 'https://x/p.png', btnLabel: '詳しく', btnLink: 'https://x/more' }))
    const p = JSON.parse(json)
    expect(p.video.originalContentUrl).toBe('https://x/v.mp4')
    expect(p.video.externalLink).toEqual({ linkUri: 'https://x/more', label: '詳しく' })
  })
  it('未入力は空文字を返す (部分 JSON を送らない)', () => {
    expect(buildMediaJson('video', initialMediaState)).toBe('')
    expect(buildMediaJson('audio', initialMediaState)).toBe('')
  })
})

describe('T-C8 validateMediaClient — client 即時検証 (server が正典)', () => {
  it('video: 非 https は日本語エラー', () => {
    const err = validateMediaClient('video', JSON.stringify({ originalContentUrl: 'http://x/v.mp4', previewImageUrl: 'https://x/p.png' }))
    expect(err).toBeTruthy()
    expect(err).not.toMatch(/[a-zA-Z]{6,}/)
  })
  it('video: 両 https は OK (null)', () => {
    expect(validateMediaClient('video', JSON.stringify({ originalContentUrl: 'https://x/v.mp4', previewImageUrl: 'https://x/p.png' }))).toBeNull()
  })
  it('audio: duration<=0 はエラー', () => {
    expect(validateMediaClient('audio', JSON.stringify({ originalContentUrl: 'https://x/a.m4a', duration: 0 }))).toBeTruthy()
  })
  it('imagemap: 領域ゼロはエラー / uri 領域の非 https はエラー', () => {
    expect(validateMediaClient('imagemap', JSON.stringify({ baseUrl: 'https://x/im', baseSize: { width: 1, height: 1 }, actions: [] }))).toBeTruthy()
    expect(validateMediaClient('imagemap', JSON.stringify({ baseUrl: 'https://x/im', baseSize: { width: 1, height: 1 }, actions: [{ type: 'uri', linkUri: 'http://x/lp', area: { x: 0, y: 0, width: 1, height: 1 } }] }))).toBeTruthy()
  })
  it('richvideo: video 非 https はエラー・ボタン非 https もエラー', () => {
    expect(validateMediaClient('richvideo', JSON.stringify({ video: { originalContentUrl: 'http://x/v.mp4', previewImageUrl: 'https://x/p.png' } }))).toBeTruthy()
    expect(validateMediaClient('richvideo', JSON.stringify({ video: { originalContentUrl: 'https://x/v.mp4', previewImageUrl: 'https://x/p.png', externalLink: { linkUri: 'http://x/more', label: 'a' } } }))).toBeTruthy()
  })
})
