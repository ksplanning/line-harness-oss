import type { ColumnMapping, MappedRow } from './types'

/**
 * 見出し自動推定 + 論理列→FAQ 変換 (spec §共通の列 / §列マッピング)。
 */

// 各論理列の見出し推定キーワード (正規化後の完全一致 or 部分一致)。
const KEYWORDS: Record<keyof ColumnMapping, string[]> = {
  question: ['質問', 'question', 'q', 'お客さまの質問', 'お客様の質問', '問い', '質問文'],
  variants: ['言い換え', 'variants', 'variant', '別の言い方', 'エイリアス', 'alias', '別名', '言い方'],
  answer: ['答え', '回答', 'answer', 'a', '返答', '応答'],
  isActive: ['有効', 'active', '状態', 'isactive', '有効/無効', 'enabled'],
}

function normHeader(h: string): string {
  // 全角 ASCII → 半角、trim、小文字化 (mapping 用の軽量正規化)。
  return h
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .trim()
    .toLowerCase()
}

function matchLogical(header: string): keyof ColumnMapping | null {
  const h = normHeader(header)
  if (h === '') return null
  // 完全一致を優先、次に部分一致。question/answer の短縮 (q/a) は完全一致のみ。
  for (const key of ['question', 'variants', 'answer', 'isActive'] as const) {
    if (KEYWORDS[key].some((kw) => h === kw)) return key
  }
  for (const key of ['question', 'variants', 'answer', 'isActive'] as const) {
    // 短縮語 (q/a) の誤爆を避けるため部分一致は 2 文字以上のキーワードに限る。
    if (KEYWORDS[key].some((kw) => kw.length >= 2 && h.includes(kw))) return key
  }
  return null
}

export function autoDetectColumns(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = { question: null, variants: null, answer: null, isActive: null }
  headers.forEach((header, index) => {
    const logical = matchLogical(header)
    // 先勝ち: 既に割当済の論理列は上書きしない。
    if (logical && mapping[logical] === null) {
      mapping[logical] = index
    }
  })
  return mapping
}

/** 保存に進める条件: 質問・答えの両方が割当済。 */
export function isMappingComplete(mapping: ColumnMapping): boolean {
  return mapping.question !== null && mapping.answer !== null
}

// variants の区切り: 半角/全角カンマ・セミコロン・全角パイプ・読点。
const VARIANT_SPLIT = /[,;；｜、]/

function splitVariants(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(VARIANT_SPLIT)
    .map((v) => v.trim())
    .filter((v) => v !== '')
}

const TRUE_TOKENS = new Set(['有効', '1', 'true', 'on', 'yes', '○', 'はい'])
const FALSE_TOKENS = new Set(['無効', '0', 'false', 'off', 'no', '×', 'いいえ'])

function parseIsActive(raw: string | undefined): boolean | null {
  if (raw === undefined) return null
  const t = raw.trim().toLowerCase()
  if (t === '') return null
  if (TRUE_TOKENS.has(t)) return true
  if (FALSE_TOKENS.has(t)) return false
  return null // 判別不能は画面既定に委ねる
}

export interface ApplyMappingOptions {
  hasHeader: boolean
}

/**
 * grid (string[][]) を ColumnMapping に従って MappedRow[] に変換。
 * hasHeader:true のとき 1 行目 (見出し) をスキップし、sourceLine は 1 始まり。
 */
export function applyMapping(
  grid: string[][],
  mapping: ColumnMapping,
  options: ApplyMappingOptions,
): MappedRow[] {
  const dataRows = options.hasHeader ? grid.slice(1) : grid
  return dataRows.map((cells, i) => {
    const cell = (idx: number | null): string =>
      idx === null || idx === undefined ? '' : (cells[idx] ?? '')
    return {
      sourceLine: i + 1,
      question: cell(mapping.question).trim(),
      variants: splitVariants(mapping.variants === null ? undefined : cells[mapping.variants]),
      answer: cell(mapping.answer).trim(),
      isActive: parseIsActive(mapping.isActive === null ? undefined : cells[mapping.isActive]),
    }
  })
}
