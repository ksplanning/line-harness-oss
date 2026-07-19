import { isDecorationType, DEFAULT_RATING_STAR_COLOR, type HarnessFieldType, type RatingSubType, type ImageWidth, type VariableSubType } from '@line-crm/shared'

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
  { type: 'choice_fetch', label: '動的選択肢', icon: '🔄', category: '選択' },
  { type: 'file', label: 'ファイル添付', icon: '📎', category: '高度' },
  { type: 'variable', label: '計算', icon: '🧮', category: '高度' },
  // treasure-b1-palette: rating(入力)・signature(高度)・video(装飾) を additive。
  { type: 'rating', label: '評価', icon: '⭐', category: '入力' },
  { type: 'signature', label: '署名', icon: '✍️', category: '高度' },
  { type: 'section', label: '見出し＋説明', icon: '🔖', category: '装飾' },
  { type: 'page_break', label: '改ページ', icon: '➖', category: '装飾' },
  { type: 'video', label: '動画', icon: '🎬', category: '装飾' },
  // form-image-decoration: 差し込み画像 (フォーム途中の画像 / 先頭に置けば帯ヘッダーにもなる)。additive。
  { type: 'image', label: '画像', icon: '🖼️', category: '装飾' },
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

/** Formaloo variable field で実測済みの sub_type 4 種。 */
export const VARIABLE_SUB_TYPE_OPTIONS: { value: VariableSubType; label: string }[] = [
  { value: 'int', label: '整数（計算しない値）' },
  { value: 'string', label: '文字（計算しない値）' },
  { value: 'decimal', label: '小数（計算しない値）' },
  { value: 'formula', label: '計算式' },
]

/**
 * b1-field-polish: video(oembed) の表示サイズ preset (小/中/大→高さ px)。builder の per-field 動画サイズ select が参照。
 * 全 preset が再生可能サイズ (既定 100px 薄帯より大)。値は videoHeight whitelist (/^\d{2,4}(px|vw)$/) を満たす。
 * 未選択 (空) は push 時 DEFAULT_VIDEO_HEIGHT (250px) を補完 = builder は「（既定）」表示。
 */
export const VIDEO_SIZE_PRESETS: { value: string; label: string }[] = [
  { value: '200px', label: '小' },
  { value: '280px', label: '中' },
  { value: '400px', label: '大' },
]

/**
 * form-image-decoration: 差し込み画像の表示幅プリセット (小40%/中70%/全幅100% / owner ②「ストレス無く」)。
 * image-field-panel の幅 picker が参照。値は shared ImageWidth enum → canonical <img> の max-width % に射影
 * (spike S-1 実測: max-width % が hosted で効く = スマホでも親コンテナ相対で破綻しない)。既定 medium。
 */
export const IMAGE_WIDTH_OPTIONS: { value: ImageWidth; label: string }[] = [
  { value: 'small', label: '小（40%）' },
  { value: 'medium', label: '中（70%）' },
  { value: 'full', label: '全幅（100%）' },
]

/**
 * b1-field-polish: 評価スター色の curated パレット (form-level 星色 picker が参照)。先頭 = 既定黄 (単一正本)。
 * 各色は白地/黒地の両方で視認可能なレンジに curated (相対輝度 40〜230 = コントラスト保証 / R3)。
 */
export const RATING_STAR_PALETTE: { value: string; label: string }[] = [
  { value: DEFAULT_RATING_STAR_COLOR, label: '黄' }, // #F5B301 (既定)
  { value: '#E39A00', label: '金' },
  { value: '#FB8C00', label: '橙' },
  { value: '#E53935', label: '赤' },
  { value: '#EC407A', label: '桃' },
  { value: '#3B82F6', label: '青' },
  { value: '#22C55E', label: '緑' },
  { value: '#8B5CF6', label: '紫' },
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
