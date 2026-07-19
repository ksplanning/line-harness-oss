import { describe, expect, test } from 'vitest'
import {
  FIELD_TYPE_META,
  VARIABLE_SUB_TYPE_OPTIONS,
  fieldTypeIcon,
  fieldTypeLabel,
  hasChoices,
} from './field-types'

describe('dynamic calculation field palette', () => {
  test('計算と動的選択肢を既存カテゴリへ additive に公開する', () => {
    const byType = Object.fromEntries(FIELD_TYPE_META.map((meta) => [meta.type, meta]))

    expect(byType.variable).toMatchObject({ label: '計算', icon: '🧮', category: '高度' })
    expect(byType.choice_fetch).toMatchObject({ label: '動的選択肢', icon: '🔄', category: '選択' })
    expect(fieldTypeLabel('variable')).toBe('計算')
    expect(fieldTypeIcon('choice_fetch')).toBe('🔄')
  })

  test('variable sub_type は実測済み 4 種だけを選べる', () => {
    expect(VARIABLE_SUB_TYPE_OPTIONS.map((option) => option.value)).toEqual([
      'int',
      'string',
      'decimal',
      'formula',
    ])
  })

  test('choice_fetch は静的 choices editor の対象にしない', () => {
    expect(hasChoices('choice_fetch')).toBe(false)
  })
})
