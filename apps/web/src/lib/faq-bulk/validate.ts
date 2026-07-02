import { normalizeQuestion } from './normalize'
import type { MappedRow, ValidatedRow } from './types'

/**
 * 行検証 (spec §列マッピング/プレビュー/検証)。
 *
 * 分類:
 *  - error: 質問/答えが空・長さ超過 (その行は保存対象外)
 *  - duplicate: 既存FAQ の question と正規化一致 (行ごとにスキップ/上書き選択)
 *  - warning: ファイル内重複を後勝ちで集約したときの「捨てた側」(スキップ計上)
 *  - ok: 上記いずれでもない登録可能行
 *
 * ファイル内重複は spec §独立レビュー #7 に従い「後勝ちで1件に集約」:
 *   同一 question (正規化後) が複数あれば最後の行のみ残し、先行行は warning。
 *   エラー行は集約の対象にしない (空/長さNGは重複判定より前に確定)。
 */

export const QUESTION_MAX = 400
export const ANSWER_MAX = 2000

export interface ExistingFaqRef {
  id: string
  question: string
}

export function validateRows(
  rows: MappedRow[],
  existingFaqs: ExistingFaqRef[],
): ValidatedRow[] {
  // 既存FAQ の正規化 question → id の索引。
  const existingByKey = new Map<string, string>()
  for (const f of existingFaqs) {
    const key = normalizeQuestion(f.question)
    if (key !== '' && !existingByKey.has(key)) existingByKey.set(key, f.id)
  }

  // 第1パス: 各行を error / (非error) に分類。
  const base: ValidatedRow[] = rows.map((r) => {
    const q = r.question.trim()
    const a = r.answer.trim()
    if (q === '') return mark(r, 'error', '質問が空です')
    if (a === '') return mark(r, 'error', '答えが空です')
    if (q.length > QUESTION_MAX) return mark(r, 'error', `質問が長すぎます（${QUESTION_MAX}文字まで）`)
    if (a.length > ANSWER_MAX) return mark(r, 'error', `答えが長すぎます（${ANSWER_MAX}文字まで）`)
    return mark(r, 'ok', '')
  })

  // 第2パス: 非error 行のファイル内重複を後勝ち集約。
  // 各 key について「最後に現れた非error 行の index」を採用行とする。
  const lastIndexByKey = new Map<string, number>()
  base.forEach((row, idx) => {
    if (row.status === 'error') return
    const key = normalizeQuestion(row.question)
    if (key === '') return
    lastIndexByKey.set(key, idx)
  })

  const result = base.map((row, idx) => {
    if (row.status === 'error') return row
    const key = normalizeQuestion(row.question)
    if (key === '') return row
    const winnerIdx = lastIndexByKey.get(key)
    if (winnerIdx !== undefined && winnerIdx !== idx) {
      // 後勝ちで捨てられる側 → warning (スキップ計上)。
      return { ...row, status: 'warning' as const, reason: 'ファイル内で質問が重複しています（後の行を採用）' }
    }
    // 採用行 (最後の1件) → 既存FAQ 重複判定。
    const existingId = existingByKey.get(key)
    if (existingId !== undefined) {
      return { ...row, status: 'duplicate' as const, reason: '既にある質問です', existingFaqId: existingId }
    }
    return row
  })

  return result
}

function mark(r: MappedRow, status: ValidatedRow['status'], reason: string): ValidatedRow {
  return { ...r, status, reason }
}
