'use client'

import { useState } from 'react'
import {
  LINE_PRESET_PALETTES,
  FORM_DESIGN_COLOR_KEYS,
  MAX_IMAGE_UPLOAD_BYTES,
  type FormDesign,
  type FormDesignColorKey,
  type FormDesignImages,
  type FormDesignImageUpload,
} from '@line-crm/shared'

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

const ALLOWED_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

type ImageSlot = 'logo' | 'cover'
const IMAGE_LABELS: Record<ImageSlot, string> = { logo: 'ロゴ', cover: 'カバー画像（ヘッダー背景）' }

export interface DesignPanelProps {
  design: FormDesign
  images: FormDesignImages
  onChange: (design: FormDesign) => void
  onImagesChange: (images: FormDesignImages) => void
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

export default function DesignPanel({ design, images, onChange, onImagesChange }: DesignPanelProps) {
  const [imageError, setImageError] = useState<string | null>(null)
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
      {/* 配色プリセット (anti-generic) */}
      <div>
        <div className="mb-1.5 text-xs font-bold text-gray-500">配色プリセット</div>
        <div className="grid grid-cols-2 gap-2">
          {LINE_PRESET_PALETTES.map((p) => (
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

      {/* 個別カラー調整 */}
      <div>
        <div className="mb-1.5 text-xs font-bold text-gray-500">色を細かく調整</div>
        <div className="space-y-1.5">
          {FORM_DESIGN_COLOR_KEYS.map((key) => (
            <label key={key} className="flex items-center justify-between gap-2">
              <span className="text-xs text-gray-600">{COLOR_LABELS[key]}</span>
              <input
                type="color"
                aria-label={COLOR_LABELS[key]}
                value={colorInputValue(design[key])}
                onChange={(e) => setColor(key, e.target.value)}
                className="h-7 w-12 cursor-pointer rounded border border-gray-200 bg-white"
              />
            </label>
          ))}
        </div>
      </div>

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
            </div>
          )
        })}
        {imageError && (
          <p data-testid="image-error" role="alert" className="mb-1 text-[11px] text-red-600">{imageError}</p>
        )}
        <p className="text-[11px] leading-relaxed text-gray-400">
          画像は保存時に Formaloo にアップロードされ、公開ページに反映されます（PNG / JPG / GIF / WebP・10MB まで）。
        </p>
      </div>
    </div>
  )
}
