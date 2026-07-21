/**
 * T-C8 — broadcast 新種別の client ロジック (buildMediaJson / validateMediaClient)。
 * UI (broadcast-media-inputs.tsx) はこの純ロジックを使うため、種別ごとの直列化・検証を単体で固定。
 */
import { describe, it, expect } from 'vitest'
import { buildMediaJson, validateMediaClient, initialMediaState, parseMediaJson, clampRegion, type MediaState } from './broadcast-media'

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
    const json = buildMediaJson('richvideo', S({ baseUrl: 'https://x/base', videoUrl: 'https://x/v.mp4', previewUrl: 'https://x/p.png', btnLabel: '詳しく', btnLink: 'https://x/more' }))
    const p = JSON.parse(json)
    expect(p.baseUrl).toBe('https://x/base')
    expect(p.baseUrl).not.toBe(p.video.previewImageUrl)
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
  it('imagemap: 領域ゼロはエラー / uri 領域は LINE 対応 scheme のみ受理', () => {
    expect(validateMediaClient('imagemap', JSON.stringify({ baseUrl: 'https://x/im', baseSize: { width: 1, height: 1 }, actions: [] }))).toBeTruthy()
    expect(validateMediaClient('imagemap', JSON.stringify({ baseUrl: 'https://x/im', baseSize: { width: 1040, height: 1 }, actions: [{ type: 'uri', linkUri: 'tel:0312345678', area: { x: 0, y: 0, width: 1040, height: 1 } }] }))).toBeNull()
    expect(validateMediaClient('imagemap', JSON.stringify({ baseUrl: 'https://x/im', baseSize: { width: 1040, height: 1 }, actions: [{ type: 'uri', linkUri: 'ftp://x/lp', area: { x: 0, y: 0, width: 1040, height: 1 } }] }))).toBeTruthy()
  })
  it('imagemap: baseSizeの横幅が1040以外なら保存前に明示エラー', () => {
    const err = validateMediaClient('imagemap', JSON.stringify({
      baseUrl: 'https://x/im',
      baseSize: { width: 999, height: 1040 },
      actions: [{ type: 'uri', linkUri: 'https://x/lp', area: { x: 0, y: 0, width: 999, height: 1040 } }],
    }))
    expect(err).not.toBeNull()
    expect(err ?? '').toMatch(/1040/)
  })
  it('imagemap: URI 1000文字・応答文400文字の公式上限を超えるとエラー', () => {
    const base = { baseUrl: 'https://x/im', baseSize: { width: 1040, height: 1040 } }
    expect(validateMediaClient('imagemap', JSON.stringify({
      ...base,
      actions: [{ type: 'uri', linkUri: `https://${'a'.repeat(993)}`, area: { x: 0, y: 0, width: 10, height: 10 } }],
    }))).toMatch(/1000/)
    expect(validateMediaClient('imagemap', JSON.stringify({
      ...base,
      actions: [{ type: 'message', text: 'あ'.repeat(401), area: { x: 0, y: 0, width: 10, height: 10 } }],
    }))).toMatch(/400/)
  })
  it('richvideo: video 非 https はエラー・ボタン非 https もエラー', () => {
    expect(validateMediaClient('richvideo', JSON.stringify({ baseUrl: 'https://x/base', baseSize: { width: 1040, height: 520 }, video: { originalContentUrl: 'http://x/v.mp4', previewImageUrl: 'https://x/p.png' } }))).toBeTruthy()
    expect(validateMediaClient('richvideo', JSON.stringify({ baseUrl: 'https://x/base', baseSize: { width: 1040, height: 520 }, video: { originalContentUrl: 'https://x/v.mp4', previewImageUrl: 'https://x/p.png', externalLink: { linkUri: 'ftp://x/more', label: 'a' } } }))).toBeTruthy()
  })
  it('richvideo: 5サイズ用baseUrl未設定はプレビュ画像URLがあってもエラー', () => {
    const err = validateMediaClient('richvideo', JSON.stringify({
      baseUrl: '',
      baseSize: { width: 1040, height: 520 },
      video: { originalContentUrl: 'https://x/v.mp4', previewImageUrl: 'https://x/p.png' },
    }))
    expect(err).toMatch(/ベース画像/)
  })
  it('richvideo: 再生後ラベル30文字・リンク1000文字の公式上限を超えるとエラー', () => {
    const video = {
      originalContentUrl: 'https://x/v.mp4',
      previewImageUrl: 'https://x/p.png',
      area: { x: 0, y: 0, width: 1040, height: 520 },
    }
    const base = { baseUrl: 'https://x/base', baseSize: { width: 1040, height: 520 }, actions: [] }
    expect(validateMediaClient('richvideo', JSON.stringify({
      ...base,
      video: { ...video, externalLink: { linkUri: 'https://x', label: 'あ'.repeat(31) } },
    }))).toMatch(/30/)
    expect(validateMediaClient('richvideo', JSON.stringify({
      ...base,
      video: { ...video, externalLink: { linkUri: `https://${'a'.repeat(993)}`, label: '詳細' } },
    }))).toMatch(/1000/)
  })
})

