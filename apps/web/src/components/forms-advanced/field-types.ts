import { isDecorationType, type HarnessFieldType, type RatingSubType } from '@line-crm/shared'

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
  // treasure-b1-palette: rating(入力)・signature(高度)・video(装飾) を additive。
  { type: 'rating', label: '評価', icon: '⭐', category: '入力' },
  { type: 'signature', label: '署名', icon: '✍️', category: '高度' },
  { type: 'section', label: '見出し＋説明', icon: '🔖', category: '装飾' },
  { type: 'page_break', label: '改ページ', icon: '➖', category: '装飾' },
  { type: 'video', label: '動画', icon: '🎬', category: '装飾' },
]

/**
 * rating の sub_type UI 露出リスト (treasure-b1-palette / picker が参照)。
 * embeded は pull 安全のため型は受理するが UI には出さない (4 種)。star = 既定 (UI は star 選択時 config.ratingSubType を undefined に写像)。
 */
export const RATING_SUB_TYPE_OPTIONS: { value: RatingSubType; label: string }[] = [
  { value: 'star', label: '星（5段階）' },
  { value: 'like_dislike', label: '良い / 悪い' },
  { value: 'nps', label: 'NPS（0〜10）' },
  { value: 'score', label: '点数' },
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
/**
 * 種別が「公開フォームで実効する最大文字数を設定できる」か。
 * 一行テキスト (short_text) のみ = Formaloo が max_length を hosted で enforce する唯一の型 (spike 実測 / OD-2)。
 * 複数行 (long_text) は Formaloo が max_length を無視するため対象外 (効かない欄=footgun を出さない)。
 */
export function hasMaxLength(type: HarnessFieldType): boolean {
  return type === 'text'
}
/** 種別が「評価スタイル(sub_type)を選べる」か (treasure-b1-palette / rating のみ)。 */
export function hasRatingSubType(type: HarnessFieldType): boolean {
  return type === 'rating'
}
