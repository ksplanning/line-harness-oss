'use client'

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  DEFAULT_RATING_STAR_COLOR,
  DEFAULT_VIDEO_HEIGHT,
  IMAGE_WIDTH_TO_MAXWIDTH,
  buildRedirectTargetUrl,
  normalizeFormRedirect,
} from '@line-crm/shared'
import {
  evaluateInternalFormLogic,
  nextInternalFormFieldId,
  normalizePostalLookupCode,
  normalizeSingleLineAddress,
} from '@line-crm/shared/internal-form-logic'
import type {
  HarnessField,
  HarnessLogicRule,
  FormDesign,
  FormDisplayType,
  FormCopy,
  FormRedirect,
  InternalFormChannel,
  SuccessPageSpec,
} from '@line-crm/shared'
import { fieldTypeIcon, isDecoration } from './field-types'

const LINE_GREEN = '#06C755'
const POSTAL_LOOKUP_MESSAGES: Record<number, string> = {
  400: '郵便番号は半角数字7桁で入力してください',
  404: '住所が見つかりませんでした',
  409: '住所候補が複数あります。住所を直接入力してください',
  429: '検索が混み合っています。少し待ってからお試しください',
  503: '住所検索を一時的に利用できません。住所を直接入力してください',
}

function internalPreviewFont(presetId: string | undefined): string {
  if (presetId && ['dark-sumi', 'sand-washi', 'mono-ink', 'matcha-wa'].includes(presetId)) {
    return '"Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif'
  }
  if (presetId === 'coral-pop') {
    return '"M PLUS Rounded 1c", "Noto Sans JP", "Yu Gothic", sans-serif'
  }
  return '"Noto Sans JP", "Hiragino Sans", "Yu Gothic", system-ui, sans-serif'
}

export interface FormPreviewProps {
  title: string
  description?: string | null
  fields: HarnessField[]
  /** form-design (Batch D): テーマ色/ロゴ/カバーを反映 (未指定は従来の LINE green 既定)。 */
  design?: FormDesign
  /** form-route-branching (R2/R5): 表示形式。multi_step 時「1問ずつ表示」注記 (Batch C 整合)。 */
  formType?: FormDisplayType
  /** logic (jump 注記用)。jump rule があれば「ページへ飛ぶ分岐は1問ずつ表示で動作」注記。 */
  logic?: HarnessLogicRule[]
  /** 配信先。自前配信でだけ有効な入力自由化をプレビューへ反映する。 */
  renderBackend?: 'formaloo' | 'internal'
  /**
   * internal renderer 用の忠実プレビューを有効にする opt-in。
   * 未指定時は既存 Formaloo preview の静的表示を一切変えない。
   */
  internalLogicPreview?: boolean
  /** internal preview を開いた直後の経由チャネル。未指定は埋め込み・直リンク。 */
  initialPreviewChannel?: InternalFormChannel
  /** submit 分岐が参照するルート別完了ページ。 */
  successPages?: SuccessPageSpec[]
  /** internal 公開ページの送信ボタンと通常完了文言。 */
  formCopy?: FormCopy
  /** internal 公開ページの送信後リダイレクト。プレビューでは遷移せず行き先を示す。 */
  formRedirect?: FormRedirect
}

// 入力可能プレビュー (②): type できる control の見た目 (白背景・濃い文字)。
const inputClassName = 'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800'
// file は type 対象でない (実選択は公開フォーム) ため read-only 表示のまま。
const disabledClassName = 'w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-500 disabled:cursor-not-allowed disabled:opacity-100'

type PreviewAnswer = string | string[]

function defaultPreviewAnswer(field: HarnessField): PreviewAnswer {
  if (field.type === 'multiple_select') return field.config.defaultValues ?? []
  if (field.type === 'choice' || field.type === 'dropdown') return field.config.defaultValue ?? ''
  return ''
}

function initialPreviewAnswers(fields: HarnessField[]): Record<string, PreviewAnswer> {
  const initial: Record<string, PreviewAnswer> = {}
  for (const field of fields) {
    const value = defaultPreviewAnswer(field)
    if ((Array.isArray(value) && value.length > 0) || (!Array.isArray(value) && value !== '')) {
      initial[field.id] = value
    }
  }
  return initial
}

function sanitizePreviewAnswers(
  fields: HarnessField[],
  answers: Record<string, PreviewAnswer>,
): Record<string, PreviewAnswer> {
  const sanitized: Record<string, PreviewAnswer> = {}
  for (const field of fields) {
    const answer = answers[field.id]
    if (answer === undefined) continue
    if (field.type === 'choice' || field.type === 'dropdown') {
      sanitized[field.id] = typeof answer === 'string' && (field.config.choices ?? []).includes(answer)
        ? answer
        : ''
      continue
    }
    if (field.type === 'multiple_select') {
      const choices = new Set(field.config.choices ?? [])
      sanitized[field.id] = Array.isArray(answer) ? answer.filter((item) => choices.has(item)) : []
      continue
    }
    if (field.type === 'yes_no') {
      sanitized[field.id] = answer === 'yes' || answer === 'no' ? answer : ''
      continue
    }
    sanitized[field.id] = answer
  }
  return sanitized
}