describe('T-A2 parseMediaJson — 保存済み JSON → 編集 state 復元 (再編集経路 / round-trip)', () => {
  it('imagemap: buildMediaJson の出力を復元すると同一 JSON に戻る (数値⇄JSON 恒等)', () => {
    const s0 = S({
      baseUrl: 'https://x/im', baseW: '1040', baseH: '520',
      regions: [
        { x: '0', y: '0', width: '520', height: '520', actionType: 'uri', value: 'https://x/lp' },
        { x: '520', y: '0', width: '520', height: '520', actionType: 'message', value: 'こんにちは' },
      ],
    })
    const json = buildMediaJson('imagemap', s0)
    const restored = parseMediaJson('imagemap', json)
    expect(restored.baseUrl).toBe('https://x/im')
    expect(restored.baseW).toBe('1040')
    expect(restored.baseH).toBe('520')
    expect(restored.regions).toHaveLength(2)
    expect(restored.regions[0]).toEqual({ x: '0', y: '0', width: '520', height: '520', actionType: 'uri', value: 'https://x/lp' })
    expect(restored.regions[1]).toEqual({ x: '520', y: '0', width: '520', height: '520', actionType: 'message', value: 'こんにちは' })
    // round-trip 恒等: 復元 state から再直列化すると元の JSON に一致 (保存→開き直し→保存 で壊れない)
    expect(buildMediaJson('imagemap', restored)).toBe(json)
  })
  it('video / audio / richvideo も round-trip する (保存済みを再編集できる)', () => {
    const v = S({ videoUrl: 'https://x/v.mp4', previewUrl: 'https://x/p.png' })
    expect(buildMediaJson('video', parseMediaJson('video', buildMediaJson('video', v)))).toBe(buildMediaJson('video', v))
    const a = S({ audioUrl: 'https://x/a.m4a', durationSec: '30' })
    expect(buildMediaJson('audio', parseMediaJson('audio', buildMediaJson('audio', a)))).toBe(buildMediaJson('audio', a))
    const rv = S({ baseUrl: 'https://x/base', baseH: '520', videoUrl: 'https://x/v.mp4', previewUrl: 'https://x/p.png', btnLabel: '詳しく', btnLink: 'https://x/more' })
    expect(parseMediaJson('richvideo', buildMediaJson('richvideo', rv)).baseUrl).toBe('https://x/base')
    expect(buildMediaJson('richvideo', parseMediaJson('richvideo', buildMediaJson('richvideo', rv)))).toBe(buildMediaJson('richvideo', rv))
  })
  it('richvideo の公式追加フィールドも編集 round-trip で保持する', () => {
    const original = JSON.stringify({
      baseUrl: 'https://x/base',
      altText: '既存の動画案内',
      baseSize: { width: 1040, height: 520 },
      actions: [{ type: 'message', text: '代替', area: { x: 0, y: 0, width: 20, height: 20 } }],
      video: {
        originalContentUrl: 'https://x/v.mp4',
        previewImageUrl: 'https://x/p.png',
        area: { x: 0, y: 0, width: 1040, height: 520 },
        customField: 'keep',
      },
    })
    const rebuilt = JSON.parse(buildMediaJson('richvideo', parseMediaJson('richvideo', original)))
    expect(rebuilt.altText).toBe('既存の動画案内')
    expect(rebuilt.actions).toHaveLength(1)
    expect(rebuilt.video.customField).toBe('keep')
  })
  it('空文字 / 壊れた JSON は初期 state を返す (fail-safe)', () => {
    expect(parseMediaJson('imagemap', '')).toEqual(initialMediaState)
    expect(parseMediaJson('imagemap', 'not-json{')).toEqual(initialMediaState)
  })
})

describe('T-A2 clampRegion — baseSize 内に収める / 範囲外拒否 (本番で領域がズレない)', () => {
  it('範囲外にはみ出す width/height を base 内に clamp', () => {
    const json = buildMediaJson('imagemap', S({
      baseUrl: 'https://x/im', baseW: '1000', baseH: '1000',
      regions: [{ x: '900', y: '900', width: '500', height: '500', actionType: 'uri', value: 'https://x/lp' }],
    }))
    const p = JSON.parse(json)
    expect(p.actions[0].area).toEqual({ x: 900, y: 900, width: 100, height: 100 })
  })
  it('負値は 0 に clamp', () => {
    const json = buildMediaJson('imagemap', S({
      baseUrl: 'https://x/im', baseW: '1000', baseH: '1000',
      regions: [{ x: '-50', y: '-30', width: '200', height: '200', actionType: 'uri', value: 'https://x/lp' }],
    }))
    const p = JSON.parse(json)
    expect(p.actions[0].area).toEqual({ x: 0, y: 0, width: 200, height: 200 })
  })
  it('in-range はそのまま (恒等・数値→ドラッグ→数値 恒等の土台)', () => {
    const r = { x: '10', y: '20', width: '100', height: '80', actionType: 'uri' as const, value: 'https://x' }
    expect(clampRegion(r, 1040, 1040)).toEqual(r)
  })
})
