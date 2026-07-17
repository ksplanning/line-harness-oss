/**
 * treasure-b1-palette (T-E1) — パレットメタに rating/signature/video を additive。
 *   FIELD_TYPE_META 3 行 + fieldTypeLabel/fieldTypeIcon 解決 + hasRatingSubType + RATING_SUB_TYPE_OPTIONS(UI 4 種)。
 *   既存 helper(hasChoices/hasLength/hasMaxLength) は新型で false(後方互換)。
 */
import { describe, it, expect } from 'vitest'
import {
  FIELD_TYPE_META,
  fieldTypeLabel,
  fieldTypeIcon,
  hasChoices,
  hasLength,
  hasMaxLength,
  hasRatingSubType,
  RATING_SUB_TYPE_OPTIONS,
} from './field-types'

describe('B1 field-types — FIELD_TYPE_META additive (T-E1)', () => {
  it('rating(⭐/入力)・signature(✍️/高度)・video(🎬/装飾) を含む', () => {
    const byType = Object.fromEntries(FIELD_TYPE_META.map((m) => [m.type, m]))
    expect(byType.rating).toMatchObject({ label: '評価', icon: '⭐', category: '入力' })
    expect(byType.signature).toMatchObject({ label: '署名', icon: '✍️', category: '高度' })
    expect(byType.video).toMatchObject({ label: '動画', icon: '🎬', category: '装飾' })
  })
  it('fieldTypeLabel / fieldTypeIcon が 3 型を解決する', () => {
    expect(fieldTypeLabel('rating')).toBe('評価')
    expect(fieldTypeIcon('signature')).toBe('✍️')
    expect(fieldTypeIcon('video')).toBe('🎬')
  })
})

describe('B1 field-types — helper (T-E1)', () => {
  it('hasRatingSubType は rating のみ true', () => {
    expect(hasRatingSubType('rating')).toBe(true)
    expect(hasRatingSubType('signature')).toBe(false)
    expect(hasRatingSubType('video')).toBe(false)
    expect(hasRatingSubType('text')).toBe(false)
  })
  it('既存 helper は新型で false (後方互換)', () => {
    for (const t of ['rating', 'signature', 'video'] as const) {
      expect(hasChoices(t)).toBe(false)
      expect(hasLength(t)).toBe(false)
      expect(hasMaxLength(t)).toBe(false)
    }
  })
  it('RATING_SUB_TYPE_OPTIONS は UI 露出 4 種 (star/like_dislike/nps/score・embeded 非露出)', () => {
    const values = RATING_SUB_TYPE_OPTIONS.map((o) => o.value)
    expect(values).toEqual(['star', 'like_dislike', 'nps', 'score'])
    expect(values).not.toContain('embeded')
    for (const o of RATING_SUB_TYPE_OPTIONS) expect(typeof o.label).toBe('string')
  })
})
