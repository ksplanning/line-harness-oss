/**
 * FAQ 一括登録の共有型 (spec §共通の列 / plan §3)。
 */

/** マッピング先の論理列。 */
export type LogicalColumn = 'question' | 'variants' | 'answer' | 'isActive'

/** 見出し→論理列の割当。値は入力列の index (未割当は null)。 */
export interface ColumnMapping {
  question: number | null
  variants: number | null
  answer: number | null
  isActive: number | null
}

/** マッピング適用後の1行 (FAQ 候補)。 */
export interface MappedRow {
  /** 元ファイルでの行番号 (見出し行を除いた 1 始まり / プレビュー表示用)。 */
  sourceLine: number
  question: string
  variants: string[]
  answer: string
  /** 明示的な有効/無効 (「有効」列がある行のみ)。未指定は null = 画面既定に従う。 */
  isActive: boolean | null
}

/** 行検証の分類。 */
export type RowStatus = 'ok' | 'warning' | 'error' | 'duplicate'

export interface ValidatedRow extends MappedRow {
  status: RowStatus
  /** エラー/警告の日本語理由 (status='ok' のときは空)。 */
  reason: string
  /** 既存FAQ重複時に一致した既存 FAQ の id。 */
  existingFaqId?: string
}
