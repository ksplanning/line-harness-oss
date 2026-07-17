import { describe, it, expect } from 'vitest'
import {
  FIELD_TYPE_META,
  IMAGE_WIDTH_OPTIONS,
  fieldTypeLabel,
  fieldTypeIcon,
  isDecoration,
  hasChoices,
  hasLength,
} from './field-types'

describe('T-B1 field-types: 差し込み画像 palette', () => {
  it("装飾グループに image {label:'画像', icon:'🖼️'} を追加", () => {
    const image = FIELD_TYPE_META.find((m) => m.type === 'image')
    expect(image).toBeDefined()
    expect(image).toMatchObject({ type: 'image', label: '画像', category: '装飾' })
    expect(fieldTypeLabel('image')).toBe('画像')
    expect(fieldTypeIcon('image')).toBe('🖼️')
  })

  it('image は装飾 (isDecoration) で選択肢/文字数を持たない', () => {
    expect(isDecoration('image')).toBe(true)
    expect(hasChoices('image')).toBe(false)
    expect(hasLength('image')).toBe(false)
  })

  it('IMAGE_WIDTH_OPTIONS は 小40%/中70%/全幅100% (owner ②)', () => {
    expect(IMAGE_WIDTH_OPTIONS).toEqual([
      { value: 'small', label: '小（40%）' },
      { value: 'medium', label: '中（70%）' },
      { value: 'full', label: '全幅（100%）' },
    ])
  })
})
