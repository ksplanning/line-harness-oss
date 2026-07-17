/**
 * b1-field-polish (T-D3) — video 表示サイズ preset + 評価スター色 palette の named export。
 *   builder の per-field 動画サイズ select / form-level 星色 picker が参照する UI メタ (単一正本)。
 *   既存 FIELD_TYPE_META / RATING_SUB_TYPE_OPTIONS の露出は不変 (後方互換)。
 */
import { describe, test, expect } from 'vitest'
import { DEFAULT_RATING_STAR_COLOR, DEFAULT_VIDEO_HEIGHT, isValidHexColor } from '@line-crm/shared'
import {
  VIDEO_SIZE_PRESETS,
  RATING_STAR_PALETTE,
  FIELD_TYPE_META,
  RATING_SUB_TYPE_OPTIONS,
} from './field-types'

const HEIGHT_RE = /^\d{2,4}px$/

describe('b1-field-polish T-D3 — VIDEO_SIZE_PRESETS', () => {
  test('小/中/大 の 3 段以上で value は videoHeight whitelist (px) を満たす', () => {
    expect(VIDEO_SIZE_PRESETS.length).toBeGreaterThanOrEqual(3)
    for (const p of VIDEO_SIZE_PRESETS) {
      expect(typeof p.label).toBe('string')
      expect(p.value).toMatch(HEIGHT_RE)
      // 全 preset が再生可能サイズ (既定 100px 薄帯より大)。
      expect(parseInt(p.value, 10)).toBeGreaterThanOrEqual(150)
    }
    expect(VIDEO_SIZE_PRESETS.map((p) => p.label)).toEqual(expect.arrayContaining(['小', '中', '大']))
  })
  test('既定高さ DEFAULT_VIDEO_HEIGHT が preset 群のレンジ内 (整合)', () => {
    const px = VIDEO_SIZE_PRESETS.map((p) => parseInt(p.value, 10))
    const def = parseInt(DEFAULT_VIDEO_HEIGHT, 10)
    expect(def).toBeGreaterThanOrEqual(Math.min(...px))
    expect(def).toBeLessThanOrEqual(Math.max(...px))
  })
})

describe('b1-field-polish T-D3 — RATING_STAR_PALETTE', () => {
  test('全 value が valid hex・既定黄を含み先頭が DEFAULT_RATING_STAR_COLOR', () => {
    expect(RATING_STAR_PALETTE.length).toBeGreaterThanOrEqual(5)
    expect(RATING_STAR_PALETTE[0].value).toBe(DEFAULT_RATING_STAR_COLOR)
    for (const c of RATING_STAR_PALETTE) {
      expect(typeof c.label).toBe('string')
      expect(isValidHexColor(c.value)).toBe(true)
    }
    expect(RATING_STAR_PALETTE.some((c) => c.value === DEFAULT_RATING_STAR_COLOR)).toBe(true)
  })
  test('コントラスト保証 (curated): 各色は白地/黒地の両方で視認可能なレンジ (極端に明暗でない)', () => {
    for (const c of RATING_STAR_PALETTE) {
      const r = parseInt(c.value.slice(1, 3), 16)
      const g = parseInt(c.value.slice(3, 5), 16)
      const b = parseInt(c.value.slice(5, 7), 16)
      // 相対輝度 (近似): 黒すぎ (白地でしか見えない) / 白すぎ (黒地でしか見えない) を curated から除外。
      const lum = 0.299 * r + 0.587 * g + 0.114 * b
      expect(lum).toBeGreaterThan(40)
      expect(lum).toBeLessThan(230)
    }
  })
})

describe('b1-field-polish T-D3 — 既存露出は不変 (後方互換)', () => {
  test('FIELD_TYPE_META に rating/video が残る・RATING_SUB_TYPE_OPTIONS は 4 種', () => {
    expect(FIELD_TYPE_META.some((m) => m.type === 'rating')).toBe(true)
    expect(FIELD_TYPE_META.some((m) => m.type === 'video')).toBe(true)
    expect(RATING_SUB_TYPE_OPTIONS.map((o) => o.value)).toEqual(['star', 'like_dislike', 'nps', 'score'])
  })
})
