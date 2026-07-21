'use client'

import { useState } from 'react'
import {
  LINE_PRESET_PALETTES,
  FORM_DESIGN_COLOR_KEYS,
  MAX_IMAGE_UPLOAD_BYTES,
  DEFAULT_RATING_STAR_COLOR,
  type FormDesign,
  type FormDesignColorKey,
  type FormDesignImages,
  type FormDesignImageUpload,
  type FormDisplayType,
} from '@line-crm/shared'
import { RATING_STAR_PALETTE } from './field-types'

// =============================================================================
// form-design (Batch D) — ビルダー内「デザイン」パネル。テーマ色プリセット + 個別カラー + ロゴ/カバー画像。
// 公開ページ (Formaloo hosted) の見栄えを、管理画面を触らずビルダーだけで整える (owner 非エンジニア)。
// anti-generic: LINE green #06C755 を基調に、既製 SaaS テンプレ感を避けた温度のある配色プリセット。
// static export 互換: 既存 client component 内・動的 route 追加なし・新規 dep なし (native <input>)。
// =============================================================================

const COLOR_LABELS: Record<FormDesignColorKey, string> = {
  themeColor: 'テーマ色',
  backgroundColor: '背景色',
  buttonColor: 'ボタン色',
  textColor: '文字色',
  fieldColor: '入力欄の色',
  borderColor: '枠線の色',
  submitTextColor: '送信ボタンの文字色',
}

const COLOR_SETTING_IDS: Record<FormDesignColorKey, string> = {
  themeColor: 'design-theme-color',
  backgroundColor: 'design-background-color',
  buttonColor: 'design-button-color',
  textColor: 'design-text-color',
  fieldColor: 'design-field-color',
  borderColor: 'design-border-color',
  submitTextColor: 'design-submit-text-color',
}

// form-design-presets: プリセットを温度感で 2 グループに分ける (見出し表示 + 縦伸び対策)。
//   tone 未指定 (現行 4 種) は 'light' 扱い。カタログ順を各グループ内で維持する。
const PRESET_GROUPS: { tone: 'light' | 'dark'; label: string; presets: typeof LINE_PRESET_PALETTES }[] = [
  { tone: 'light', label: '明るい系', presets: LINE_PRESET_PALETTES.filter((p) => (p.tone ?? 'light') === 'light') },
  { tone: 'dark', label: 'ダーク系', presets: LINE_PRESET_PALETTES.filter((p) => p.tone === 'dark') },
]

const ALLOWED_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

type ImageSlot = 'logo' | 'cover'
// form-image-decoration: cover は Formaloo background_image = 公開ページ「全面」背景 (spike S-2 実測)。
//   旧ラベル「ヘッダー背景」は語義誤り (帯にはならない) だったため「背景画像（全面）」に是正。
const IMAGE_LABELS: Record<ImageSlot, string> = { logo: 'ロゴ', cover: '背景画像（全面）' }

export interface DesignPanelProps {
  design: FormDesign
  images: FormDesignImages
  onChange: (design: FormDesign) => void
  onImagesChange: (images: FormDesignImages) => void
  // form-route-branching (R2): 表示形式スイッチ (simple/multi_step)。未接続 (undefined) の呼び出しでは非表示 = 後方互換。
  formType?: FormDisplayType
  onFormTypeChange?: (t: FormDisplayType) => void
  /** jump rule 存在フラグ。simple へ戻す時の逆ガード警告に使う。 */
  hasJumpRule?: boolean
  /** b1-field-polish: rating field 存在フラグ。true のとき form-level「評価スターの色」picker を出す。 */
  hasRating?: boolean
  /** 自前公開では画像をR2へ保存し、背景はフォームカードの外側全面に描画する。 */
  internalRenderer?: boolean
}

/** 表示中の画像プレビュー URL: pending replace(dataUrl) > 既存 URL (remove 指定なら null)。 */
function slotPreview(upload: FormDesignImageUpload | undefined, existingUrl: string | null | undefined): string | null {
  if (upload?.intent === 'replace' && upload.dataUrl) return upload.dataUrl
  if (upload?.intent === 'remove') return null
  return existingUrl ?? null
}

/** native color input は 6桁 hex のみ受理。未設定/不正は白にフォールバック。 */
function colorInputValue(v: string | null | undefined): string {
  return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : '#FFFFFF'
}

