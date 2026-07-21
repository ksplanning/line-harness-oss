'use client'

import { useCallback, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { LINE_MEDIA_LIMITS } from '@line-crm/shared'
import { createLinePreview, isAnimatedPng, readImageDimensions } from '@/lib/line-image-transform'

export type ImageUploaderMode = 'url' | 'line-image'
export type ImageUploaderUsage = 'generic' | 'flex-image' | 'flex-icon' | 'line-preview' | 'sender-icon'

export type ImageUploaderValue =
  | { mode: 'url'; url: string }
  | { mode: 'line-image'; originalContentUrl: string; previewImageUrl: string }

export interface ImageUploaderProps {
  mode: ImageUploaderMode
  value: ImageUploaderValue | null
  onChange: (next: ImageUploaderValue | null) => void
  label?: string
  usage?: ImageUploaderUsage
}

/**
 * 汎用画像アップローダー: ボタン + D&D + クリップボードペースト + プレビュー。
 *
 * mode='url' は単一 URL を返す (Event / Staff など)。
 * mode='line-image' は {originalContentUrl, previewImageUrl} を返す (Broadcast / Auto-reply / Template / Chats)。
 * line-image は原画像を 10MB まで受理し、LINE の preview 上限 1MB 以下を自動生成する。
 */
export default function ImageUploader({ mode, value, onChange, label, usage = 'generic' }: ImageUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [manualUrlMode, setManualUrlMode] = useState(false)

  const upload = useCallback(
    async (file: File) => {
      if (!file.type.startsWith('image/')) {
        setError('画像ファイルのみアップロードできます')
        return
      }
      if (usage === 'sender-icon' && file.type !== 'image/png') {
        setError('送信者アイコンは PNG のみ対応しています')
        return
      }
      if (mode === 'line-image' && !['image/jpeg', 'image/png'].includes(file.type)) {
        setError('LINE 送信用は JPEG または PNG のみ対応')
        return
      }
      if (mode === 'url' && usage !== 'generic' && !['image/jpeg', 'image/png'].includes(file.type)) {
        setError('このLINE画像は JPEG または PNG のみ対応しています')
        return
      }
      const maxBytes = usage === 'flex-icon' || usage === 'line-preview' || usage === 'sender-icon'
        ? LINE_MEDIA_LIMITS.previewImageBytes
        : LINE_MEDIA_LIMITS.messageImageBytes
      if (file.size > maxBytes) {
        setError(maxBytes === LINE_MEDIA_LIMITS.previewImageBytes ? '1MB 以下にしてください' : '10MB 以下にしてください')
        return
      }
      setBusy(true)
      setError('')
      try {
        if (
          usage === 'flex-image'
          && file.size > LINE_MEDIA_LIMITS.flexAnimatedImageBytes
          && await isAnimatedPng(file)
        ) {
          setError('FlexのアニメーションPNGは300KB以下にしてください')
          return
        }
        if (usage === 'sender-icon' || usage === 'flex-image' || usage === 'flex-icon') {
          const { width, height } = await readImageDimensions(file)
          if (usage === 'sender-icon' && width !== height) {
            setError('送信者アイコンは正方形（縦横比1:1）にしてください')
            return
          }
          if ((usage === 'flex-image' || usage === 'flex-icon') && (width > 1024 || height > 1024)) {
            setError('Flex画像の縦横は1024px以下にしてください')
            return
          }
        }
        if (mode === 'url') {
          const res = await api.uploads.image(file)
          if (!res.success) {
            setError(res.error ?? 'アップロード失敗')
            return
          }
          onChange({ mode: 'url', url: res.data.url })
        } else {
          const preview = await createLinePreview(file)
          const originalResult = await api.uploads.image(file)
          if (!originalResult.success) {
            setError(originalResult.error ?? '元画像のアップロードに失敗しました')
            return
          }
          if (preview === file) {
            onChange({
              mode: 'line-image',
              originalContentUrl: originalResult.data.url,
              previewImageUrl: originalResult.data.url,
            })
            return
          }
          const previewResult = await api.uploads.image(preview as File)
          if (!previewResult.success) {
            setError(previewResult.error ?? 'プレビュー画像のアップロードに失敗しました')
            return
          }
          onChange({
            mode: 'line-image',
            originalContentUrl: originalResult.data.url,
            previewImageUrl: previewResult.data.url,
          })
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'アップロード失敗')
      } finally {
        setBusy(false)
      }
    },
    [mode, onChange, usage],
  )

  const handleFiles = useCallback(
    (files: FileList | null) => {
      const f = files?.[0]
      if (f) void upload(f)
    },
    [upload],
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      handleFiles(e.dataTransfer.files)
    },
    [handleFiles],
  )

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const item = [...e.clipboardData.items].find((i) => i.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (file) void upload(file)
    },
    [upload],
  )

  const previewUrl =
    value === null
      ? null
      : value.mode === 'url'
        ? value.url
        : value.previewImageUrl

  return (
    <div className="space-y-2">
      {label && <div className="text-sm font-medium text-gray-700">{label}</div>}
      {mode === 'url' && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => setManualUrlMode((v) => !v)}
            className="text-xs text-emerald-700 underline"
          >
            {manualUrlMode ? '画像アップロードに戻す' : 'URL を直接入力'}
          </button>
        </div>
      )}
      {mode === 'url' && manualUrlMode ? (
        <input
          type="url"
          maxLength={2000}
          value={value?.mode === 'url' ? value.url : ''}
          onChange={(e) => {
            const url = e.target.value
            onChange(url ? { mode: 'url', url } : null)
          }}
          placeholder="https://... (外部 CDN / R2 URL)"
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
        />
      ) : (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          onPaste={onPaste}
          tabIndex={0}
          className="rounded-lg border-2 border-dashed border-gray-300 bg-white p-4 transition-colors hover:border-gray-400 focus:border-emerald-500 focus:outline-none"
        >
          {previewUrl ? (
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previewUrl} alt="" className="h-24 w-24 rounded object-cover ring-1 ring-gray-200" />
              <div className="flex-1 space-y-2">
                <button
                  type="button"
                  onClick={() => inputRef.current?.click()}
                  className="text-xs font-medium text-gray-700 underline"
                >
                  差し替え
                </button>
                <button
                  type="button"
                  onClick={() => onChange(null)}
                  className="ml-3 text-xs font-medium text-rose-600 underline"
                >
                  取り消し
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 py-4 text-sm text-gray-500">
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={busy}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {busy ? 'アップロード中…' : '📎 画像を選択'}
              </button>
              <div className="text-xs text-gray-400">またはドラッグ&ドロップ / Cmd+V でペースト</div>
            </div>
          )}
          <input
            ref={inputRef}
            type="file"
            accept={usage === 'sender-icon'
              ? 'image/png'
              : mode === 'line-image' || usage !== 'generic'
                ? 'image/jpeg,image/png'
                : 'image/*'}
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
        </div>
      )}
      {error && <div className="text-xs text-rose-600">{error}</div>}
      <p className="text-xs text-gray-400">
        {mode === 'line-image'
          ? 'JPEG / PNG・元画像は10MBまで。プレビューは1MB以下へ自動縮小します。'
          : usage === 'flex-image'
            ? 'Flex画像はJPEG / PNG・縦横1024px以下・10MBまで（実用上は1MB以下を推奨、アニメーションは300KBまで）。'
            : usage === 'flex-icon'
              ? 'FlexアイコンはJPEG / PNG・縦横1024px以下・1MBまで。'
              : usage === 'line-preview'
                ? 'プレビュー画像はJPEG / PNG・1MBまで。'
                : usage === 'sender-icon'
                  ? '送信者アイコンはPNG・1MBまで・縦横比1:1にしてください（LINE公式仕様）。'
                  : 'JPEG / PNG / GIF / WebP・10MBまで。'}
      </p>
    </div>
  )
}
