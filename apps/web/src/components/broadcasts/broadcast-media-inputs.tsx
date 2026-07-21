'use client'

import { useEffect, useRef, useState } from 'react'
import ImageUploader from '@/components/shared/image-uploader'
import PersonalizedTextEditor from '@/components/shared/personalized-text-editor'
import { buildMediaJson, initialMediaState, num, parseMediaJson, type MediaMessageType, type MediaState } from '@/lib/broadcast-media'
import ImagemapRegionEditor from './imagemap-region-editor'
import HelpPopover from '@/components/help/help-popover'
import { api } from '@/lib/api'
import { LINE_MEDIA_LIMITS } from '@line-crm/shared'
import { createImagemapVariants } from '@/lib/line-image-transform'

/** broadcast の新メッセージ種別 (動画/音声/リッチメッセージ/リッチビデオ) の入力欄。
 *  入力を messageContent の JSON 文字列に直列化して onChange で親へ渡す (server が正典検証)。 */

export type { MediaMessageType }

const fieldCls = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500'
const labelCls = 'block text-xs font-medium text-gray-600 mb-1'

export default function BroadcastMediaInputs({
  messageType,
  onChange,
  initialContent,
}: {
  messageType: MediaMessageType
  onChange: (json: string) => void
  /** 保存済み messageContent (再編集時)。指定時はここから編集 state を復元する (T-A2 / 未指定=新規)。 */
  initialContent?: string
}) {
  const [s, setS] = useState<MediaState>(() =>
    initialContent && initialContent.trim() ? parseMediaJson(messageType, initialContent) : initialMediaState,
  )
  // ImageMap は Q4=ドラッグ既定。数値入力は補助 (後方互換 + 微調整) としてトグルで併存。
  const [imagemapMode, setImagemapMode] = useState<'drag' | 'numeric'>('drag')
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const previousMessageType = useRef(messageType)

  // 種別が切り替わったら、その種別の現在入力から messageContent を再直列化して同期する。
  useEffect(() => {
    if (previousMessageType.current === messageType) return
    previousMessageType.current = messageType
    onChange(buildMediaJson(messageType, s))
    // messageType 変更時のみ再同期 (state/onChange の変化では回さない)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageType])

  function patch(p: Partial<MediaState>) {
    const next = { ...s, ...p }
    setS(next)
    onChange(buildMediaJson(messageType, next))
  }

  async function uploadDirect(kind: 'video' | 'audio', file: File | undefined) {
    if (!file) return
    if (file.size > LINE_MEDIA_LIMITS.directUploadBytes) {
      setUploadError('直接アップロードは100MBまでです')
      return
    }
    setUploading(true)
    setUploadError('')
    try {
      const result = kind === 'video'
        ? await api.uploads.video(file)
        : await api.uploads.audio(file)
      if (!result.success) {
        setUploadError(result.error ?? 'アップロードに失敗しました')
        return
      }
      patch(kind === 'video' ? { videoUrl: result.data.url } : { audioUrl: result.data.url })
    } catch {
      setUploadError('アップロードに失敗しました')
    } finally {
      setUploading(false)
    }
  }

  async function uploadImagemap(file: File | undefined) {
    if (!file) return
    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      setUploadError('ImagemapはJPEGまたはPNGを選んでください')
      return
    }
    if (file.size > LINE_MEDIA_LIMITS.imagemapImageBytes) {
      setUploadError('Imagemapの元画像は10MBまでです')
      return
    }
    setUploading(true)
    setUploadError('')
    try {
      const variants = await createImagemapVariants(file)
      const uploadId = crypto.randomUUID()
      const results = []
      for (const variant of variants) {
        results.push(await api.uploads.imagemap(variant.blob, variant.width, uploadId))
      }
      const failed = results.find((result) => !result.success)
      if (failed && !failed.success) {
        setUploadError(failed.error ?? 'Imagemapのアップロードに失敗しました')
        return
      }
      const first = results[0]
      const sourceVariant = variants.find((variant) => variant.width === 1040)
      if (first?.success) patch({
        baseUrl: first.data.baseUrl,
        baseW: '1040',
        baseH: sourceVariant ? String(sourceVariant.height) : s.baseH,
      })
    } catch (cause) {
      setUploadError(cause instanceof Error ? cause.message : 'Imagemapのアップロードに失敗しました')
    } finally {
      setUploading(false)
    }
  }

  if (messageType === 'video') {
    return (
      <div className="space-y-2">
        <div>
          <label className={labelCls}>動画を直接アップロード（MP4・最大100MB）</label>
          <input type="file" accept="video/mp4" disabled={uploading} onChange={(e) => void uploadDirect('video', e.target.files?.[0])} className="block w-full text-xs text-gray-600" />
        </div>
        <div>
          <label className={labelCls}>動画ファイルのURL（mp4・https）<span className="text-red-500">*</span></label>
          <input type="text" maxLength={2000} className={fieldCls} placeholder="https://example.com/video.mp4" value={s.videoUrl} onChange={(e) => patch({ videoUrl: e.target.value })} />
        </div>
        <div>
          <label className={labelCls}>プレビュー画像のURL（https）<span className="text-red-500">*</span></label>
          <ImageUploader
            mode="line-image"
            value={s.previewUrl ? { mode: 'line-image' as const, originalContentUrl: s.previewUrl, previewImageUrl: s.previewUrl } : null}
            onChange={(v) => patch({ previewUrl: v?.mode === 'line-image' ? v.previewImageUrl : '' })}
            label="プレビュー画像（アップロード）"
          />
          <input type="text" maxLength={2000} className={`${fieldCls} mt-1`} placeholder="または画像URLを直接入力 (https://...)" value={s.previewUrl} onChange={(e) => patch({ previewUrl: e.target.value })} />
        </div>
        <p className="text-xs text-gray-500">直接アップロードはMP4・最大100MB。外部HTTPS URLはLINE公式上限の200MBまでです。プレビューはJPEG/PNG・1MB以下へ自動縮小します。</p>
        {uploadError && <p role="alert" className="text-xs text-rose-600">{uploadError}</p>}
      </div>
    )
  }

  if (messageType === 'audio') {
    return (
      <div className="space-y-2">
        <div>
          <label className={labelCls}>音声を直接アップロード（M4A / MP3・最大100MB）</label>
          <input type="file" accept="audio/mp4,audio/x-m4a,audio/mpeg,.m4a,.mp3" disabled={uploading} onChange={(e) => void uploadDirect('audio', e.target.files?.[0])} className="block w-full text-xs text-gray-600" />
        </div>
        <div>
          <label className={labelCls}>音声ファイルのURL（m4a・https）<span className="text-red-500">*</span></label>
          <input type="text" maxLength={2000} className={fieldCls} placeholder="https://example.com/audio.m4a" value={s.audioUrl} onChange={(e) => patch({ audioUrl: e.target.value })} />
        </div>
        <div>
          <label className={labelCls}>再生時間（秒）<span className="text-red-500">*</span></label>
          <input type="number" min={1} className={fieldCls} placeholder="例: 30" value={s.durationSec} onChange={(e) => patch({ durationSec: e.target.value })} />
        </div>
        <p className="text-xs text-gray-500">直接アップロードはM4A / MP3・最大100MB。外部HTTPS URLはLINE公式上限の200MBまでです。再生時間（秒）も入力してください。</p>
        {uploadError && <p role="alert" className="text-xs text-rose-600">{uploadError}</p>}
      </div>
    )
  }

  if (messageType === 'imagemap') {
    return (
      <div className="space-y-2">
        <div>
          <div className="mb-1 flex items-center gap-1">
            <label className="text-xs font-medium text-gray-600">ベース画像のURL（https）<span className="text-red-500">*</span></label>
            <HelpPopover helpKey="imagemap.base" />
          </div>
          <input type="file" accept="image/jpeg,image/png" disabled={uploading} onChange={(e) => void uploadImagemap(e.target.files?.[0])} className="block w-full text-xs text-gray-600" />
          <input type="text" maxLength={2000} className={`${fieldCls} mt-1`} placeholder="または画像URLを直接入力 (https://...)" value={s.baseUrl} onChange={(e) => patch({ baseUrl: e.target.value })} />
        </div>
        <div className="flex gap-2">
          <div className="flex-1"><label className={labelCls}>画像の幅（固定）</label><input type="number" className={`${fieldCls} bg-gray-50`} value="1040" readOnly aria-readonly="true" /></div>
          <div className="flex-1"><label className={labelCls}>画像の高さ</label><input type="number" className={fieldCls} value={s.baseH} onChange={(e) => patch({ baseH: e.target.value })} /></div>
        </div>
        <p className="text-xs text-gray-500">JPEG / PNG・各サイズ10MBまで。元画像は横幅1040pxで用意すると、LINE用の5サイズを自動生成します。URLを直接入力する場合は末尾の /240・/300・/460・/700・/1040 が取得できるベースURLを指定してください。</p>
        <div>
          <div className="mb-1 flex items-center gap-1">
            <label className="text-xs font-medium text-gray-600">領域（押せる範囲）</label>
            <HelpPopover helpKey="imagemap.regions" />
          </div>
          <p className="text-xs text-gray-500 mb-2 flex items-center gap-1">
            <span>1枚の画像を複数の領域に分けて、押す場所で飛び先を変えられます。</span>
            <HelpPopover helpKey="imagemap.action" />
          </p>
          {/* Q4=ドラッグ既定。数値入力は補助として併存 (後方互換 + 微調整)。両モードは同一 s.regions を共有。 */}
          <div className="inline-flex rounded-md border border-gray-300 overflow-hidden text-xs mb-2">
            {(['drag', 'numeric'] as const).map((m) => (
              <button key={m} type="button" onClick={() => setImagemapMode(m)}
                className={`px-3 py-1.5 min-h-[36px] ${imagemapMode === m ? 'bg-green-600 text-white' : 'bg-white text-gray-600'}`}>
                {m === 'drag' ? 'ドラッグで描く' : '数値で入力'}
              </button>
            ))}
          </div>
          {imagemapMode === 'drag' && (
            s.baseUrl ? (
              <ImagemapRegionEditor imageUrl={`${s.baseUrl.replace(/\/$/, '')}/1040`} baseW={num(s.baseW)} baseH={num(s.baseH)} regions={s.regions} onChange={(regions) => patch({ regions })} />
            ) : (
              <p className="text-xs text-gray-500 border border-dashed border-gray-300 rounded-lg p-3 text-center">先にベース画像を選ぶと、ここで指でなぞって領域を描けます。</p>
            )
          )}
          {imagemapMode === 'numeric' && (
            <>
              {s.regions.map((r, i) => (
                <div key={i} className="border border-gray-200 rounded-lg p-2 mb-2 space-y-1">
                  <div className="flex gap-1">
                    {(['x', 'y', 'width', 'height'] as const).map((k) => (
                      <input key={k} type="number" className={`${fieldCls} flex-1`} placeholder={k === 'width' ? '幅' : k === 'height' ? '高さ' : k} value={r[k]}
                        onChange={(e) => patch({ regions: s.regions.map((rr, j) => j === i ? { ...rr, [k]: e.target.value } : rr) })} />
                    ))}
                  </div>
                  <div className="flex gap-1 items-center">
                    <select className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm bg-white" value={r.actionType}
                      onChange={(e) => patch({ regions: s.regions.map((rr, j) => j === i ? { ...rr, actionType: e.target.value as MediaState['regions'][number]['actionType'] } : rr) })}>
                      <option value="uri">リンク</option>
                      <option value="message">テキスト応答</option>
                      <option value="clipboard">クリップボードへコピー</option>
                    </select>
                    <input type="text" maxLength={r.actionType === 'message' ? 400 : 1000} className={`${fieldCls} flex-1`} placeholder={r.actionType === 'uri' ? '飛び先 (http / https / line / tel)' : r.actionType === 'message' ? '送るテキスト' : 'コピーするテキスト'} value={r.value}
                      onChange={(e) => patch({ regions: s.regions.map((rr, j) => j === i ? { ...rr, value: e.target.value } : rr) })} />
                    <button type="button" className="text-xs text-gray-500 hover:text-red-600 px-2 min-h-[36px]"
                      onClick={() => patch({ regions: s.regions.filter((_, j) => j !== i) })}>削除</button>
                  </div>
                </div>
              ))}
              <button type="button" className="px-3 py-1.5 min-h-[36px] text-xs font-medium text-green-700 border border-green-500 bg-green-50 rounded-md hover:bg-green-100"
                onClick={() => patch({ regions: [...s.regions, { x: '0', y: '0', width: '520', height: '520', actionType: 'uri', value: '' }] })}>
                ＋ 領域を追加
              </button>
            </>
          )}
        </div>
        {uploadError && <p role="alert" className="text-xs text-rose-600">{uploadError}</p>}
      </div>
    )
  }

  // richvideo
  return (
    <div className="space-y-2">
      <div>
        <label className={labelCls}>動画を直接アップロード（MP4・最大100MB）</label>
        <input type="file" accept="video/mp4" disabled={uploading} onChange={(e) => void uploadDirect('video', e.target.files?.[0])} className="block w-full text-xs text-gray-600" />
      </div>
      <div>
        <label className={labelCls}>動画ファイルのURL（mp4・https）<span className="text-red-500">*</span></label>
        <input type="text" maxLength={2000} className={fieldCls} placeholder="https://example.com/video.mp4" value={s.videoUrl} onChange={(e) => patch({ videoUrl: e.target.value })} />
      </div>
      <div>
        <label className={labelCls}>動画表示面のベース画像（JPEG / PNG・原稿幅1040px）<span className="text-red-500">*</span></label>
        <input type="file" accept="image/jpeg,image/png" disabled={uploading} onChange={(e) => void uploadImagemap(e.target.files?.[0])} className="block w-full text-xs text-gray-600" />
        <input type="text" maxLength={2000} className={`${fieldCls} mt-1`} placeholder="または5サイズのベースURL (https://...)" value={s.baseUrl} onChange={(e) => patch({ baseUrl: e.target.value })} />
        <div className="mt-2 flex gap-2">
          <div className="flex-1"><label className={labelCls}>ベース画像の幅（固定）</label><input type="number" className={`${fieldCls} bg-gray-50`} value="1040" readOnly aria-readonly="true" /></div>
          <div className="flex-1"><label className={labelCls}>ベース画像の高さ</label><input type="number" min={1} className={fieldCls} value={s.baseH} onChange={(e) => patch({ baseH: e.target.value })} /></div>
        </div>
        <p className="mt-1 text-xs text-gray-500">1040px原稿からLINE用の5サイズ（240 / 300 / 460 / 700 / 1040）を同じURL配下へ自動生成します。下のプレビュー画像とは別です。</p>
      </div>
      <div>
        <label className={labelCls}>動画のプレビュー画像（単一URL・1MB以下）<span className="text-red-500">*</span></label>
        <ImageUploader
          mode="line-image"
          value={s.previewUrl ? { mode: 'line-image' as const, originalContentUrl: s.previewUrl, previewImageUrl: s.previewUrl } : null}
          onChange={(v) => patch({ previewUrl: v?.mode === 'line-image' ? v.previewImageUrl : '' })}
          label="プレビュー画像（アップロード）"
        />
        <input type="text" maxLength={2000} className={`${fieldCls} mt-1`} placeholder="または画像URLを直接入力 (https://...)" value={s.previewUrl} onChange={(e) => patch({ previewUrl: e.target.value })} />
      </div>
      <div>
        <label className={labelCls}>再生後に出すボタン（任意）</label>
        <PersonalizedTextEditor
          mode="emoji-only"
          multiline={false}
          className={`${fieldCls} mb-1`}
          placeholder="ボタンの文字（例: 詳しく見る）"
          value={s.btnLabel}
          onChange={(btnLabel) => patch({ btnLabel })}
          ariaLabel="再生後に出すボタンの文字"
          inputProps={{ maxLength: 30 }}
        />
        <input type="text" maxLength={1000} className={fieldCls} placeholder="ボタンの飛び先 (https://...)" value={s.btnLink} onChange={(e) => patch({ btnLink: e.target.value })} />
      </div>
      <p className="text-xs text-gray-500">動画は直接MP4・最大100MB、外部HTTPS URLはLINE公式上限200MBまで。ベース画像はJPEG/PNG・各10MBまで、プレビュー画像はJPEG/PNG・1MB以下です。</p>
      {uploadError && <p role="alert" className="text-xs text-rose-600">{uploadError}</p>}
    </div>
  )
}
