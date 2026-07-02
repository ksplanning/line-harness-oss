'use client'

import { useState, useEffect } from 'react'
import { buildQrImageUrl, qrDownloadFilename } from '@/lib/shared/qr'

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? ''

interface QrDialogProps {
  url: string // encodeURIComponent 前の実 URL
  name: string // リンク名 (dialog タイトル補足)
  onClose: () => void
}

export default function QrDialog({ url, name, onClose }: QrDialogProps) {
  const [imgError, setImgError] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const imgSrc = buildQrImageUrl(API_BASE, url)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const handleDownload = async () => {
    setDownloading(true)
    try {
      const res = await fetch(imgSrc)
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = objectUrl
      a.download = qrDownloadFilename(name)
      a.click()
      URL.revokeObjectURL(objectUrl)
    } catch {
      // silent — 画面には img が残る
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-sm">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h3 className="text-base font-semibold text-gray-900">QRコード（お店に貼る用）</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
            aria-label="閉じる"
          >
            ×
          </button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-sm font-medium text-gray-800">{name}</p>

          <div className="flex justify-center">
            {imgError ? (
              <div className="w-[240px] h-[240px] flex items-center justify-center bg-gray-50 border border-gray-200 rounded-md text-sm text-gray-500 text-center px-4">
                QRコードの読み込みに失敗しました
              </div>
            ) : (
              <img
                src={imgSrc}
                alt={`${name} の QRコード`}
                width={240}
                height={240}
                onError={() => setImgError(true)}
                className="border border-gray-200 rounded-md"
              />
            )}
          </div>

          <div className="text-xs text-gray-500 break-all">
            URL: {url}
          </div>

          <div className="flex gap-2">
            <button
              onClick={handleDownload}
              disabled={downloading || imgError}
              className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
              style={{ backgroundColor: '#06C755' }}
            >
              {downloading ? '保存中...' : 'PNG をダウンロード'}
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
            >
              閉じる
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