function PreviewControl({
  field,
  ratingStarColor,
  answer,
  onAnswerChange,
  controlStyle,
  optionStyle,
  themeColor,
  nativeRequired,
  internalRenderer,
}: {
  field: HarnessField
  ratingStarColor?: string
  answer?: PreviewAnswer
  onAnswerChange?: (value: PreviewAnswer) => void
  controlStyle?: CSSProperties
  optionStyle?: CSSProperties
  themeColor?: string
  nativeRequired?: boolean
  internalRenderer: boolean
}) {
  const controlId = `preview-control-${field.id}`
  const choices = field.config.choices ?? []
  // ② プレビュー入力可能化: 入力値は local state のみ (どこにも送信しない = form/submit 無し)。
  //   自前描画ゆえ、hosted で不可能な「残り文字数ライブカウンター」もプレビュー内で提供できる (text の maxLength)。
  const [localValue, setLocalValue] = useState<PreviewAnswer>(() => (
    internalRenderer ? defaultPreviewAnswer(field) : ''
  ))
  const value = onAnswerChange ? (answer ?? defaultPreviewAnswer(field)) : localValue
  const stringValue = Array.isArray(value) ? (value[0] ?? '') : value
  const arrayValue = Array.isArray(value) ? value : []
  const placeholder = internalRenderer ? field.config.placeholder : undefined
  const setValue = (next: PreviewAnswer) => {
    if (onAnswerChange) onAnswerChange(next)
    else setLocalValue(next)
  }

  useEffect(() => {
    if (!internalRenderer || onAnswerChange) return
    if (field.type === 'choice' || field.type === 'dropdown' || field.type === 'multiple_select') {
      setLocalValue(defaultPreviewAnswer(field))
    }
  }, [field.id, field.type, field.config.defaultValue, field.config.defaultValues, internalRenderer, onAnswerChange])

  switch (field.type) {
    case 'text': {
      const max = typeof field.config.maxLength === 'number' ? field.config.maxLength : undefined
      const count = Array.from(stringValue).length
      const over = max !== undefined && count > max
      return (
        <div className="space-y-1">
          <input
            id={controlId}
            aria-label={field.label}
            type="text"
            required={nativeRequired}
            value={stringValue}
            placeholder={placeholder}
            minLength={internalRenderer ? field.config.minLength : undefined}
            maxLength={max}
            onChange={(e) => setValue(e.target.value)}
            className={inputClassName}
            style={controlStyle}
          />
          {max !== undefined && (
            <p data-testid="preview-char-counter" className={`text-xs ${over ? 'text-red-500' : 'text-gray-400'}`}>
              残り {Math.max(0, max - count)} 文字
            </p>
          )}
        </div>
      )
    }
    case 'address':
      return (
        <textarea
          id={controlId}
          aria-label={field.label}
          rows={2}
          wrap="soft"
          required={nativeRequired}
          value={stringValue}
          placeholder={placeholder}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.preventDefault()
          }}
          onChange={(event) => setValue(normalizeSingleLineAddress(event.target.value))}
          data-single-line-address=""
          className={`${inputClassName} min-h-[4.5rem] resize-y`}
          style={controlStyle}
        />
      )
    case 'textarea': {
      const max = internalRenderer && typeof field.config.maxLength === 'number' ? field.config.maxLength : undefined
      const count = Array.from(stringValue).length
      return (
        <div className="space-y-1">
          <textarea id={controlId} aria-label={field.label} rows={3} required={nativeRequired} value={stringValue} placeholder={placeholder} minLength={internalRenderer ? field.config.minLength : undefined} maxLength={max} onChange={(e) => setValue(e.target.value)} className={inputClassName} style={controlStyle} />
          {max !== undefined && <p data-testid="preview-char-counter" className="text-xs text-gray-400">残り {Math.max(0, max - count)} 文字</p>}
        </div>
      )
    }
    case 'number':
      return <input id={controlId} aria-label={field.label} type="number" required={nativeRequired} value={stringValue} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} className={inputClassName} style={controlStyle} />
    case 'email':
      return <input id={controlId} aria-label={field.label} type="email" required={nativeRequired} value={stringValue} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} className={inputClassName} style={controlStyle} />
    case 'phone':
      return <input id={controlId} aria-label={field.label} type="tel" required={nativeRequired} value={stringValue} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} className={inputClassName} style={controlStyle} />
    case 'date':
      return <input id={controlId} aria-label={field.label} type="date" required={nativeRequired} value={stringValue} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} className={inputClassName} style={controlStyle} />
    case 'time':
      return <input id={controlId} aria-label={field.label} type="time" required={nativeRequired} value={stringValue} placeholder={placeholder} onChange={(e) => setValue(e.target.value)} className={inputClassName} style={controlStyle} />
    case 'website':
      return <input id={controlId} aria-label={field.label} type="url" required={nativeRequired} value={stringValue} onChange={(e) => setValue(e.target.value)} placeholder={placeholder ?? 'https://example.com'} className={inputClassName} style={controlStyle} />
    case 'city':
      return <input id={controlId} aria-label={field.label} type="text" required={nativeRequired} value={stringValue} onChange={(e) => setValue(e.target.value)} placeholder={placeholder ?? '例: 千代田区'} className={inputClassName} style={controlStyle} />
    case 'datetime':
      return <input id={controlId} aria-label={field.label} type="datetime-local" required={nativeRequired} value={stringValue} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} className={inputClassName} style={controlStyle} />
    case 'country':
    case 'postal_code':
    case 'prefecture':
    case 'address_city':
    case 'address_street':
    case 'address_building':
      return <input id={controlId} aria-label={field.label} type="text" required={nativeRequired} value={stringValue} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} className={inputClassName} style={controlStyle} />
    case 'yes_no':
      return (
        <div id={controlId} role="group" aria-label={field.label} className="space-y-2">
          {[
            { value: 'yes', label: 'はい' },
            { value: 'no', label: 'いいえ' },
          ].map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm text-gray-700" style={optionStyle}>
              <input
                type="radio"
                required={nativeRequired}
                name={`preview-${field.id}`}
                value={option.value}
                checked={stringValue === option.value}
                onChange={() => setValue(option.value)}
                className="h-4 w-4 accent-[#06C755]"
                style={themeColor ? { accentColor: themeColor } : undefined}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      )
    case 'choice':
      return (
        <div id={controlId} className="space-y-2">
          {choices.map((choice, index) => (
            <label key={`${choice}-${index}`} className="flex items-center gap-2 text-sm text-gray-700" style={optionStyle}>
              <span className="sr-only">プレビュー </span>
              <input
                aria-label={onAnswerChange ? undefined : `${field.label}: ${choice}`}
                type="radio"
                required={nativeRequired}
                name={`preview-${field.id}`}
                value={choice}
                checked={internalRenderer ? stringValue === choice : undefined}
                onChange={internalRenderer ? () => setValue(choice) : undefined}
                className="h-4 w-4 accent-[#06C755]"
                style={themeColor ? { accentColor: themeColor } : undefined}
              />
              <span>{choice}</span>
            </label>
          ))}
        </div>
      )
    case 'dropdown':
      return (
        <select
          id={controlId}
          aria-label={field.label}
          required={nativeRequired}
          className={inputClassName}
          style={controlStyle}
          {...(internalRenderer ? { value: stringValue, onChange: (event) => setValue(event.target.value) } : {})}
        >
          {internalRenderer && <option value="">{placeholder ?? '選択してください'}</option>}
          {choices.map((choice, index) => <option key={`${choice}-${index}`} value={choice}>{choice}</option>)}
        </select>
      )
    case 'multiple_select':
      return (
        <div id={controlId} className="space-y-2">
          {choices.map((choice, index) => (
            <label key={`${choice}-${index}`} className="flex items-center gap-2 text-sm text-gray-700" style={optionStyle}>
              <span className="sr-only">プレビュー </span>
              <input
                aria-label={onAnswerChange ? undefined : `${field.label}: ${choice}`}
                type="checkbox"
                checked={internalRenderer ? arrayValue.includes(choice) : undefined}
                onChange={internalRenderer
                  ? (event) => setValue(
                    event.target.checked
                      ? [...arrayValue, choice]
                      : arrayValue.filter((item) => item !== choice),
                  )
                  : undefined}
                className="h-4 w-4 accent-[#06C755]"
                style={themeColor ? { accentColor: themeColor } : undefined}
              />
              <span>{choice}</span>
            </label>
          ))}
        </div>
      )
    case 'file':
      // file は「type できる」対象でない (実際の選択は公開フォーム) ため read-only 表示のまま。
      return (
        <div className="space-y-1.5">
          <input
            id={controlId}
            aria-label={field.label}
            type="file"
            disabled
            multiple={field.config.allowMultipleFiles ?? false}
            accept={field.config.allowedExtensions?.map((extension) => `.${extension.replace(/^\./, '')}`).join(',')}
            className={disabledClassName}
          />
          <p className="text-xs text-gray-500">ファイルを添付する項目です。実際の選択は公開フォームで行えます。</p>
        </div>
      )
    case 'matrix': {
      const columns = Object.entries(field.config.matrixChoiceItems ?? {}).map(([key, item]) => ({
        key,
        title: item && typeof item === 'object' && !Array.isArray(item) && typeof item.title === 'string'
          ? item.title
          : key,
      }))
      const rows = field.config.matrixChoiceGroups ?? []
      return (
        <div className="space-y-1.5" data-testid="preview-matrix">
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="min-w-full border-collapse text-xs text-gray-700">
              <thead className="bg-gray-50">
                <tr>
                  <th scope="col" className="px-2 py-2 text-left font-medium">項目</th>
                  {columns.map((column, index) => (
                    <th key={`${column.key}-${index}`} scope="col" className="px-2 py-2 text-center font-medium">
                      {column.title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={`${row.slug ?? row.refId ?? row.title}-${rowIndex}`} className="border-t border-gray-100">
                    <th scope="row" className="whitespace-nowrap px-2 py-2 text-left font-medium">{row.title}</th>
                    {columns.map((column, columnIndex) => (
                      <td key={`${column.key}-${columnIndex}`} className="px-2 py-2 text-center">
                        <input
                          type="radio"
                          disabled
                          aria-label={`${row.title}: ${column.title}`}
                          name={`preview-matrix-${field.id}-${rowIndex}`}
                          className="h-4 w-4 accent-[#06C755]"
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p data-testid="preview-matrix-note" className="text-[10px] leading-snug text-gray-400">
            公開フォームでは Formaloo の行列入力として操作できます。このプレビューは行と列の構成確認用です。
          </p>
        </div>
      )
    }
    case 'repeating_section': {
      const columns = field.config.repeatingColumns ?? []
      const minRows = field.config.minRows ?? 0
      const maxRows = field.config.maxRows
      return (
        <div className="space-y-1.5" data-testid="preview-repeating">
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="min-w-full border-collapse text-xs text-gray-700">
              <thead className="bg-gray-50">
                <tr>
                  {columns.map((column, index) => (
                    <th key={`${column.slug ?? column.columnField}-${index}`} scope="col" className="px-2 py-2 text-left font-medium">
                      {column.title}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-gray-100">
                  {columns.map((column, index) => (
                    <td key={`${column.slug ?? column.columnField}-${index}`} className="px-2 py-2">
                      <input
                        type="text"
                        disabled
                        aria-label={`${column.title}（代表行）`}
                        className={disabledClassName}
                      />
                    </td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          <p data-testid="preview-repeating-note" className="text-[10px] leading-snug text-gray-400">
            公開フォームでは {minRows}〜{maxRows ?? '上限なし'} 行を追加して入力できます。このプレビューは列構成の代表表示です。
          </p>
        </div>
      )
    }
    case 'variable':
      return (
        <div data-testid="preview-variable" className="space-y-1 rounded-lg border border-dashed border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-500">
          <div>計算結果（公開フォームで自動計算）</div>
          {field.config.variableSubType === 'formula' && field.config.formula && (
            <code className="block break-all text-[10px] text-gray-400">{field.config.formula}</code>
          )}
        </div>
      )
    case 'choice_fetch': {
      const items = field.config.choiceFetchItems ?? []
      return (
        <select id={controlId} aria-label={field.label} className={inputClassName} style={controlStyle} disabled={items.length === 0}>
          {items.length === 0
            ? <option>選択肢リストが未設定です</option>
            : items.map((item, index) => <option key={`${item.value}-${index}`} value={item.value}>{item.label}</option>)}
        </select>
      )
    }
    case 'rating': {
      // treasure-b1-palette: sub_type 別ウィジェット (自前描画・最小)。hosted は Formaloo の rating ウィジェットで実描画。
      const sub = field.config.ratingSubType ?? 'star'
      if (sub === 'like_dislike') {
        return (
          <div data-testid="preview-rating" className="flex gap-4 text-2xl" role="group" aria-label={field.label}>
            <span aria-hidden>👍</span>
            <span aria-hidden>👎</span>
          </div>
        )
      }
      if (sub === 'nps') {
        return (
          <div data-testid="preview-rating" className="flex flex-wrap gap-1" role="group" aria-label={field.label}>
            {Array.from({ length: 11 }, (_, i) => (
              <span key={i} className="inline-flex h-7 w-7 items-center justify-center rounded border border-gray-300 text-xs text-gray-600">{i}</span>
            ))}
          </div>
        )
      }
      if (sub === 'score') {
        return <input data-testid="preview-rating" id={controlId} aria-label={field.label} type="number" required={nativeRequired} value={stringValue} onChange={(e) => setValue(e.target.value)} className={inputClassName} style={controlStyle} />
      }
      // star / embeded → 星 5 個 (embeded は顔アイコン等だが最小描画は星で代表)。
      // b1-field-polish: form-level design.ratingStarColor を反映 (未設定=既定黄)。hosted は custom_css で着色ゆえ近似。
      return (
        <div data-testid="preview-rating" className="flex gap-1 text-2xl" style={{ color: ratingStarColor ?? DEFAULT_RATING_STAR_COLOR }} role="group" aria-label={field.label}>
          {Array.from({ length: 5 }, (_, i) => <span key={i} aria-hidden>★</span>)}
        </div>
      )
    }
    case 'signature':
      // treasure-b1-palette: 署名パッド placeholder (プレビューは手書き不可 = 公開フォームで入力)。
      return (
        <div data-testid="preview-signature" className="flex h-24 items-center justify-center rounded-lg border-2 border-dashed border-gray-300 bg-gray-50 text-xs text-gray-400">
          ここに署名（公開フォームで手書き入力できます）
        </div>
      )
    default:
      return null
  }
}

// form-design-presets (F-HIGH-1): ダーク preset 選択時、ラベル類が Tailwind 固定 text-gray-* のままだと
//   暗背景に near-black で描画され不可視 (≈1.1:1)。preset の textColor に従わせて可読性を確保する。
//   非退行: textColor 未設定 (design 無し / 未指定) は inline style を付けず従来 gray クラスのまま。
//   section は自前の固定 light box (bg-[#F0FFF6]) を持つため、box を fieldColor へ追随させて
//   textColor(=light) を載せる (fieldColor↔textColor は番人テストで >=4.5 保証ゆえ常に可読)。
function PreviewField({
  field,
  themeColor,
  textColor,
  fieldColor,
  borderColor,
  ratingStarColor,
  answer,
  onAnswerChange,
  postalLookup,
  internalRenderer,
}: {
  field: HarnessField
  themeColor: string
  textColor?: string
  fieldColor?: string
  borderColor?: string
  ratingStarColor?: string
  answer?: PreviewAnswer
  onAnswerChange?: (value: PreviewAnswer) => void
  postalLookup?: { busy: boolean; message: string; run: () => void }
  internalRenderer?: boolean
}) {
  const textStyle = textColor ? { color: textColor } : undefined
  const internalTextColor = textColor ?? '#17202A'
  const controlStyle: CSSProperties | undefined = internalRenderer
    ? {
      backgroundColor: fieldColor ?? '#FFFFFF',
      borderColor: borderColor ?? '#CBD5E1',
      color: internalTextColor,
    }
    : undefined
  const optionStyle: CSSProperties | undefined = internalRenderer ? { color: internalTextColor } : undefined
  if (isDecoration(field.type)) {
    if (field.type === 'section') {
      return (
        <div
          data-testid="preview-section"
          className="rounded-lg bg-[#F0FFF6] px-4 py-3"
          style={fieldColor ? { backgroundColor: fieldColor } : undefined}
        >
          <h3 className="font-bold text-gray-900" style={textStyle}>{field.label}</h3>
          {field.config.text && <p className="mt-1 whitespace-pre-wrap text-sm text-gray-600" style={textStyle}>{field.config.text}</p>}
        </div>
      )
    }

    if (field.type === 'image') {
      // form-image-decoration: 差し込み画像を当該位置にインライン表示 (幅プリセットを max-width % で反映)。
      //   dataURL(upload pending) / URL 両対応。hosted は section description の canonical <img> で実描画 (spike S-1)。
      const src = field.config.imageUpload?.dataUrl || field.config.imageUrl || ''
      return (
        <div data-testid="preview-image" className="text-center">
          {src ? (
            <img
              src={src}
              alt={field.config.imageAlt || ''}
              style={{ maxWidth: IMAGE_WIDTH_TO_MAXWIDTH[field.config.imageWidth ?? 'medium'], borderRadius: 8, display: 'inline-block' }}
            />
          ) : (
            <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-center text-xs text-gray-400">
              画像未設定
            </div>
          )}
        </div>
      )
    }

    if (field.type === 'video') {
      // treasure-b1-palette: video(oembed) の埋め込み枠 (自前描画・最小)。hosted は Formaloo の oembed iframe で実再生。
      // b1-field-polish: 枠を videoHeight (未設定=既定 250px) 反映の再生可能サイズで描画 (既定 100px 薄帯の是正確認用)。
      const url = field.config.videoUrl
      return (
        <div data-testid="preview-video" className="space-y-1">
          {url ? (
            <div
              data-testid="preview-video-frame"
              className="flex flex-col items-center justify-center gap-2 overflow-hidden rounded-lg border border-gray-800 bg-gray-900 px-4 text-gray-200"
              style={{ height: field.config.videoHeight ?? DEFAULT_VIDEO_HEIGHT }}
            >
              <span aria-hidden className="text-3xl">▶</span>
              <span className="min-w-0 max-w-full truncate text-xs text-gray-400">{url}</span>
            </div>
          ) : (
            <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-center text-xs text-gray-400">
              動画URL未設定
            </div>
          )}
          <p data-testid="preview-video-note" className="text-[10px] text-gray-400 leading-snug">
            公開フォームでは Formaloo が動画を埋め込み再生します（YouTube/Vimeo 等）。このプレビューは枠の大きさの確認用です。
          </p>
        </div>
      )
    }

    return (
      <div data-testid="preview-page-break" className="flex items-center gap-2 py-2 text-xs text-gray-400">
        <span className="h-px flex-1 bg-gray-200" aria-hidden />
        <span>{field.label || '改ページ'}</span>
        <span className="h-px flex-1 bg-gray-200" aria-hidden />
      </div>
    )
  }

  return (
    <div data-testid="preview-field" className="space-y-2">
      <div className="flex items-center gap-2">
        <span aria-hidden>{fieldTypeIcon(field.type)}</span>
        <label htmlFor={`preview-control-${field.id}`} className="text-sm font-medium text-gray-800" style={textStyle}>{field.label}</label>
        {field.required && (
          <span className="rounded px-1.5 py-0.5 text-[10px] font-bold text-white" style={{ backgroundColor: themeColor }}>
            必須
          </span>
        )}
      </div>
      {/* 補足説明 (Help text) をラベル直下に表示。公開フォームでも項目の Help text として出る。 */}
      {field.config.description && (
        <p data-testid="preview-field-description" className="whitespace-pre-wrap text-xs text-gray-500" style={textStyle}>{field.config.description}</p>
      )}
      {/* ② 一行テキストの maxLength は入力に実際に効かせ、「残り N 文字」ライブカウンターを PreviewControl 内に表示。
          hosted 公開フォームは「N文字まで」静的注記+超過エラーで実効 (下の忠実性注記で開示)。 */}
      <PreviewControl
        field={field}
        ratingStarColor={ratingStarColor}
        answer={answer}
        onAnswerChange={onAnswerChange}
        controlStyle={controlStyle}
        optionStyle={optionStyle}
        themeColor={internalRenderer ? themeColor : undefined}
        nativeRequired={internalRenderer && field.required}
        internalRenderer={internalRenderer ?? false}
      />
      {postalLookup && (
        <div className="space-y-1">
          <button
            type="button"
            disabled={postalLookup.busy}
            onClick={postalLookup.run}
            className="min-h-12 rounded-lg border px-4 py-2 text-sm font-bold disabled:cursor-wait disabled:opacity-60"
            style={{ borderColor: themeColor, color: themeColor }}
          >
            郵便番号から住所を入力
          </button>
          <p aria-live="polite" className="text-xs text-gray-500" style={textStyle}>{postalLookup.message}</p>
        </div>
      )}
    </div>
  )
}

export default function FormPreview({
  title,
  description,
  fields,
  design,
  formType,
  logic,
  renderBackend = 'formaloo',
  internalLogicPreview = false,
  initialPreviewChannel = 'web',
  successPages = [],
  formCopy,
  formRedirect,
}: FormPreviewProps) {
  const isMultiStep = formType === 'multi_step'
  const hasJump = Array.isArray(logic) && logic.some((r) => r.action === 'jump')
  // route-terminal-submit: 「ここで送信」凡例 + page_break の Continue のみ空画面注記。
  const hasSubmit = Array.isArray(logic) && logic.some((r) => r.action === 'submit')
  const hasPageBreak = fields.some((f) => f.type === 'page_break')
  const hasVariable = fields.some((field) => field.type === 'variable')
  const hasChoiceFetch = fields.some((field) => field.type === 'choice_fetch')
  const hasPostalAutofill = fields.some((field) => Boolean(field.config.postalAutofill))
  const internalRenderer = renderBackend === 'internal' || internalLogicPreview
  const orderedFields = useMemo(() => [...fields].sort((a, b) => a.position - b.position), [fields])
  const [answers, setAnswers] = useState<Record<string, PreviewAnswer>>(() => initialPreviewAnswers(orderedFields))
  const [previewChannel, setPreviewChannel] = useState<InternalFormChannel>(initialPreviewChannel)
  const [previewValidationError, setPreviewValidationError] = useState<string | null>(null)
  const [previewSubmitted, setPreviewSubmitted] = useState(false)
  const [postalLookupState, setPostalLookupState] = useState<Record<string, { busy: boolean; message: string }>>({})
  const postalLookupGeneration = useRef<Record<string, number>>({})
  const postalAutofilledValues = useRef<Record<string, Record<string, string>>>({})
  const postalManuallyEdited = useRef<Record<string, Set<string>>>({})
  useEffect(() => {
    setAnswers((current) => {
      const sanitized = sanitizePreviewAnswers(orderedFields, current)
      const defaults = initialPreviewAnswers(orderedFields)
      for (const [fieldId, value] of Object.entries(defaults)) {
        if (sanitized[fieldId] === undefined) sanitized[fieldId] = value
      }
      return sanitized
    })
  }, [orderedFields])
  const effectiveAnswers = useMemo(
    () => sanitizePreviewAnswers(orderedFields, answers),
    [answers, orderedFields],
  )
  const logicState = useMemo(
    () => evaluateInternalFormLogic(orderedFields, logic ?? [], effectiveAnswers, previewChannel),
    [orderedFields, logic, effectiveAnswers, previewChannel],
  )
  const runPostalLookup = async (field: HarnessField): Promise<void> => {
    const config = field.config.postalAutofill
    if (!config) return
    const answer = effectiveAnswers[config.zipField]
    const rawZip = Array.isArray(answer) ? (answer[0] ?? '') : (answer ?? '')
    const zip = normalizePostalLookupCode(rawZip)
    const generation = (postalLookupGeneration.current[field.id] ?? 0) + 1
    postalLookupGeneration.current[field.id] = generation
    if (!/^\d{7}$/.test(zip)) {
      setPostalLookupState((current) => ({
        ...current,
        [field.id]: { busy: false, message: POSTAL_LOOKUP_MESSAGES[400] },
      }))
      document.getElementById(`preview-control-${config.zipField}`)?.focus()
      return
    }
    setPostalLookupState((current) => ({
      ...current,
      [field.id]: { busy: true, message: '住所を検索しています' },
    }))
    try {
      const apiBase = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/+$/, '')
      const response = await fetch(`${apiBase}/api/postal-lookup?zip=${encodeURIComponent(zip)}`, {
        headers: { Accept: 'application/json' },
      })
      if (!response.ok) throw Object.assign(new Error('postal lookup failed'), { status: response.status })
      const address = await response.json() as Record<string, unknown>
      if (postalLookupGeneration.current[field.id] !== generation) return
      const values: Array<[string, unknown]> = [
        [config.prefField, address.pref],
        [config.cityField, address.city],
        [config.townField, address.town],
      ]
      const autofilled = postalAutofilledValues.current[field.id] ?? {}
      postalAutofilledValues.current[field.id] = autofilled
      const manuallyEdited = postalManuallyEdited.current[field.id] ?? new Set<string>()
      postalManuallyEdited.current[field.id] = manuallyEdited
      setAnswers((current) => {
        const updated = { ...current }
        for (const [targetId, value] of values) {
          if (manuallyEdited.has(targetId)) continue
          const existing = current[targetId]
          const empty = existing === undefined || existing === '' || (Array.isArray(existing) && existing.length === 0)
          const previous = autofilled[targetId]
          if (typeof value === 'string' && (empty || (previous !== undefined && existing === previous))) {
            updated[targetId] = value
            autofilled[targetId] = value
          } else if (previous !== undefined) {
            delete autofilled[targetId]
          }
        }
        return updated
      })
      setPostalLookupState((current) => ({
        ...current,
        [field.id]: { busy: false, message: '住所を入力しました' },
      }))
    } catch (error) {
      if (postalLookupGeneration.current[field.id] !== generation) return
      const status = (error as { status?: number }).status ?? 0
      setPostalLookupState((current) => ({
        ...current,
        [field.id]: {
          busy: false,
          message: POSTAL_LOOKUP_MESSAGES[status] ?? '住所検索に失敗しました。住所を直接入力してください',
        },
      }))
    }
  }
  const questionIds = logicState.visibleFieldIds.filter((id) => {
    const field = orderedFields.find((candidate) => candidate.id === id)
    return field ? !isDecoration(field.type) : false
  })
  const [currentFieldId, setCurrentFieldId] = useState<string | null>(() => (
    orderedFields.find((field) => !isDecoration(field.type))?.id ?? null
  ))
  const visibleIds = new Set(logicState.visibleFieldIds)
  const effectiveCurrentFieldId = currentFieldId && questionIds.includes(currentFieldId)
    ? currentFieldId
    : (questionIds[0] ?? null)
  const previewFields = !internalLogicPreview
    ? fields
    : isMultiStep
      ? orderedFields.filter((field) => field.id === effectiveCurrentFieldId)
      : orderedFields.filter((field) => visibleIds.has(field.id))
  let nextFieldId = internalLogicPreview && isMultiStep && effectiveCurrentFieldId
    ? nextInternalFormFieldId(orderedFields, logicState, effectiveCurrentFieldId)
    : null
  while (nextFieldId) {
    const field = orderedFields.find((candidate) => candidate.id === nextFieldId)
    if (field && !isDecoration(field.type)) break
    nextFieldId = nextInternalFormFieldId(orderedFields, logicState, nextFieldId)
  }
  const currentPreviewIsValid = (): boolean => {
    const fieldIds = isMultiStep
      ? (effectiveCurrentFieldId ? [effectiveCurrentFieldId] : [])
      : logicState.visibleFieldIds
    for (const fieldId of fieldIds) {
      const current = orderedFields.find((field) => field.id === fieldId)
      if (!current || isDecoration(current.type)) continue
      const answer = effectiveAnswers[fieldId]
      const answered = Array.isArray(answer)
        ? answer.length > 0
        : typeof answer === 'string' && answer.trim() !== ''
      if (current.required && !answered) {
        setPreviewValidationError(`${current.label} は必須項目です`)
        return false
      }
      const controlRoot = document.getElementById(`preview-control-${fieldId}`)
      const validityControls = controlRoot?.matches('input, textarea, select')
        ? [controlRoot as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement]
        : Array.from(controlRoot?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select') ?? [])
      if (validityControls.some((control) => !control.reportValidity())) {
        setPreviewValidationError(`${current.label} の入力内容を確認してください`)
        return false
      }
    }
    setPreviewValidationError(null)
    return true
  }
  const advancePreview = () => {
    if (!effectiveCurrentFieldId || !nextFieldId || !currentPreviewIsValid()) return
    setPreviewSubmitted(false)
    setCurrentFieldId(nextFieldId)
  }
  const submitPreview = () => {
    if (!currentPreviewIsValid()) return
    setPreviewSubmitted(true)
  }
  const resetPreview = () => {
    setAnswers(initialPreviewAnswers(orderedFields))
    setPreviewChannel(initialPreviewChannel)
    setPreviewValidationError(null)
    setPreviewSubmitted(false)
    setPostalLookupState({})
    for (const fieldId of Object.keys(postalLookupGeneration.current)) {
      postalLookupGeneration.current[fieldId] += 1
    }
    postalAutofilledValues.current = {}
    postalManuallyEdited.current = {}
    setCurrentFieldId(orderedFields.find((field) => !isDecoration(field.type))?.id ?? null)
  }
  const completionPage = logicState.completionPageId
    ? successPages.find((page) => page.id === logicState.completionPageId)
    : undefined
  const normalizedRedirect = useMemo(() => normalizeFormRedirect(formRedirect), [formRedirect])
  const previewRedirectUrl = normalizedRedirect.url
    ? buildRedirectTargetUrl(normalizedRedirect.url, normalizedRedirect.openExternalBrowser)
    : null
  // form-design (Batch D): テーマ色/ロゴ/カバーを反映。未指定は従来の LINE green 既定 (後方互換)。
  const themeColor = design?.themeColor || LINE_GREEN
  const buttonColor = design?.buttonColor || themeColor
  const submitTextColor = design?.submitTextColor || '#FFFFFF'
  const bgColor = design?.backgroundColor || (internalLogicPreview ? '#F4F6F8' : '#FFFFFF')
  const textColor = design?.textColor || undefined
  // form-design-presets (F-HIGH-1): section の light box をダーク preset で追随させ、textColor(=light) を可読にする。
  const fieldColor = design?.fieldColor || undefined
  const borderColor = design?.borderColor || undefined
  const logoUrl = design?.logoUrl || null
  const coverUrl = design?.backgroundImageUrl || null
  // b1-field-polish: 星色 (form-level・未設定は PreviewControl が既定黄で描画)。
  const ratingStarColor = design?.ratingStarColor || undefined
  // 視覚に効く design key があれば fidelity note を「反映しています」に更新 (無ければ従来 note)。
  const hasVisualDesign = Boolean(
    design && (design.themeColor || design.backgroundColor || design.buttonColor || design.textColor || design.logoUrl || design.backgroundImageUrl),
  )

  return (
    <div data-testid="form-preview" className="w-full">
      <div
        data-testid="preview-frame"
        className="mx-auto w-full overflow-hidden rounded-2xl border border-gray-200 shadow-sm"
        style={{
          maxWidth: 375,
          backgroundColor: bgColor,
          ...(internalLogicPreview ? { fontFamily: internalPreviewFont(design?.presetId ?? undefined) } : {}),
          ...(internalLogicPreview && coverUrl
            ? { backgroundImage: `url(${coverUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
            : {}),
        }}
      >
        <div
          {...(internalLogicPreview ? { 'data-testid': 'preview-surface' } : {})}
          className={internalLogicPreview ? 'm-4 overflow-hidden rounded-2xl border shadow-sm' : undefined}
          style={internalLogicPreview
            ? {
              backgroundColor: fieldColor ?? '#FFFFFF',
              borderColor: borderColor ?? '#CBD5E1',
              color: textColor ?? '#17202A',
            }
            : undefined}
        >
        {(!internalLogicPreview || !previewSubmitted) && <header
          className="border-t-4 px-5 pb-4 pt-5"
          style={{
            borderTopColor: themeColor,
            ...(!internalLogicPreview && coverUrl
              ? { backgroundImage: `url(${coverUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
              : {}),
          }}
          {...(!internalLogicPreview && coverUrl ? { 'data-testid': 'preview-cover' } : {})}
        >
          {logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img data-testid="preview-logo" src={logoUrl} alt="ロゴ" className="mb-2 h-10 w-auto object-contain" />
          )}
          <h2 className="text-xl font-bold" style={{ color: textColor ?? (internalLogicPreview ? '#17202A' : '#111827') }}>{title}</h2>
          {description && <p className="mt-2 whitespace-pre-wrap text-sm" style={{ color: textColor ?? (internalLogicPreview ? '#17202A' : '#4B5563') }}>{description}</p>}
        </header>}

        <div className="space-y-5 border-t border-gray-100 px-5 py-5" style={textColor ? { color: textColor } : undefined}>
          {internalLogicPreview && !previewSubmitted && (
            <div data-testid="preview-channel-toggle" className="rounded-lg border border-gray-200 bg-gray-50 p-2">
              <p className="mb-2 text-xs font-medium text-gray-600">経由チャネルを試す</p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  aria-pressed={previewChannel === 'line'}
                  onClick={() => { setPreviewChannel('line'); setPreviewSubmitted(false); setPreviewValidationError(null) }}
                  className="rounded-md border px-2 py-1.5 text-xs font-medium"
                  style={previewChannel === 'line' ? { borderColor: themeColor, color: themeColor } : undefined}
                >
                  LINE経由
                </button>
                <button
                  type="button"
                  aria-pressed={previewChannel === 'web'}
                  onClick={() => { setPreviewChannel('web'); setPreviewSubmitted(false); setPreviewValidationError(null) }}
                  className="rounded-md border px-2 py-1.5 text-xs font-medium"
                  style={previewChannel === 'web' ? { borderColor: themeColor, color: themeColor } : undefined}
                >
                  埋め込み・直リンク経由
                </button>
              </div>
            </div>
          )}

          {internalLogicPreview && !previewSubmitted && previewValidationError && (
            <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {previewValidationError}
            </p>
          )}

          {(!internalLogicPreview || !previewSubmitted) && previewFields.map((field) => (
            <PreviewField
              key={field.id}
              field={field}
              themeColor={themeColor}
              textColor={textColor}
              fieldColor={fieldColor}
              borderColor={borderColor}
              ratingStarColor={ratingStarColor}
              answer={internalLogicPreview ? effectiveAnswers[field.id] : undefined}
              onAnswerChange={internalLogicPreview
                ? (answer) => {
                  for (const sourceField of orderedFields) {
                    const config = sourceField.config.postalAutofill
                    if (!config) continue
                    if ([config.prefField, config.cityField, config.townField].includes(field.id)) {
                      const manuallyEdited = postalManuallyEdited.current[sourceField.id] ?? new Set<string>()
                      manuallyEdited.add(field.id)
                      postalManuallyEdited.current[sourceField.id] = manuallyEdited
                      delete postalAutofilledValues.current[sourceField.id]?.[field.id]
                    }
                  }
                  setAnswers((current) => ({ ...current, [field.id]: answer }))
                  setPreviewSubmitted(false)
                  if (field.config.postalAutofill) {
                    postalLookupGeneration.current[field.id] = (postalLookupGeneration.current[field.id] ?? 0) + 1
                    setPostalLookupState((current) => ({
                      ...current,
                      [field.id]: {
                        busy: false,
                        message: current[field.id]?.message
                          ? '郵便番号が変更されました。もう一度検索してください'
                          : '',
                      },
                    }))
                  }
                  if (!isMultiStep || field.id === effectiveCurrentFieldId) setPreviewValidationError(null)
                }
                : undefined}
              postalLookup={internalLogicPreview && field.config.postalAutofill
                ? {
                  busy: postalLookupState[field.id]?.busy ?? false,
                  message: postalLookupState[field.id]?.message ?? '',
                  run: () => { void runPostalLookup(field) },
                }
                : undefined}
              internalRenderer={internalRenderer}
            />
          ))}

          {internalLogicPreview && previewSubmitted && previewRedirectUrl && (
            <div
              data-testid="preview-redirect-completion"
              role="status"
              className="rounded-lg border px-4 py-3"
              style={{ borderColor: themeColor, ...(fieldColor ? { backgroundColor: fieldColor } : {}) }}
            >
              <p className={`text-xs font-medium ${textColor ? '' : 'text-gray-500'}`} style={textColor ? { color: textColor, opacity: 0.75 } : undefined}>
                送信後は次のURLへ移動します
              </p>
              <p className={`mt-1 break-all font-bold ${textColor ? '' : 'text-gray-900'}`} style={textColor ? { color: textColor } : undefined}>
                {previewRedirectUrl}
              </p>
              <p className={`mt-2 text-sm ${textColor ? '' : 'text-gray-600'}`} style={textColor ? { color: textColor, opacity: 0.85 } : undefined}>
                {normalizedRedirect.openExternalBrowser
                  ? 'LINE外のブラウザで開きます'
                  : '現在のブラウザで開きます'}
              </p>
            </div>
          )}

          {internalLogicPreview && previewSubmitted && !previewRedirectUrl && (
            <div
              data-testid="preview-route-completion"
              role="status"
              className="rounded-lg border px-4 py-3"
              style={{ borderColor: themeColor, ...(fieldColor ? { backgroundColor: fieldColor } : {}) }}
            >
              <p className={`text-xs font-medium ${textColor ? '' : 'text-gray-500'}`} style={textColor ? { color: textColor, opacity: 0.75 } : undefined}>
                {logicState.completionSourceId ? 'この回答後に表示される完了ページ' : '送信後に表示される完了メッセージ'}
              </p>
              <p className={`mt-1 font-bold ${textColor ? '' : 'text-gray-900'}`} style={textColor ? { color: textColor } : undefined}>
                {completionPage?.title || formCopy?.successMessage?.trim() || '送信ありがとうございました'}
              </p>
              {completionPage?.description && <p className={`mt-1 whitespace-pre-wrap text-sm ${textColor ? '' : 'text-gray-600'}`} style={textColor ? { color: textColor, opacity: 0.85 } : undefined}>{completionPage.description}</p>}
            </div>
          )}

          {internalLogicPreview && previewSubmitted && (
            <button
              type="button"
              onClick={resetPreview}
              className="w-full rounded-lg border px-4 py-2.5 text-sm font-bold"
              style={{ borderColor: themeColor, color: themeColor }}
            >
              もう一度試す
            </button>
          )}

          {internalLogicPreview && isMultiStep && nextFieldId && !logicState.completionSourceId ? (
            <button
              type="button"
              onClick={advancePreview}
              className="w-full rounded-lg px-4 py-2.5 text-sm font-bold"
              style={{ backgroundColor: buttonColor, color: submitTextColor }}
            >
              次へ
            </button>
          ) : internalLogicPreview ? (!previewSubmitted && (
            <button
              type="button"
              onClick={submitPreview}
              className="w-full rounded-lg px-4 py-2.5 text-sm font-bold"
              style={{ backgroundColor: buttonColor, color: submitTextColor }}
            >
              {formCopy?.buttonText?.trim() || '送信する'}
            </button>
          )) : (
            <button
              type="button"
              disabled
              className="w-full rounded-lg px-4 py-2.5 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60"
              style={{ backgroundColor: buttonColor, color: submitTextColor }}
            >
              送信
            </button>
          )}
        </div>
        </div>

        <div data-testid="preview-fidelity-note" className="space-y-1.5 border-t border-gray-200 bg-gray-50 px-5 py-4 text-[11px] leading-relaxed text-gray-500">
          <p>見出しや説明文も公開フォームに表示されます。</p>
          {/* form-route-branching (R5 / Batch C 整合): 表示形式と jump の注記。 */}
          {isMultiStep && (
            <p data-testid="preview-multistep-note">このフォームは「1問ずつ表示」です。公開フォームでは1問ずつ順に表示されます。</p>
          )}
          {hasJump && (
            <p data-testid="preview-jump-note">
              {internalLogicPreview
                ? '「ページへ飛ぶ」分岐を、本番と同じ判定でこのプレビューに反映しています。'
                : '「ページへ飛ぶ」分岐は、公開フォーム（1問ずつ表示）でのみ動作します。'}
            </p>
          )}
          {/* route-terminal-submit: 「ここで送信」凡例 (submit rule のある項目でルートを閉じる)。 */}
          {hasSubmit && (
            <p data-testid="preview-submit-note">「ここで送信」を設定した項目では、その項目に回答するとルートを閉じて完了ページへ送信します（以降の質問はスキップ）。</p>
          )}
          {/* route-terminal-submit: page_break は hosted で Continue のみの空画面を1枚挟む。 */}
          {hasPageBreak && (
            <p data-testid="preview-pagebreak-note">
              {internalLogicPreview
                ? '改ページはルートの区切りとして扱い、一覧表示では選ばれたルートだけを表示します。'
                : '改ページは、公開フォームでは「Continue」だけの空画面を1枚挟みます（Formaloo の仕様）。'}
            </p>
          )}
          {hasVariable && (
            <p data-testid="preview-variable-note">計算項目の実際の結果は、他の回答値を使って公開フォーム側で計算されます。このプレビューでは結果を作りません。</p>
          )}
          {hasChoiceFetch && (
            <p data-testid="preview-choice-fetch-note">動的選択肢は現在保存しているリストを表示しています。公開フォームでは供給URLから最新値を読み込みます。</p>
          )}
          {internalLogicPreview ? (
            hasVisualDesign
              ? <p>設定したテーマ色・ロゴ/カバーを、このプレビューと自前公開フォームの両方に反映します。</p>
              : <p>テーマ色・フォント・ロゴを設定すると、このプレビューと自前公開フォームの両方に反映します。</p>
          ) : hasVisualDesign ? (
            <p>設定したテーマ色・ロゴ/カバーを反映しています。細かなフォント・余白は公開時に Formaloo 側で微調整されます。</p>
          ) : (
            <p>色・フォント・ロゴは公開時に Formaloo 側のテーマで決まります。</p>
          )}
          <p>
            {internalLogicPreview
              ? 'このプレビューでは一行テキストの残り文字数を確認できます。自前公開フォームでも入力欄の文字数上限として実際に制限します。'
              : 'このプレビューでは一行テキストに残り文字数カウンターが出るので、文字数制限をその場で試せます。公開フォーム（Formaloo）では「N文字まで」の静的注記と超過時のエラーで制限され、入力しながら減る残り文字数カウンターは表示されません。'}
          </p>
          <p>
            {internalLogicPreview
              ? hasPostalAutofill
                ? 'このプレビューでは入力と条件分岐を本番と同じ判定で試せます。入力内容は保存・送信されず、住所検索を押した時だけ郵便番号を検索APIへ送ります。'
                : 'このプレビューでは入力と条件分岐を本番と同じ判定で試せます（入力内容はどこにも送信されません）。'
              : 'このプレビューでは入力を試せます（入力内容はどこにも送信されません）。条件分岐・送信などの実際の動作は公開フォームで動きます。'}
          </p>
        </div>
      </div>
    </div>
  )
}
