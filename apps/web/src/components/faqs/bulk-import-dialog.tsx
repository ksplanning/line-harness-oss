'use client'

import { useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/api'
import { decodeCsvBuffer, EncodingDetectionError } from '@/lib/faq-bulk/encoding'
import { parseCsv } from '@/lib/faq-bulk/csv'
import { parsePastedText } from '@/lib/faq-bulk/text'
import { autoDetectColumns, isMappingComplete, applyMapping } from '@/lib/faq-bulk/mapping'
import { validateRows, type ExistingFaqRef } from '@/lib/faq-bulk/validate'
import { downloadCsvTemplate, downloadXlsxTemplate } from '@/lib/faq-bulk/template'
import type { ColumnMapping, MappedRow, ValidatedRow } from '@/lib/faq-bulk/types'

interface ExistingFaq {
  id: string
  lineAccountId: string | null
  question: string
}

interface Props {
  selectedAccountId: string | null
  existingFaqs: ExistingFaq[]
  onClose: () => void
  onImported: () => void
}

type Step = 'input' | 'mapping' | 'preview' | 'result'

const MAX_ROWS = 500
const MAX_BYTES = 2 * 1024 * 1024 // 2MB
const PREVIEW_LIMIT = 50

interface BulkResultSummary {
  created: number
  updated: number
  skipped: number
  errors: number
  errorLines: Array<{ line: number; reason: string }>
}

// 重複行ごとのユーザー選択 (spec §重複時の動作)。
type DupChoice = 'skip' | 'overwrite'

export default function BulkImportDialog({ selectedAccountId, existingFaqs, onClose, onImported }: Props) {
  const [step, setStep] = useState<Step>('input')
  const [saving, setSaving] = useState(false)
  const [parsing, setParsing] = useState(false)
  const [error, setError] = useState('')

  // 入力
  const [file, setFile] = useState<File | null>(null)
  const [pasted, setPasted] = useState('')

  // パース結果
  const [grid, setGrid] = useState<string[][] | null>(null) // 見出しあり (CSV/Excel/TSV)
  const [hasHeader, setHasHeader] = useState(true)
  const [qaRows, setQaRows] = useState<MappedRow[] | null>(null) // Q&A 形式 (mapping skip)
  const [mapping, setMapping] = useState<ColumnMapping>({ question: null, variants: null, answer: null, isActive: null })

  // 検証結果
  const [validated, setValidated] = useState<ValidatedRow[]>([])
  const [dupChoices, setDupChoices] = useState<Record<number, DupChoice>>({}) // key = validated index
  const [defaultActive, setDefaultActive] = useState(true)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [global, setGlobal] = useState(false)

  // 結果
  const [summary, setSummary] = useState<BulkResultSummary | null>(null)

  const scopeAccountId = global ? null : selectedAccountId

  // 重複突合に使う既存FAQ (reviewer R1-I1)。
  // 「上書き」は同一スコープの既存FAQ に対してのみ許可される (サーバ D-18: overwriteId の
  // line_account_id が body の lineAccountId と一致しないと error)。よって duplicate マーク
  // (=スキップ/上書き選択) は **同一スコープの既存FAQ のみ**を対象にする。
  // 別スコープ (例: 選択中アカウントへの取込 vs 全アカ共通の既存FAQ) で question が同じでも、
  // その行は overwrite 不可なので duplicate にせず create として送る → サーバが安全に skip する
  // (getFaqs(account) は NULL+一致を返し create 重複を skip 計上)。UI は上書き選択肢を出さない。
  const existingRefs: ExistingFaqRef[] = useMemo(() => {
    return existingFaqs
      .filter((f) => f.lineAccountId === scopeAccountId)
      .map((f) => ({ id: f.id, question: f.question }))
  }, [existingFaqs, scopeAccountId])

  const isDirty = file !== null || pasted.trim() !== '' || step !== 'input'

  const requestClose = () => {
    if (saving) return
    if (step === 'result') { onClose(); return } // 結果表示後は破棄確認なしで閉じる
    if (isDirty && !window.confirm('入力内容を破棄しますか？')) return
    onClose()
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saving, step, file, pasted])

  // ── ファイルパース ──────────────────────────────────────────────
  const handleFileChosen = (f: File | null) => {
    setError('')
    if (!f) { setFile(null); return }
    if (f.size > MAX_BYTES) {
      setError('ファイルが大きすぎます（上限2MBまで）。ファイルを分けてください。')
      setFile(null)
      return
    }
    setFile(f)
  }

  const proceedFromFile = async () => {
    if (!file) return
    setError('')
    setParsing(true)
    try {
      const name = file.name.toLowerCase()
      if (name.endsWith('.xlsx')) {
        const { parseXlsxFile } = await import('@/lib/faq-bulk/xlsx')
        const g = await parseXlsxFile(file)
        finishGrid(g)
      } else {
        // CSV (or 拡張子不問でテキスト系) — 文字コード判定してデコード。
        const buf = await file.arrayBuffer()
        const { text } = decodeCsvBuffer(buf)
        const g = parseCsv(text)
        finishGrid(g)
      }
    } catch (e) {
      if (e instanceof EncodingDetectionError) {
        setError('文字コードを判別できませんでした。UTF-8 か Shift_JIS で保存し直してください。')
      } else {
        setError('ファイルを読み取れませんでした。エクセルかCSVで保存し直してください。')
      }
    } finally {
      setParsing(false)
    }
  }

  const proceedFromPaste = () => {
    setError('')
    setParsing(true)
    try {
      const parsed = parsePastedText(pasted)
      if (parsed.mode === 'empty') {
        setError('内容が空です。質問と答えを入力してください。')
        return
      }
      if (parsed.mode === 'qa') {
        const rows: MappedRow[] = (parsed.rows ?? []).map((r, i) => ({
          sourceLine: i + 1,
          question: r.question,
          variants: [],
          answer: r.answer,
          isActive: null,
        }))
        if (rows.length > MAX_ROWS) {
          setError('一度に登録できるのは500件までです。ファイルを分けてください。')
          return
        }
        setQaRows(rows)
        setGrid(null)
        goPreviewFromRows(rows)
        return
      }
      // TSV
      finishGrid(parsed.grid ?? [])
    } catch {
      setError('内容を読み取れませんでした。書き方を見直してください。')
    } finally {
      setParsing(false)
    }
  }

  const finishGrid = (g: string[][]) => {
    const trimmed = g.filter((row) => row.some((c) => (c ?? '').trim() !== ''))
    if (trimmed.length === 0) {
      setError('内容が空です。質問と答えを入力してください。')
      return
    }
    // 見出し推定を先に行う。見出しが1つも当たらなければ「見出しなし」= 全行がデータ行。
    const auto = autoDetectColumns(trimmed[0] ?? [])
    const anyMatched = auto.question !== null || auto.answer !== null || auto.variants !== null || auto.isActive !== null
    // reviewer R1-I2: 行数上限は「実際に登録されるデータ行数」で判定する。
    // 見出しありなら -1、見出しなしなら全行がデータ。ヘッダ有無に依らず client 側で弾き、
    // ヘッダ無し501行が server 400 で late 失敗するのを防ぐ。
    const dataRowCount = anyMatched ? trimmed.length - 1 : trimmed.length
    if (dataRowCount > MAX_ROWS) {
      setError('一度に登録できるのは500件までです。ファイルを分けてください。')
      return
    }
    setGrid(trimmed)
    setQaRows(null)
    setHasHeader(anyMatched)
    setMapping(anyMatched ? auto : { question: 0, variants: null, answer: 1, isActive: null })
    setStep('mapping')
  }

  const goPreviewFromRows = (rows: MappedRow[]) => {
    const v = validateRows(rows, existingRefs)
    setValidated(v)
    // 重複行の既定選択 = スキップ (安全側)。
    const init: Record<number, DupChoice> = {}
    v.forEach((r, i) => { if (r.status === 'duplicate') init[i] = 'skip' })
    setDupChoices(init)
    setStep('preview')
  }

  const applyMappingAndPreview = () => {
    if (!grid) return
    if (!isMappingComplete(mapping)) {
      setError('「質問」と「答え」の列を選んでください')
      return
    }
    setError('')
    const rows = applyMapping(grid, mapping, { hasHeader })
    goPreviewFromRows(rows)
  }

  // ── 一括保存 ───────────────────────────────────────────────────
  const savableCount = validated.filter((r) => {
    if (r.status === 'ok') return true
    if (r.status === 'duplicate') return true // スキップ/上書き どちらも「処理対象」
    return false
  }).length

  const handleSave = async () => {
    setSaving(true)
    setError('')
    try {
      // items 構築: ok=create / duplicate=選択(skip は送らない・overwrite は送る)。
      const items: Array<{
        question: string; variants?: string[]; answer: string; isActive?: boolean
        mode?: 'create' | 'overwrite'; overwriteId?: string
      }> = []
      // UI 側でスキップした重複件数 (サーバへ送らない分)。
      let uiSkipped = 0
      validated.forEach((r, i) => {
        if (r.status === 'error') return
        if (r.status === 'warning') { uiSkipped++; return } // ファイル内重複で集約された行
        const isActive = r.isActive === null ? defaultActive : r.isActive
        if (r.status === 'duplicate') {
          const choice = dupChoices[i] ?? 'skip'
          if (choice === 'skip') { uiSkipped++; return }
          items.push({
            question: r.question,
            variants: r.variants,
            answer: r.answer,
            isActive,
            mode: 'overwrite',
            overwriteId: r.existingFaqId,
          })
          return
        }
        items.push({ question: r.question, variants: r.variants, answer: r.answer, isActive, mode: 'create' })
      })

      if (items.length === 0) {
        // 全部スキップ or エラー → 登録なしで結果表示。
        setSummary({ created: 0, updated: 0, skipped: uiSkipped, errors: validated.filter((r) => r.status === 'error').length, errorLines: errorLines() })
        setStep('result')
        return
      }

      const res = await api.faqs.bulk({ lineAccountId: scopeAccountId, items })
      if (!res.success) {
        setError('登録に失敗しました。時間をおいて、もう一度お試しください。')
        return
      }
      const d = res.data
      // サーバの errors + UI エラー行 + サーバの skipped + UI スキップ。
      const errLines = errorLines()
      // サーバ側 error の行番号は items index ベース → 元行番号に変換しにくいので理由だけ集約。
      d.results.filter((r) => r.status === 'error').forEach((r) => {
        errLines.push({ line: 0, reason: r.error ?? '登録に失敗しました' })
      })
      setSummary({
        created: d.created,
        updated: d.updated,
        skipped: d.skipped + uiSkipped,
        errors: validated.filter((r) => r.status === 'error').length + d.errors,
        errorLines: errLines,
      })
      setStep('result')
    } catch {
      setError('登録に失敗しました。時間をおいて、もう一度お試しください。')
    } finally {
      setSaving(false)
    }
  }

  const errorLines = (): Array<{ line: number; reason: string }> =>
    validated.filter((r) => r.status === 'error').map((r) => ({ line: r.sourceLine, reason: r.reason }))

  // 集計 (プレビュー上部サマリ)。
  const counts = useMemo(() => {
    let ok = 0, warn = 0, err = 0, dup = 0
    for (const r of validated) {
      if (r.status === 'ok') ok++
      else if (r.status === 'warning') warn++
      else if (r.status === 'error') err++
      else if (r.status === 'duplicate') dup++
    }
    return { ok, warn, err, dup, total: validated.length }
  }, [validated])

  const setAllDupChoice = (choice: DupChoice) => {
    const next: Record<number, DupChoice> = { ...dupChoices }
    validated.forEach((r, i) => { if (r.status === 'duplicate') next[i] = choice })
    setDupChoices(next)
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        {/* ヘッダ (edit-dialog 流儀) */}
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h3 className="text-base font-semibold text-gray-900">質問をまとめて登録</h3>
          <button
            type="button"
            onClick={requestClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
            aria-label="閉じる"
          >
            ×
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* ステップ表示 (控えめなパンくず) */}
          <StepBreadcrumb step={step} qaMode={qaRows !== null} />

          {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</p>}

          {step === 'input' && (
            <InputStep
              file={file}
              pasted={pasted}
              parsing={parsing}
              onFileChosen={handleFileChosen}
              onPasteChange={setPasted}
              defaultActive={defaultActive}
              onDefaultActiveChange={setDefaultActive}
              advancedOpen={advancedOpen}
              onToggleAdvanced={() => setAdvancedOpen((v) => !v)}
              global={global}
              onGlobalChange={setGlobal}
            />
          )}

          {step === 'mapping' && grid && (
            <MappingStep
              headers={hasHeader ? (grid[0] ?? []) : (grid[0] ?? []).map((_, i) => `${i + 1}列目`)}
              mapping={mapping}
              onMappingChange={setMapping}
            />
          )}

          {step === 'preview' && (
            <PreviewStep
              validated={validated}
              counts={counts}
              dupChoices={dupChoices}
              onDupChoice={(i, c) => setDupChoices((prev) => ({ ...prev, [i]: c }))}
              onSetAll={setAllDupChoice}
            />
          )}

          {step === 'result' && summary && <ResultStep summary={summary} />}
        </div>

        {/* footer (sticky / ステップでボタン変化) */}
        <div className="sticky bottom-0 px-5 py-3 border-t bg-white flex gap-2 justify-end">
          {step === 'input' && (
            <>
              <button onClick={requestClose} className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md">キャンセル</button>
              <button
                onClick={file ? proceedFromFile : proceedFromPaste}
                disabled={parsing || (!file && pasted.trim() === '')}
                className="px-3 py-1.5 text-xs font-medium text-white rounded-md disabled:opacity-50"
                style={{ backgroundColor: '#06C755' }}
              >
                {parsing ? '読み込んでいます...' : '次へ（内容を確認）'}
              </button>
            </>
          )}
          {step === 'mapping' && (
            <>
              <button onClick={() => setStep('input')} className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md">戻る</button>
              <button
                onClick={applyMappingAndPreview}
                disabled={!isMappingComplete(mapping)}
                className="px-3 py-1.5 text-xs font-medium text-white rounded-md disabled:opacity-50"
                style={{ backgroundColor: '#06C755' }}
              >
                次へ（内容を確認）
              </button>
            </>
          )}
          {step === 'preview' && (
            <>
              <button
                onClick={() => setStep(qaRows ? 'input' : 'mapping')}
                className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md"
              >
                戻る
              </button>
              <button
                onClick={handleSave}
                disabled={saving || savableCount === 0}
                className="px-3 py-1.5 text-xs font-medium text-white rounded-md disabled:opacity-50"
                style={{ backgroundColor: '#06C755' }}
              >
                {saving ? '登録しています...' : 'この内容で登録する'}
              </button>
            </>
          )}
          {step === 'result' && (
            <button
              onClick={() => { onImported() }}
              className="px-3 py-1.5 text-xs font-medium text-white rounded-md"
              style={{ backgroundColor: '#06C755' }}
            >
              閉じる
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── パンくず ────────────────────────────────────────────────────
function StepBreadcrumb({ step, qaMode }: { step: Step; qaMode: boolean }) {
  const items: Array<{ key: Step; label: string; dim?: boolean }> = [
    { key: 'input', label: '① 用意' },
    { key: 'mapping', label: '② 列の割り当て', dim: qaMode },
    { key: 'preview', label: '③ 確認' },
    { key: 'result', label: '④ 完了' },
  ]
  return (
    <div className="flex items-center gap-2 text-xs">
      {items.map((it, i) => (
        <span key={it.key} className="flex items-center gap-2">
          <span className={
            step === it.key ? 'text-gray-900 font-semibold'
            : it.dim ? 'text-gray-300'
            : 'text-gray-500'
          }>
            {it.label}
          </span>
          {i < items.length - 1 && <span className="text-gray-300">→</span>}
        </span>
      ))}
    </div>
  )
}

// ── ステップ① 入力 ─────────────────────────────────────────────
function InputStep(props: {
  file: File | null
  pasted: string
  parsing: boolean
  onFileChosen: (f: File | null) => void
  onPasteChange: (v: string) => void
  defaultActive: boolean
  onDefaultActiveChange: (v: boolean) => void
  advancedOpen: boolean
  onToggleAdvanced: () => void
  global: boolean
  onGlobalChange: (v: boolean) => void
}) {
  return (
    <div className="space-y-4">
      <div className="bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-800 leading-relaxed p-3">
        質問と答えをまとめて書いたファイル（エクセル・CSV）か、文章を貼り付けて、一度にたくさん登録できます。
        まず下の見本をダウンロードして、そこに書き込むのが確実です。
      </div>

      {/* テンプレDL */}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => { void downloadXlsxTemplate() }}
          className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
        >
          エクセルの見本をダウンロード
        </button>
        <button
          type="button"
          onClick={() => downloadCsvTemplate()}
          className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
        >
          CSVの見本をダウンロード
        </button>
      </div>
      <p className="text-[11px] text-gray-500 -mt-2">
        見本には「質問・言い換え・答え・有効」の列が入っています。エクセルで開いて、そこに書き込んで保存してください。
      </p>

      {/* ファイルを選ぶ */}
      <div>
        <label className="block text-xs text-gray-600 mb-1">ファイルを選ぶ</label>
        <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center">
          <p className="text-xs text-gray-500 mb-2">エクセル(.xlsx)かCSVファイルを選んでください</p>
          <input
            type="file"
            accept=".csv,.xlsx"
            onChange={(e) => props.onFileChosen(e.target.files?.[0] ?? null)}
            className="block mx-auto text-xs text-gray-600 file:mr-3 file:px-3 file:py-1.5 file:rounded-md file:border file:border-gray-300 file:bg-white file:text-xs file:font-medium file:text-gray-700 hover:file:bg-gray-50"
          />
          {props.file && (
            <p className="mt-2 text-xs text-gray-700">{props.file.name}（{Math.ceil(props.file.size / 1024)} KB）</p>
          )}
        </div>
        <div className="mt-2 bg-amber-50 border border-amber-200 rounded-md text-amber-800 text-xs p-2">
          ※ エクセルで作ったCSVで文字が化けることがありますが、こちらで自動で直します。そのままアップして大丈夫です。
        </div>
      </div>

      {/* 文章を貼り付ける */}
      <div>
        <label className="block text-xs text-gray-600 mb-1">または、文章を貼り付ける</label>
        <textarea
          rows={6}
          value={props.pasted}
          onChange={(e) => props.onPasteChange(e.target.value)}
          className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-y font-mono"
          placeholder={'Q: 営業時間は？\nA: 平日は10時〜19時です。\n\nQ: 駐車場はありますか？\nA: 店の裏に3台分あります。'}
        />
        <p className="mt-1 text-[11px] text-gray-500">
          「Q:」で質問、「A:」で答え、を1組にして書きます。エクセルからコピーして貼り付けても大丈夫です（自動で見分けます）。
        </p>
      </div>

      {/* isActive 既定 + 安全動線 */}
      <div className="bg-white border border-gray-200 rounded-lg p-3">
        <p className="text-xs text-gray-700 font-medium mb-2">登録した質問を…</p>
        <div className="mb-2 bg-amber-50 border border-amber-200 rounded-md text-amber-800 text-xs p-2">
          はじめは「無効」で入れて、内容を確認してから有効にすると安心です。
        </div>
        <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer mb-1">
          <input type="radio" name="bulk-active" checked={props.defaultActive} onChange={() => props.onDefaultActiveChange(true)} className="text-green-600 focus:ring-green-500" />
          すぐに使えるようにする（有効）
        </label>
        <label className="flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
          <input type="radio" name="bulk-active" checked={!props.defaultActive} onChange={() => props.onDefaultActiveChange(false)} className="text-green-600 focus:ring-green-500" />
          まず「無効」で入れて、確認してから使う
        </label>
        <p className="mt-2 text-[11px] text-gray-500">ファイルに「有効／無効」の列があれば、その行はそちらを優先します。</p>
      </div>

      {/* 全アカ共通 (上級) */}
      <div>
        <button type="button" onClick={props.onToggleAdvanced} className="text-xs text-gray-500 hover:text-gray-700">
          {props.advancedOpen ? '▾' : '▸'} このアカウント以外でも使う（上級者向け）
        </button>
        {props.advancedOpen && (
          <label className="mt-2 flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
            <input type="checkbox" checked={props.global} onChange={(e) => props.onGlobalChange(e.target.checked)} className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500" />
            全アカ共通にする
          </label>
        )}
      </div>
    </div>
  )
}

// ── ステップ② 列の割り当て ─────────────────────────────────────
function MappingStep({ headers, mapping, onMappingChange }: {
  headers: string[]
  mapping: ColumnMapping
  onMappingChange: (m: ColumnMapping) => void
}) {
  const options = headers.map((h, i) => ({ value: i, label: h || `${i + 1}列目` }))
  const set = (key: keyof ColumnMapping, value: number | null) => onMappingChange({ ...mapping, [key]: value })
  const rows: Array<{ key: keyof ColumnMapping; label: string; required: boolean }> = [
    { key: 'question', label: '「質問」の列', required: true },
    { key: 'variants', label: '「言い換え」の列', required: false },
    { key: 'answer', label: '「答え」の列', required: true },
    { key: 'isActive', label: '「有効／無効」の列', required: false },
  ]
  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-600">どの列がどれにあたるか、選んでください。（自動で選んだものはそのままでOKです）</p>
      {rows.map(({ key, label, required }) => (
        <div key={key}>
          <label className="block text-xs text-gray-600 mb-1">
            {label}{required && <span className="text-rose-600"> ※必須</span>}
          </label>
          <select
            value={mapping[key] === null ? '' : String(mapping[key])}
            onChange={(e) => set(key, e.target.value === '' ? null : Number(e.target.value))}
            className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          >
            <option value="">（なし）</option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      ))}
      {(mapping.question === null || mapping.answer === null) && (
        <p className="text-xs text-rose-600">「質問」と「答え」の列を選んでください</p>
      )}
    </div>
  )
}

// ── ステップ③ 確認 (プレビュー + 検証) ─────────────────────────
function PreviewStep({ validated, counts, dupChoices, onDupChoice, onSetAll }: {
  validated: ValidatedRow[]
  counts: { ok: number; warn: number; err: number; dup: number; total: number }
  dupChoices: Record<number, DupChoice>
  onDupChoice: (i: number, c: DupChoice) => void
  onSetAll: (c: DupChoice) => void
}) {
  const visible = validated.slice(0, PREVIEW_LIMIT)
  const rest = validated.length - visible.length
  const hasDup = counts.dup > 0
  return (
    <div className="space-y-3">
      {/* サマリバナー */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg text-xs p-3">
        全 {counts.total} 件のうち：
        <span className="text-green-700 font-semibold"> 登録OK {counts.ok}件</span> ／
        <span className="text-amber-700 font-semibold"> 注意 {counts.warn}件</span> ／
        <span className="text-rose-600 font-semibold"> 登録できない {counts.err}件</span> ／
        <span className="text-blue-700 font-semibold"> 既にある質問 {counts.dup}件</span>
      </div>

      {hasDup && (
        <div className="flex items-center gap-3 text-xs">
          <span className="text-gray-500">同じ質問がすでにある行：</span>
          <button onClick={() => onSetAll('skip')} className="text-gray-500 hover:text-gray-700 underline">すべてスキップ</button>
          <button onClick={() => onSetAll('overwrite')} className="text-gray-500 hover:text-gray-700 underline">すべて上書き</button>
        </div>
      )}

      <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
        <div className="overflow-x-auto max-h-[40vh]">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500">状態</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500">質問</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500">答え</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500">有効</th>
                <th className="px-3 py-2 text-left text-xs font-semibold text-gray-500">どうする</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {visible.map((r, i) => (
                <tr key={i} className={r.status === 'error' ? 'bg-rose-50' : 'hover:bg-gray-50'}>
                  <td className="px-3 py-2 align-top">
                    <StatusBadge status={r.status} />
                    {(r.status === 'error' || r.status === 'warning') && r.reason && (
                      <p className={`mt-1 text-[11px] ${r.status === 'error' ? 'text-rose-600' : 'text-amber-700'}`}>{r.reason}</p>
                    )}
                  </td>
                  <td className="px-3 py-2 text-sm font-medium text-gray-900 align-top">
                    <span className="block truncate max-w-[220px]" title={r.question}>{r.question || '（空）'}</span>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <span className="block truncate max-w-[240px] text-xs text-gray-600" title={r.answer}>{r.answer || '（空）'}</span>
                  </td>
                  <td className="px-3 py-2 align-top">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${r.isActive === false ? 'bg-gray-100 text-gray-500' : 'bg-green-100 text-green-700'}`}>
                      {r.isActive === false ? '無効' : r.isActive === true ? '有効' : '既定'}
                    </span>
                  </td>
                  <td className="px-3 py-2 align-top">
                    {r.status === 'duplicate' ? (
                      <div className="inline-flex gap-1">
                        {(['skip', 'overwrite'] as const).map((c) => {
                          const selected = (dupChoices[validated.indexOf(r)] ?? 'skip') === c
                          return (
                            <button
                              key={c}
                              onClick={() => onDupChoice(validated.indexOf(r), c)}
                              className={`px-2 py-0.5 text-[11px] rounded-md border ${selected ? 'text-white border-transparent' : 'text-gray-600 bg-white border-gray-300 hover:bg-gray-50'}`}
                              style={selected ? { backgroundColor: '#06C755' } : undefined}
                            >
                              {c === 'skip' ? 'スキップ' : '上書き'}
                            </button>
                          )
                        })}
                      </div>
                    ) : (
                      <span className="text-gray-300 text-xs">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rest > 0 && (
          <div className="px-3 py-2 text-center text-xs text-gray-400 border-t border-gray-100">他 {rest} 行</div>
        )}
      </div>

      {hasDup && (
        <p className="text-[11px] text-gray-500">
          同じ質問がすでにあります。「スキップ」は今のまま残します。「上書き」は答えを新しいものに書き換えます。
        </p>
      )}
      {counts.ok + counts.dup === 0 && (
        <p className="text-xs text-rose-600 bg-rose-50 border border-rose-200 rounded-md px-3 py-2">
          登録できる行がありません。ファイルを見直してください。
        </p>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: ValidatedRow['status'] }) {
  const map = {
    ok: { cls: 'bg-green-100 text-green-700', label: '登録OK' },
    warning: { cls: 'bg-amber-100 text-amber-700', label: '注意' },
    error: { cls: 'bg-rose-100 text-rose-600', label: '登録できません' },
    duplicate: { cls: 'bg-blue-100 text-blue-700', label: '既にある質問' },
  }[status]
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${map.cls}`}>{map.label}</span>
}

// ── ステップ④ 完了 ─────────────────────────────────────────────
function ResultStep({ summary }: { summary: BulkResultSummary }) {
  const [openErrors, setOpenErrors] = useState(false)
  return (
    <div className="text-center py-4">
      <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-green-100">
        <svg className="h-6 w-6 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>
      <h4 className="text-base font-semibold text-gray-900">登録が終わりました</h4>
      <p className="mt-2 text-sm text-gray-700">
        <span className="text-green-700 font-semibold">追加 {summary.created} 件</span> ／
        <span className="text-blue-700 font-semibold"> 上書き {summary.updated} 件</span> ／
        <span className="text-gray-500 font-semibold"> スキップ {summary.skipped} 件</span> ／
        <span className="text-rose-600 font-semibold"> 登録できなかった {summary.errors} 件</span>
      </p>
      {summary.errorLines.length > 0 && (
        <div className="mt-4 text-left">
          <button onClick={() => setOpenErrors((v) => !v)} className="text-xs text-gray-500 hover:text-gray-700">
            {openErrors ? '▾' : '▸'} 登録できなかった行を見る
          </button>
          {openErrors && (
            <ul className="mt-2 space-y-1 text-[11px] text-rose-600 bg-rose-50 border border-rose-200 rounded-md p-2">
              {summary.errorLines.map((e, i) => (
                <li key={i}>{e.line > 0 ? `${e.line}行目: ` : ''}{e.reason}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
