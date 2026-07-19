import { describe, expect, test } from 'vitest'
import { FIELD_TYPE_META, fieldTypeIcon, fieldTypeLabel, hasChoices, isScalarReferenceType } from './field-types'

describe('structural field palette', () => {
  test('行列と繰り返しセクションを高度カテゴリへ additive に公開する', () => {
    const byType = Object.fromEntries(FIELD_TYPE_META.map((meta) => [meta.type, meta]))
    expect(byType.matrix).toMatchObject({ label: '行列', icon: '▦', category: '高度' })
    expect(byType.repeating_section).toMatchObject({ label: '繰り返しセクション', icon: '🔁', category: '高度' })
    expect(fieldTypeLabel('matrix')).toBe('行列')
    expect(fieldTypeIcon('repeating_section')).toBe('🔁')
  })

  test('通常の choices editor へ構造フィールドを誤分類しない', () => {
    expect(hasChoices('matrix')).toBe(false)
    expect(hasChoices('repeating_section')).toBe(false)
  })

  test('既存の variable 参照は残し、構造フィールドだけを scalar 参照から外す', () => {
    expect(isScalarReferenceType('variable')).toBe(true)
    expect(isScalarReferenceType('matrix')).toBe(false)
    expect(isScalarReferenceType('repeating_section')).toBe(false)
  })
})
