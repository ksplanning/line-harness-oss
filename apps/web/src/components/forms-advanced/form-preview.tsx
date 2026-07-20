'use client'

import { useState } from 'react'
import { DEFAULT_RATING_STAR_COLOR, DEFAULT_VIDEO_HEIGHT, IMAGE_WIDTH_TO_MAXWIDTH } from '@line-crm/shared'
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

function PreviewControl({ field, ratingStarColor }: { field: HarnessField; ratingStarColor?: string }) {
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
    case 'time':
      return <input id={controlId} aria-label={field.label} type="time" value={value} onChange={(e) => setValue(e.target.value)} className={inputClassName} />
    case 'website':
      return <input id={controlId} aria-label={field.label} type="url" value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://example.com" className={inputClassName} />
    case 'city':
      return <input id={controlId} aria-label={field.label} type="text" value={value} onChange={(e) => setValue(e.target.value)} placeholder="例: 千代田区" className={inputClassName} />
    case 'yes_no':
      return (
        <div id={controlId} role="group" aria-label={field.label} className="space-y-2">
          {[
            { value: 'yes', label: 'はい' },
            { value: 'no', label: 'いいえ' },
          ].map((option) => (
            <label key={option.value} className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="radio"
                name={`preview-${field.id}`}
                value={option.value}
                checked={value === option.value}
                onChange={() => setValue(option.value)}
                className="h-4 w-4 accent-[#06C755]"
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      )
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
        <select id={controlId} aria-label={field.label} className={inputClassName} disabled={items.length === 0}>
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
        return <input data-testid="preview-rating" id={controlId} aria-label={field.label} type="number" value={value} onChange={(e) => setValue(e.target.value)} className={inputClassName} />
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
function PreviewField({ field, themeColor, textColor, fieldColor, ratingStarColor }: { field: HarnessField; themeColor: string; textColor?: string; fieldColor?: string; ratingStarColor?: string }) {
  const textStyle = textColor ? { color: textColor } : undefined
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
      <PreviewControl field={field} ratingStarColor={ratingStarColor} />
    </div>
  )
}

export default function FormPreview({ title, description, fields, design, formType, logic }: FormPreviewProps) {
  const isMultiStep = formType === 'multi_step'
  const hasJump = Array.isArray(logic) && logic.some((r) => r.action === 'jump')
  // route-terminal-submit: 「ここで送信」凡例 + page_break の Continue のみ空画面注記。
  const hasSubmit = Array.isArray(logic) && logic.some((r) => r.action === 'submit')
  const hasPageBreak = fields.some((f) => f.type === 'page_break')
  const hasVariable = fields.some((field) => field.type === 'variable')
  const hasChoiceFetch = fields.some((field) => field.type === 'choice_fetch')
  // form-design (Batch D): テーマ色/ロゴ/カバーを反映。未指定は従来の LINE green 既定 (後方互換)。
  const themeColor = design?.themeColor || LINE_GREEN
  const buttonColor = design?.buttonColor || LINE_GREEN
  const submitTextColor = design?.submitTextColor || '#FFFFFF'
  const bgColor = design?.backgroundColor || '#FFFFFF'
  const textColor = design?.textColor || undefined
  // form-design-presets (F-HIGH-1): section の light box をダーク preset で追随させ、textColor(=light) を可読にする。
  const fieldColor = design?.fieldColor || undefined
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
          {fields.map((field) => <PreviewField key={field.id} field={field} themeColor={themeColor} textColor={textColor} fieldColor={fieldColor} ratingStarColor={ratingStarColor} />)}

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
          {/* route-terminal-submit: 「ここで送信」凡例 (submit rule のある項目でルートを閉じる)。 */}
          {hasSubmit && (
            <p data-testid="preview-submit-note">「ここで送信」を設定した項目では、その項目に回答するとルートを閉じて完了ページへ送信します（以降の質問はスキップ）。</p>
          )}
          {/* route-terminal-submit: page_break は hosted で Continue のみの空画面を1枚挟む。 */}
          {hasPageBreak && (
            <p data-testid="preview-pagebreak-note">改ページは、公開フォームでは「Continue」だけの空画面を1枚挟みます（Formaloo の仕様）。</p>
          )}
          {hasVariable && (
            <p data-testid="preview-variable-note">計算項目の実際の結果は、他の回答値を使って公開フォーム側で計算されます。このプレビューでは結果を作りません。</p>
          )}
          {hasChoiceFetch && (
            <p data-testid="preview-choice-fetch-note">動的選択肢は現在保存しているリストを表示しています。公開フォームでは供給URLから最新値を読み込みます。</p>
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
