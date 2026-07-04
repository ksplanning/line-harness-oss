/**
 * fix — broadcast 種別ラベルの共有 mapping (6/7 種別) + 詳細プレビューの新 type サマリ。
 * 一覧 (page.tsx) / 詳細 (broadcast-detail.tsx) の 3分岐 ternary で video/audio/imagemap/richvideo が
 * 「Flex」と誤表示していた回帰を固定する。ラベル定義は broadcast-form と本 lib で単一 (重複禁止)。
 */
import { describe, it, expect } from 'vitest'
import { messageTypeLabels, mediaPreviewSummary } from './broadcast-labels'

describe('messageTypeLabels — 全 7 種別の日本語ラベル', () => {
  it('各種別が正しい日本語ラベルに mapping される', () => {
    expect(messageTypeLabels.text).toBe('テキスト')
    expect(messageTypeLabels.image).toBe('画像')
    expect(messageTypeLabels.flex).toBe('Flexメッセージ')
    expect(messageTypeLabels.video).toBe('動画')
    expect(messageTypeLabels.audio).toBe('音声')
    expect(messageTypeLabels.imagemap).toBe('リッチメッセージ (画像分割)')
    expect(messageTypeLabels.richvideo).toBe('リッチビデオ')
  })
  it('新 type は「Flex」に落ちない (回帰の核)', () => {
    for (const t of ['video', 'audio', 'imagemap', 'richvideo'] as const) {
      expect(messageTypeLabels[t]).not.toMatch(/Flex/)
    }
  })
})

describe('mediaPreviewSummary — 新 type は生 JSON を出さず簡潔サマリ', () => {
  it('video → URL サマリ (生 JSON でない)', () => {
    const s = mediaPreviewSummary('video', JSON.stringify({ originalContentUrl: 'https://x/v.mp4', previewImageUrl: 'https://x/p.png' }))
    expect(s).toContain('https://x/v.mp4')
    expect(s).not.toContain('previewImageUrl') // 生 JSON キーを吹き出しに出さない
  })
  it('audio → URL + 秒', () => {
    const s = mediaPreviewSummary('audio', JSON.stringify({ originalContentUrl: 'https://x/a.m4a', duration: 30000 }))
    expect(s).toContain('https://x/a.m4a')
    expect(s).toContain('30')
  })
  it('imagemap → baseUrl + 領域数', () => {
    const s = mediaPreviewSummary('imagemap', JSON.stringify({ baseUrl: 'https://x/im', actions: [{ type: 'uri' }, { type: 'uri' }] }))
    expect(s).toContain('https://x/im')
    expect(s).toContain('2')
  })
  it('richvideo → video URL', () => {
    const s = mediaPreviewSummary('richvideo', JSON.stringify({ video: { originalContentUrl: 'https://x/v.mp4' } }))
    expect(s).toContain('https://x/v.mp4')
  })
  it('text/image/flex は対象外 (null)', () => {
    expect(mediaPreviewSummary('text', 'hi')).toBeNull()
    expect(mediaPreviewSummary('image', '{}')).toBeNull()
    expect(mediaPreviewSummary('flex', '{}')).toBeNull()
  })
})
