'use client'

import { useState } from 'react'
import type { HarnessField, HarnessLogicRule, FormDesign, FormDisplayType } from '@line-crm/shared'
import { fieldTypeIcon, isDecoration } from './field-types'

const LINE_GREEN = '#06C755'

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
}

// 入力可能プレビュー (②): type できる control の見た目 (白背景・濃い文字)。
const inputClassName = 'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-800'
// file は type 対象でない (実選択は公開フォーム) ため read-only 表示のまま。
const disabledClassName = 'w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-500 disabled:cursor-not-allowed disabled:opacity-100'

function PreviewControl({ field }: { field: HarnessField }) {
  const controlId = `preview-control-${field.id}`
  const choices = field.config.choices ?? []
  // ② プレビュー入力可能化: 入力値は local state のみ (どこにも送信しない = form/submit 無し)。
  //   自前描画ゆえ、hosted で不可能な「残り文字数ライブカウンター」もプレビュー内で提供できる (text の maxLength)。
  const [value, setValue] = useState('')

  switch (field.type) {
    case 'text': {
      const max = typeof field.config.maxLength === 'number' ? field.config.maxLength : undefined
      const over = max !== undefined && value.length > max
      return (
        <div className="space-y-1">
          <input
            id={controlId}
            aria-label={field.label}
            type="text"
            value={value}
            maxLength={max}
            onChange={(e) => setValue(e.target.value)}
            className={inputClassName}
          />
          {max !== undefined && (
            <p data-testid="preview-char-counter" className={`text-xs ${over ? 'text-red-500' : 'text-gray-400'}`}>
              残り {Math.max(0, max - value.length)} 文字
            </p>
          )}
        </div>
      )
    }
    case 'textarea':
      return <textarea id={controlId} aria-label={field.label} rows={3} value={value} onChange={(e) => setValue(e.target.value)} className={inputClassName} />
    case 'number':
      return <input id={controlId} aria-label={field.label} type="number" value={value} onChange={(e) => setValue(e.target.value)} className={inputClassName} />
    case 'email':
      return <input id={controlId} aria-label={field.label} type="email" value={value} onChange={(e) => setValue(e.target.value)} className={inputClassName} />
    case 'phone':
      return <input id={controlId} aria-label={field.label} type="tel" value={value} onChange={(e) => setValue(e.target.value)} className={inputClassName} />
    case 'date':
      return <input id={controlId} aria-label={field.label} type="date" value={value} onChange={(e) => setValue(e.target.value)} className={inputClassName} />
    case 'choice':
      return (
        <div className="space-y-2">
          {choices.map((choice, index) => (
            <label key={`${choice}-${index}`} className="flex items-center gap-2 text-sm text-gray-700">
              <span className="sr-only">プレビュー </span>
              <input type="radio" name={`preview-${field.id}`} className="h-4 w-4 accent-[#06C755]" />
              <span>{choice}</span>
            </label>
          ))}
        </div>
      )
    case 'dropdown':
      return (
        <select id={controlId} aria-label={field.label} className={inputClassName}>
          {choices.map((choice, index) => <option key={`${choice}-${index}`}>{choice}</option>)}
        </select>
      )
    case 'multiple_select':
      return (
        <div className="space-y-2">
          {choices.map((choice, index) => (
            <label key={`${choice}-${index}`} className="flex items-center gap-2 text-sm text-gray-700">
              <span className="sr-only">プレビュー </span>
              <input type="checkbox" className="h-4 w-4 accent-[#06C755]" />
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
    default:
      return null
  }
}

function PreviewField({ field, themeColor }: { field: HarnessField; themeColor: string }) {
  if (isDecoration(field.type)) {
    if (field.type === 'section') {
      return (
        <div data-testid="preview-section" className="rounded-lg bg-[#F0FFF6] px-4 py-3">
          <h3 className="font-bold text-gray-900">{field.label}</h3>
          {field.config.text && <p className="mt-1 whitespace-pre-wrap text-sm text-gray-600">{field.config.text}</p>}
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
        <label htmlFor={`preview-control-${field.id}`} className="text-sm font-medium text-gray-800">{field.label}</label>
        {field.required && (
          <span className="rounded px-1.5 py-0.5 text-[10px] font-bold text-white" style={{ backgroundColor: themeColor }}>
            必須
          </span>
        )}
      </div>
      {/* 補足説明 (Help text) をラベル直下に表示。公開フォームでも項目の Help text として出る。 */}
      {field.config.description && (
        <p data-testid="preview-field-description" className="whitespace-pre-wrap text-xs text-gray-500">{field.config.description}</p>
      )}
      {/* ② 一行テキストの maxLength は入力に実際に効かせ、「残り N 文字」ライブカウンターを PreviewControl 内に表示。
          hosted 公開フォームは「N文字まで」静的注記+超過エラーで実効 (下の忠実性注記で開示)。 */}
      <PreviewControl field={field} />
    </div>
  )
}

export default function FormPreview({ title, description, fields, design, formType, logic }: FormPreviewProps) {
  const isMultiStep = formType === 'multi_step'
  const hasJump = Array.isArray(logic) && logic.some((r) => r.action === 'jump')
  // form-design (Batch D): テーマ色/ロゴ/カバーを反映。未指定は従来の LINE green 既定 (後方互換)。
  const themeColor = design?.themeColor || LINE_GREEN
  const buttonColor = design?.buttonColor || LINE_GREEN
  const submitTextColor = design?.submitTextColor || '#FFFFFF'
  const bgColor = design?.backgroundColor || '#FFFFFF'
  const textColor = design?.textColor || undefined
  const logoUrl = design?.logoUrl || null
  const coverUrl = design?.backgroundImageUrl || null
  // 視覚に効く design key があれば fidelity note を「反映しています」に更新 (無ければ従来 note)。
  const hasVisualDesign = Boolean(
    design && (design.themeColor || design.backgroundColor || design.buttonColor || design.textColor || design.logoUrl || design.backgroundImageUrl),
  )

  return (
    <div data-testid="form-preview" className="w-full">
      <div
        data-testid="preview-frame"
        className="mx-auto w-full overflow-hidden rounded-2xl border border-gray-200 shadow-sm"
        style={{ maxWidth: 375, backgroundColor: bgColor }}
      >
        <header
          className="border-t-4 px-5 pb-4 pt-5"
          style={{
            borderTopColor: themeColor,
            ...(coverUrl ? { backgroundImage: `url(${coverUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' } : {}),
          }}
          {...(coverUrl ? { 'data-testid': 'preview-cover' } : {})}
        >
          {logoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img data-testid="preview-logo" src={logoUrl} alt="ロゴ" className="mb-2 h-10 w-auto object-contain" />
          )}
          <h2 className="text-xl font-bold" style={{ color: textColor ?? '#111827' }}>{title}</h2>
          {description && <p className="mt-2 whitespace-pre-wrap text-sm" style={{ color: textColor ?? '#4B5563' }}>{description}</p>}
        </header>

        <div className="space-y-5 border-t border-gray-100 px-5 py-5" style={textColor ? { color: textColor } : undefined}>
          {fields.map((field) => <PreviewField key={field.id} field={field} themeColor={themeColor} />)}

          <button
            type="button"
            disabled
            className="w-full rounded-lg px-4 py-2.5 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60"
            style={{ backgroundColor: buttonColor, color: submitTextColor }}
          >
            送信
          </button>
        </div>

        <div data-testid="preview-fidelity-note" className="space-y-1.5 border-t border-gray-200 bg-gray-50 px-5 py-4 text-[11px] leading-relaxed text-gray-500">
          <p>見出しや説明文も公開フォームに表示されます。</p>
          {/* form-route-branching (R5 / Batch C 整合): 表示形式と jump の注記。 */}
          {isMultiStep && (
            <p data-testid="preview-multistep-note">このフォームは「1問ずつ表示」です。公開フォームでは1問ずつ順に表示されます。</p>
          )}
          {hasJump && (
            <p data-testid="preview-jump-note">「ページへ飛ぶ」分岐は、公開フォーム（1問ずつ表示）でのみ動作します。</p>
          )}
          {hasVisualDesign ? (
            <p>設定したテーマ色・ロゴ/カバーを反映しています。細かなフォント・余白は公開時に Formaloo 側で微調整されます。</p>
          ) : (
            <p>色・フォント・ロゴは公開時に Formaloo 側のテーマで決まります。</p>
          )}
          <p>このプレビューでは一行テキストに残り文字数カウンターが出るので、文字数制限をその場で試せます。公開フォーム（Formaloo）では「N文字まで」の静的注記と超過時のエラーで制限され、入力しながら減る残り文字数カウンターは表示されません。</p>
          <p>このプレビューでは入力を試せます（入力内容はどこにも送信されません）。条件分岐・送信などの実際の動作は公開フォームで動きます。</p>
        </div>
      </div>
    </div>
  )
}
