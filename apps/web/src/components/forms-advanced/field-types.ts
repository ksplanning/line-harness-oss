import { isDecorationType, type HarnessFieldType } from '@line-crm/shared'

// =============================================================================
// パレット field 種別メタ (F-2 / T-B1) — 素人向け日本語ラベル (英語 type 名を見せない / ui-design)。
// MVP subset のみ (N-13)。matrix/repeating_section 等は F-2b 以降。
// =============================================================================

export type FieldCategory = '入力' | '選択' | '高度' | '装飾'

export interface FieldTypeMeta {
  type: HarnessFieldType
  label: string
  icon: string
  category: FieldCategory
}

export const FIELD_TYPE_META: FieldTypeMeta[] = [
  { type: 'text', label: '1行テキスト', icon: '✏️', category: '入力' },
  { type: 'textarea', label: '複数行テキスト', icon: '📝', category: '入力' },
  { type: 'number', label: '数値', icon: '🔢', category: '入力' },
  { type: 'email', label: 'メール', icon: '✉️', category: '入力' },
  { type: 'phone', label: '電話番号', icon: '📞', category: '入力' },
  { type: 'date', label: '日付', icon: '📅', category: '入力' },
  { type: 'choice', label: '単一選択', icon: '🔘', category: '選択' },
  { type: 'dropdown', label: 'ドロップダウン', icon: '🔽', category: '選択' },
  { type: 'multiple_select', label: '複数選択', icon: '☑️', category: '選択' },
  { type: 'file', label: 'ファイル添付', icon: '📎', category: '高度' },
  { type: 'section', label: '見出し＋説明', icon: '🔖', category: '装飾' },
  { type: 'page_break', label: '改ページ', icon: '➖', category: '装飾' },
]

export const FIELD_CATEGORIES: FieldCategory[] = ['入力', '選択', '高度', '装飾']

export { isDecorationType }
export const isDecoration = isDecorationType

export function fieldTypeLabel(type: HarnessFieldType): string {
  return FIELD_TYPE_META.find((m) => m.type === type)?.label ?? type
}
export function fieldTypeIcon(type: HarnessFieldType): string {
  return FIELD_TYPE_META.find((m) => m.type === type)?.icon ?? '❓'
}

/** 種別が「選択肢を持つ」か (choice/dropdown/multiple_select)。 */
export function hasChoices(type: HarnessFieldType): boolean {
  return type === 'choice' || type === 'dropdown' || type === 'multiple_select'
}
/** 種別が「文字数制限を持つ」か (text/textarea)。 */
export function hasLength(type: HarnessFieldType): boolean {
  return type === 'text' || type === 'textarea'
}
