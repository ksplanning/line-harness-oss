import { useRef, useState, type ChangeEvent } from 'react'
import { MAX_IMAGE_UPLOAD_BYTES, IMAGE_WIDTH_TO_MAXWIDTH, type HarnessFieldConfig, type ImageWidth } from '@line-crm/shared'
import { IMAGE_WIDTH_OPTIONS } from './field-types'

// =============================================================================
// image-field-panel — 差し込み画像 (in-body decoration image) の設定 UI (T-B1)
// -----------------------------------------------------------------------------
// owner ②「ストレス無く」= 少ない操作で自然に収まる: ファイルを選ぶ or URL を貼る → 幅を 小/中/全幅 で選ぶだけ。
// spike S-1 実測: 保存時に画像は harness R2 へ upload され、公開ページの当該位置に max-width % で実描画される。
// AI 生成ボタンは付けない (excluded_scope: BYOK / gpt-image-2 は別段階・owner 判断項目)。
// =============================================================================

const ACCEPT_MIME = 'image/png,image/jpeg,image/gif,image/webp'
const LINE_GREEN = '#06C755'

/** 表示中プレビュー: pending replace(dataUrl) > 既存 imageUrl。remove 指定は null。 */
function previewSrc(config: HarnessFieldConfig): string | null {
  const up = config.imageUpload
  if (up?.intent === 'replace' && up.dataUrl) return up.dataUrl
  if (up?.intent === 'remove') return null
  return config.imageUrl || null
}

export default function ImageFieldPanel({
  config,
  onChange,
}: {
  config: HarnessFieldConfig
  onChange: (patch: Partial<HarnessFieldConfig>) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const width: ImageWidth = config.imageWidth ?? 'medium'
  const src = previewSrc(config)

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setError(null)
    // クライアント側 10MB 上限 (worker/shared も validateImageUpload で二重防御 / R-4)。
    if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
      setError('画像が大きすぎます（10MB まで）。小さい画像を選んでください。')
      return
    }
    const reader = new FileReader()
    reader.onload = () =>
      onChange({
        imageUpload: { intent: 'replace', dataUrl: String(reader.result), mimeType: file.type, filename: file.name },
        imageUrl: undefined, // upload 優先 (worker が R2 解決後 imageUrl を確定)
      })
    reader.readAsDataURL(file)
  }

  const removeImage = () => {
    onChange({ imageUpload: { intent: 'remove' }, imageUrl: undefined })
    if (fileRef.current) fileRef.current.value = ''
    setError(null)
  }

  return (
    <div className="space-y-3" data-testid="image-field-panel">
      {src && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-2">
          {/* プレビューは選んだ表示幅で確認できる (public と同じ max-width %)。 */}
          <img
            src={src}
            alt={config.imageAlt || 'プレビュー'}
            style={{ maxWidth: IMAGE_WIDTH_TO_MAXWIDTH[width], borderRadius: 8, display: 'block', margin: '0 auto' }}
          />
        </div>
      )}

      <div>
        <label className="block text-xs text-gray-500 mb-1">画像を選ぶ</label>
        <input
          ref={fileRef}
          type="file"
          aria-label="画像ファイル"
          accept={ACCEPT_MIME}
          onChange={onFile}
          className="block w-full text-xs text-gray-600 file:mr-2 file:rounded file:border-0 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white"
          style={{ ['--tw-file-bg' as string]: LINE_GREEN }}
        />
        <p className="mt-1 text-[10px] text-gray-400 leading-snug">
          パソコン / スマホの画像を選べます（PNG / JPG / GIF / WebP・10MB まで）。保存時に公開ページへ反映されます。
        </p>
        {error && <p className="mt-1 text-[11px] text-red-500" role="alert">{error}</p>}
      </div>

      <div>
        <label className="block text-xs text-gray-500 mb-1" htmlFor={`image-url-${config.imageAlt ?? ''}`}>または画像URLを貼る</label>
        <input
          aria-label="画像URL"
          value={config.imageUrl ?? ''}
          onChange={(e) => onChange({ imageUrl: e.target.value, imageUpload: undefined })}
          placeholder="https://..."
          className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
        />
      </div>

      <div>
        <label className="block text-xs text-gray-500 mb-1">代替テキスト（読み上げ・表示できない時の説明）</label>
        <input
          aria-label="代替テキスト"
          value={config.imageAlt ?? ''}
          onChange={(e) => onChange({ imageAlt: e.target.value })}
          placeholder="例：夏のキャンペーン告知バナー"
          className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
        />
      </div>

      <div>
        <label className="block text-xs text-gray-500 mb-1">表示サイズ（スマホでも崩れません）</label>
        <div className="flex gap-1.5" role="group" aria-label="表示サイズ">
          {IMAGE_WIDTH_OPTIONS.map((opt) => {
            const active = width === opt.value
            return (
              <button
                key={opt.value}
                type="button"
                aria-pressed={active}
                onClick={() => onChange({ imageWidth: opt.value })}
                className="flex-1 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors"
                style={
                  active
                    ? { borderColor: LINE_GREEN, backgroundColor: '#E9FBF1', color: '#0A6B3B' }
                    : { borderColor: '#D1D5DB', backgroundColor: '#FFFFFF', color: '#6B7280' }
                }
              >
                {opt.label}
              </button>
            )
          })}
        </div>
      </div>

      {src && (
        <button type="button" onClick={removeImage} className="text-[11px] text-red-500 hover:underline">
          画像を削除
        </button>
      )}
    </div>
  )
}
