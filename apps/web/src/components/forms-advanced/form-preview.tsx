'use client'

import type { HarnessField } from '@line-crm/shared'
import { fieldTypeIcon, isDecoration } from './field-types'

const LINE_GREEN = '#06C755'

export interface FormPreviewProps {
  title: string
  description?: string | null
  fields: HarnessField[]
}

const controlClassName = 'w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm text-gray-500 disabled:cursor-not-allowed disabled:opacity-100'

function PreviewControl({ field }: { field: HarnessField }) {
  const controlId = `preview-control-${field.id}`
  const choices = field.config.choices ?? []

  switch (field.type) {
    case 'text':
      return <input id={controlId} aria-label={field.label} type="text" disabled className={controlClassName} />
    case 'textarea':
      return <textarea id={controlId} aria-label={field.label} disabled rows={3} className={controlClassName} />
    case 'number':
      return <input id={controlId} aria-label={field.label} type="number" disabled className={controlClassName} />
    case 'email':
      return <input id={controlId} aria-label={field.label} type="email" disabled className={controlClassName} />
    case 'phone':
      return <input id={controlId} aria-label={field.label} type="tel" disabled className={controlClassName} />
    case 'date':
      return <input id={controlId} aria-label={field.label} type="date" disabled className={controlClassName} />
    case 'choice':
      return (
        <div className="space-y-2">
          {choices.map((choice, index) => (
            <label key={`${choice}-${index}`} className="flex items-center gap-2 text-sm text-gray-700">
              <span className="sr-only">プレビュー </span>
              <input type="radio" name={`preview-${field.id}`} disabled className="h-4 w-4 accent-[#06C755]" />
              <span>{choice}</span>
            </label>
          ))}
        </div>
      )
    case 'dropdown':
      return (
        <select id={controlId} aria-label={field.label} disabled className={controlClassName}>
          {choices.map((choice, index) => <option key={`${choice}-${index}`}>{choice}</option>)}
        </select>
      )
    case 'multiple_select':
      return (
        <div className="space-y-2">
          {choices.map((choice, index) => (
            <label key={`${choice}-${index}`} className="flex items-center gap-2 text-sm text-gray-700">
              <span className="sr-only">プレビュー </span>
              <input type="checkbox" disabled className="h-4 w-4 accent-[#06C755]" />
              <span>{choice}</span>
            </label>
          ))}
        </div>
      )
    case 'file':
      return (
        <div className="space-y-1.5">
          <input
            id={controlId}
            aria-label={field.label}
            type="file"
            disabled
            multiple={field.config.allowMultipleFiles ?? false}
            accept={field.config.allowedExtensions?.map((extension) => `.${extension.replace(/^\./, '')}`).join(',')}
            className={controlClassName}
          />
          <p className="text-xs text-gray-500">ファイルを添付する項目です。実際の選択は公開フォームで行えます。</p>
        </div>
      )
    default:
      return null
  }
}

function PreviewField({ field }: { field: HarnessField }) {
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
          <span className="rounded px-1.5 py-0.5 text-[10px] font-bold text-white" style={{ backgroundColor: LINE_GREEN }}>
            必須
          </span>
        )}
      </div>
      <PreviewControl field={field} />
    </div>
  )
}

export default function FormPreview({ title, description, fields }: FormPreviewProps) {
  return (
    <div data-testid="form-preview" className="w-full">
      <div
        data-testid="preview-frame"
        className="mx-auto w-full overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm"
        style={{ maxWidth: 375 }}
      >
        <header className="border-t-4 border-[#06C755] px-5 pb-4 pt-5">
          <h2 className="text-xl font-bold text-gray-900">{title}</h2>
          {description && <p className="mt-2 whitespace-pre-wrap text-sm text-gray-600">{description}</p>}
        </header>

        <div className="space-y-5 border-t border-gray-100 px-5 py-5">
          {fields.map((field) => <PreviewField key={field.id} field={field} />)}

          <button
            type="button"
            disabled
            className="w-full rounded-lg px-4 py-2.5 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-60"
            style={{ backgroundColor: LINE_GREEN }}
          >
            送信
          </button>
        </div>

        <div data-testid="preview-fidelity-note" className="space-y-1.5 border-t border-gray-200 bg-gray-50 px-5 py-4 text-[11px] leading-relaxed text-gray-500">
          <p>見出しや説明文も公開フォームに表示されます。</p>
          <p>色・フォント・ロゴは公開時に Formaloo 側のテーマで決まります。</p>
          <p>これは見た目の確認用のプレビューです（read-only）。入力・条件分岐・送信などの実際の動作は公開フォームで動きます。</p>
        </div>
      </div>
    </div>
  )
}