export default function DesignPanel({ design, images, onChange, onImagesChange, formType, onFormTypeChange, hasJumpRule, hasRating, internalRenderer = false }: DesignPanelProps) {
  const [imageError, setImageError] = useState<string | null>(null)
  const effectiveFormType: FormDisplayType = formType ?? 'simple'
  const setColor = (key: FormDesignColorKey, value: string) => {
    // 手動で色を変えたら preset との一致は崩れる → presetId を外す。
    onChange({ ...design, [key]: value.toUpperCase(), presetId: undefined })
  }
  const applyPreset = (presetId: string) => {
    const p = LINE_PRESET_PALETTES.find((x) => x.id === presetId)
    if (!p) return
    onChange({ ...design, ...p.colors, presetId: p.id })
  }
  const onFile = (slot: ImageSlot, file: File | null) => {
    if (!file || !ALLOWED_IMAGE_MIME.includes(file.type)) return
    // F4 (plan R-4): クライアント側で 10MB 上限を弾く (worker も validateImageUpload で二重防御)。
    if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
      setImageError('画像が大きすぎます（10MB まで）。小さい画像を選んでください。')
      return
    }
    setImageError(null)
    const reader = new FileReader()
    reader.onload = () => {
      onImagesChange({ ...images, [slot]: { intent: 'replace', dataUrl: String(reader.result), mimeType: file.type, filename: file.name } })
    }
    reader.readAsDataURL(file)
  }
  const removeImage = (slot: ImageSlot) => onImagesChange({ ...images, [slot]: { intent: 'remove' } })

  return (
    <div data-testid="design-panel" className="space-y-4 text-sm">
      {/* form-route-branching (R2): フォーム表示形式スイッチ (先頭・色設定と区切る)。onFormTypeChange 未接続なら非表示。 */}
      {onFormTypeChange && (
        <div data-setting-id="form-display-type" data-testid="formtype-switch" className="rounded-lg border border-gray-200 p-2.5">
          <div className="mb-1.5 text-xs font-bold text-gray-500">フォームの表示形式</div>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-gray-100 p-1">
            {([['multi_step', '1問ずつ表示'], ['simple', '1画面表示']] as [FormDisplayType, string][]).map(([val, label]) => (
              <button
                key={val}
                type="button"
                data-testid={`formtype-${val}`}
                aria-pressed={effectiveFormType === val}
                onClick={() => onFormTypeChange(val)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium ${effectiveFormType === val ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
            {internalRenderer
              ? '自前配信では「1画面表示」でも、項目・セクションの表示切替とABCルート分岐を試せます。'
              : '「1問ずつ表示」にすると「ページへ飛ぶ」分岐が使えます。'}
          </p>
          {/* 逆ガード: jump rule があるのに simple を選んでいる → 動かない旨を警告 (許可はする=owner 自律尊重)。 */}
          {!internalRenderer && hasJumpRule && effectiveFormType === 'simple' && (
            <p data-testid="formtype-reverse-guard" role="alert" className="mt-1 text-[11px] leading-relaxed text-amber-600">
              ⚠️ ページ移動の分岐があります。「1画面表示」ではページ移動は動作しません。
            </p>
          )}
        </div>
      )}

      {/* 配色プリセット (anti-generic)。form-design-presets: 12 種に増えたので 明るい系/ダーク系 で
          グルーピングし、side panel が縦に伸びすぎないよう max-height + スクロール枠に入れる。 */}
      <div data-setting-id="design-presets">
        <div className="mb-1.5 text-xs font-bold text-gray-500">配色プリセット</div>
        <div className="max-h-72 space-y-2 overflow-y-auto pr-0.5">
          {PRESET_GROUPS.map(({ tone, label, presets }) =>
            presets.length === 0 ? null : (
              <div key={tone} data-testid={`preset-group-${tone}`}>
                <div className="mb-1 text-[11px] font-medium text-gray-400">{label}</div>
                <div className="grid grid-cols-2 gap-2">
                  {presets.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      data-testid={`preset-${p.id}`}
                      onClick={() => applyPreset(p.id)}
                      aria-pressed={design.presetId === p.id}
                      className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-left ${design.presetId === p.id ? 'border-2' : 'border border-gray-200'}`}
                      style={design.presetId === p.id ? { borderColor: p.colors.themeColor } : undefined}
                    >
                      <span className="flex -space-x-1" aria-hidden>
                        {[p.colors.themeColor, p.colors.buttonColor, p.colors.backgroundColor].map((c, i) => (
                          <span key={i} className="h-4 w-4 rounded-full border border-white" style={{ backgroundColor: c }} />
                        ))}
                      </span>
                      <span className="text-xs">{p.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ),
          )}
        </div>
      </div>

      {/* 個別カラー調整 */}
      <div>
        <div className="mb-1.5 text-xs font-bold text-gray-500">色を細かく調整</div>
        <div className="space-y-1.5">
          {FORM_DESIGN_COLOR_KEYS.map((key) => (
            <label key={key} className="flex items-center justify-between gap-2">
              <span className="text-xs text-gray-600">{COLOR_LABELS[key]}</span>
              <input
                type="color"
                data-setting-id={COLOR_SETTING_IDS[key]}
                aria-label={COLOR_LABELS[key]}
                value={colorInputValue(design[key])}
                onChange={(e) => setColor(key, e.target.value)}
                className="h-7 w-12 cursor-pointer rounded border border-gray-200 bg-white"
              />
            </label>
          ))}
        </div>
      </div>

      {/* b1-field-polish: 評価スターの色 (form-level・rating field 有時のみ)。本文色とは decouple = 星だけ着色。
          form 単位ゆえ per-field settings でなく design region に置く (per-field 誤認防止 / spec §4)。 */}
      {hasRating && (
        <div data-setting-id="design-rating-star-color" data-testid="rating-star-color">
          <div className="mb-1.5 text-xs font-bold text-gray-500">評価スターの色</div>
          <div className="flex flex-wrap gap-2">
            {RATING_STAR_PALETTE.map((c) => {
              const current = (design.ratingStarColor ?? DEFAULT_RATING_STAR_COLOR).toUpperCase()
              const selected = current === c.value.toUpperCase()
              return (
                <button
                  key={c.value}
                  type="button"
                  aria-label={`スター色 ${c.label}`}
                  aria-pressed={selected}
                  onClick={() => onChange({ ...design, ratingStarColor: c.value })}
                  className={`h-8 w-8 rounded-full ${selected ? 'border-2 border-gray-800 ring-1 ring-gray-300' : 'border border-gray-200'}`}
                  style={{ backgroundColor: c.value }}
                >
                  <span className="sr-only">{c.label}</span>
                </button>
              )
            })}
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-gray-400">
            評価（星）の色です。既定は黄色。星だけに色がつき、本文の色は変わりません。公開ページに保存時に反映されます。
          </p>
        </div>
      )}

      {/* ロゴ / カバー画像 */}
      <div>
        <div className="mb-1.5 text-xs font-bold text-gray-500">ロゴ・カバー画像</div>
        {(['logo', 'cover'] as ImageSlot[]).map((slot) => {
          const preview = slotPreview(images[slot], slot === 'logo' ? design.logoUrl : design.backgroundImageUrl)
          const label = IMAGE_LABELS[slot]
          return (
            <div key={slot} className="mb-2 rounded-lg border border-gray-200 p-2">
              <div className="mb-1 text-xs text-gray-600">{label}</div>
              <div className="flex items-center gap-2">
                {preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img data-testid={`image-preview-${slot}`} src={preview} alt={label} className="h-10 w-16 rounded border border-gray-200 object-cover" />
                ) : (
                  <span className="flex h-10 w-16 items-center justify-center rounded border border-dashed border-gray-300 text-[10px] text-gray-400">未設定</span>
                )}
                <label className="cursor-pointer rounded-lg bg-gray-100 px-2.5 py-1.5 text-xs hover:bg-gray-200">
                  画像を選ぶ
                  <input
                    type="file"
                    data-setting-id={`design-${slot === 'logo' ? 'logo' : 'cover'}-image`}
                    accept={ALLOWED_IMAGE_MIME.join(',')}
                    aria-label={`${label}を選ぶ`}
                    className="hidden"
                    onChange={(e) => onFile(slot, e.target.files?.[0] ?? null)}
                  />
                </label>
                {preview && (
                  <button type="button" aria-label={`${label}を削除`} onClick={() => removeImage(slot)} className="text-xs text-gray-400 hover:text-red-600">
                    削除
                  </button>
                )}
              </div>
              {slot === 'cover' && (
                <p data-testid="cover-readability-note" className="mt-1.5 text-[11px] leading-relaxed text-amber-600">
                  {internalRenderer ? (
                    <>背景画像は公開ページの<strong>フォーム本体の外側全面</strong>に敷かれ、入力部分は「入力欄の色」のカードとして重なります。</>
                  ) : (
                    <>背景画像は公開ページの<strong>全面</strong>に敷かれます。文字が写真の上に直接乗るため、明るい・淡い写真を選ぶか、読みやすさを優先する場合は「装飾 ＞ 画像」をフォームの先頭に置いて<strong>帯（ヘッダー画像）</strong>にするのがおすすめです。</>
                  )}
                </p>
              )}
            </div>
          )
        })}
        {imageError && (
          <p data-testid="image-error" role="alert" className="mb-1 text-[11px] text-red-600">{imageError}</p>
        )}
        <p className="text-[11px] leading-relaxed text-gray-400">
          {internalRenderer
            ? '画像は保存時に自社の画像保存先へアップロードされ、公開ページに反映されます（PNG / JPG / GIF / WebP・10MB まで）。'
            : '画像は保存時に Formaloo にアップロードされ、公開ページに反映されます（PNG / JPG / GIF / WebP・10MB まで）。'}
        </p>
      </div>
    </div>
  )
}
