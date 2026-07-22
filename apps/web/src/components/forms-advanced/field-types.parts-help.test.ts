import { describe, expect, it } from 'vitest'
import { FIELD_TYPE_META, isRepeatingColumnType } from './field-types'

const VISIBLE_FIELD_TYPES = [
  'text',
  'address',
  'textarea',
  'number',
  'email',
  'phone',
  'date',
  'time',
  'website',
  'choice',
  'yes_no',
  'dropdown',
  'multiple_select',
  'choice_fetch',
  'file',
  'variable',
  'matrix',
  'repeating_section',
  'rating',
  'signature',
  'section',
  'page_break',
  'video',
  'image',
] as const

type PartsHelpMeta = (typeof FIELD_TYPE_META)[number] & {
  paletteVisible?: boolean
  help?: {
    summary?: string
    howTo?: string
    example?: string
  }
}

const meta = FIELD_TYPE_META as PartsHelpMeta[]

describe('builder parts help — 説明データ', () => {
  it('city を除く表示対象24種をパレット対象として明示する', () => {
    expect(meta.filter((item) => item.paletteVisible !== false).map((item) => item.type)).toEqual(VISIBLE_FIELD_TYPES)
  })

  it('住所パーツを折り返し表示・1行データとして日常語で説明する', () => {
    const address = meta.find((item) => item.type === 'address')

    expect(address).toMatchObject({ label: '住所', icon: '🏠', internalOnly: true })
    expect(address?.help?.summary).toMatch(/折り返し/)
    expect(address?.help?.howTo).toMatch(/改行.*1行|1行.*改行/)
    expect(isRepeatingColumnType('address' as never)).toBe(false)
  })

  it('表示対象の全パーツが機能・使い方・使用例を空文字なしで持つ', () => {
    for (const item of meta.filter((candidate) => candidate.paletteVisible !== false)) {
      expect(item.help?.summary.trim(), `${item.type}: 機能`).toBeTruthy()
      expect(item.help?.howTo.trim(), `${item.type}: 使い方`).toBeTruthy()
      expect(item.help?.example.trim(), `${item.type}: 使用例`).toMatch(/^例[：:]/)
      expect(item.help?.example.trim().length, `${item.type}: 使用例の本文`).toBeGreaterThan(3)
      const howToSentences = item.help?.howTo.split('。').map((sentence) => sentence.trim()).filter(Boolean) ?? []
      expect(howToSentences.length, `${item.type}: 使い方の文数`).toBeGreaterThanOrEqual(2)
      expect(howToSentences.length, `${item.type}: 使い方の文数`).toBeLessThanOrEqual(3)
    }
  })

  it('高度な仕組みの説明が実際の動きと一致する', () => {
    const byType = Object.fromEntries(meta.map((item) => [item.type, item]))

    expect(byType.choice_fetch.help?.summary).toMatch(/外部.*URL.*選択肢.*読み込/)
    expect(byType.variable.help?.summary).toMatch(/ほかの欄.*自動で計算/)
    expect(byType.variable.help?.howTo).toContain('計算式')
    expect(byType.matrix.help?.summary).toMatch(/行と列.*表.*行ごとに1つ/)
    expect(byType.repeating_section.help?.summary).toMatch(/同じ欄の組み合わせ.*回答者が.*必要な分だけ追加/)
    expect(byType.repeating_section.help?.howTo).toContain('入力欄を先に作り、それらの欄を選びます')
    expect(byType.signature.help?.summary).toMatch(/手書き.*署名/)
    expect(byType.signature.help?.howTo).not.toContain('証として')
  })

  it('説明本文に内部の型名や専門用語をそのまま見せない', () => {
    const forbidden = /choice_fetch|variable|matrix|repeating_section|sub_type|config|field|Formaloo|API|JSON|slug|alias|oembed|iframe|CRUD|pull|push|hosted|endpoint|エンドポイント|フェッチ|フィールド|マトリクス|サブタイプ|コンフィグ/i

    for (const item of meta) {
      const copy = [item.help?.summary, item.help?.howTo, item.help?.example].join(' ')
      expect(copy, item.type).not.toMatch(forbidden)
    }
  })

  it('city の表示名と説明は既存フォーム向けに残し、日本の住所には1行テキストを案内する', () => {
    const city = meta.find((item) => item.type === 'city')

    expect(city).toMatchObject({ label: '市区町村', icon: '🏙️', paletteVisible: false })
    expect(city?.help?.summary).toContain('世界の都市')
    expect(city?.help?.howTo).toContain('日本の住所入力には「1行テキスト」')
  })
})
