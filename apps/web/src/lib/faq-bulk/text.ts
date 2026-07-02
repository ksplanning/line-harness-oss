/**
 * 貼り付けテキストのパース (spec §形式3 テキスト貼り付け)。
 *
 * 2 モードを自動判定:
 *  - Q&A: `Q: 質問` の次行に `A: 答え` (半角/全角コロン・「質問:」「答え:」別表記も許容)。
 *         空行区切りで複数 FAQ。答えが複数行のときは A: 以降〜次の Q: までを答えにする。
 *  - TSV: Excel からセルをコピペすると \t 区切り + \n 行区切り。CSV と同じ列マッピングに流す。
 *
 * 判定: タブを含む行が過半 → TSV / `Q:`/`A:` パターンを含む → Q&A。
 */
export type PastedMode = 'qa' | 'tsv' | 'empty'

export interface QaRow {
  question: string
  answer: string
}

export interface PastedResult {
  mode: PastedMode
  rows?: QaRow[]
  grid?: string[][]
}

// 質問マーカー: Q / q / 質問 の後に半角/全角コロン
const Q_MARK = /^(?:[Qq]|質問)\s*[:：]\s*(.*)$/
const A_MARK = /^(?:[Aa]|答え|回答)\s*[:：]\s*(.*)$/

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
}

function looksLikeTsv(lines: string[]): boolean {
  const nonEmpty = lines.filter((l) => l.trim() !== '')
  if (nonEmpty.length === 0) return false
  const withTab = nonEmpty.filter((l) => l.includes('\t')).length
  return withTab * 2 > nonEmpty.length // 過半
}

function hasQaMarkers(lines: string[]): boolean {
  return lines.some((l) => Q_MARK.test(l.trim())) && lines.some((l) => A_MARK.test(l.trim()))
}

function parseTsv(lines: string[]): string[][] {
  return lines
    .filter((l) => l.trim() !== '')
    .map((l) => l.split('\t'))
}

function parseQa(lines: string[]): QaRow[] {
  const rows: QaRow[] = []
  let i = 0
  const n = lines.length
  while (i < n) {
    const line = lines[i].trim()
    const qm = line.match(Q_MARK)
    if (!qm) {
      i++
      continue
    }
    const question = qm[1].trim()
    // 次の A: を探す
    i++
    while (i < n && !A_MARK.test(lines[i].trim())) i++
    if (i >= n) break // A: が無いまま終端
    const am = lines[i].trim().match(A_MARK)!
    const answerLines: string[] = [am[1]]
    i++
    // A: 以降、次の Q: まで (空行含めて) を答えとする
    while (i < n && !Q_MARK.test(lines[i].trim())) {
      answerLines.push(lines[i])
      i++
    }
    // 複数行の答えを保持しつつ、前後の空行/空白のみ除去。
    const answer = answerLines.join('\n').trim()
    rows.push({ question, answer })
  }
  return rows
}

export function parsePastedText(text: string): PastedResult {
  const lines = splitLines(text)
  const nonEmpty = lines.filter((l) => l.trim() !== '')
  if (nonEmpty.length === 0) return { mode: 'empty', rows: [], grid: [] }

  if (looksLikeTsv(lines)) {
    return { mode: 'tsv', grid: parseTsv(lines) }
  }
  if (hasQaMarkers(lines)) {
    return { mode: 'qa', rows: parseQa(lines) }
  }
  // フォールバック: タブが無くマーカーも無い → TSV (1列) として扱い列マッピングへ委ねる
  return { mode: 'tsv', grid: parseTsv(lines) }
}
