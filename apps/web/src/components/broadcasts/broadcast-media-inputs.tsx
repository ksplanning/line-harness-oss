'use client'

import { useEffect, useState } from 'react'
import ImageUploader from '@/components/shared/image-uploader'
import PersonalizedTextEditor from '@/components/shared/personalized-text-editor'
import { buildMediaJson, initialMediaState, num, parseMediaJson, type MediaMessageType, type MediaState } from '@/lib/broadcast-media'
import ImagemapRegionEditor from './imagemap-region-editor'
import HelpPopover from '@/components/help/help-popover'

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

  // 種別が切り替わったら、その種別の現在入力から messageContent を再直列化して同期する。
  useEffect(() => {
    onChange(buildMediaJson(messageType, s))
    // messageType 変更時のみ再同期 (state/onChange の変化では回さない)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messageType])

  function patch(p: Partial<MediaState>) {
    const next = { ...s, ...p }
    setS(next)
    onChange(buildMediaJson(messageType, next))
  }

  if (messageType === 'video') {
    return (
      <div className="space-y-2">
        <div>
          <label className={labelCls}>動画ファイルのURL（mp4・https）<span className="text-red-500">*</span></label>
          <input type="text" className={fieldCls} placeholder="https://example.com/video.mp4" value={s.videoUrl} onChange={(e) => patch({ videoUrl: e.target.value })} />
        </div>
        <div>
          <label className={labelCls}>プレビュー画像のURL（https）<span className="text-red-500">*</span></label>
          <ImageUploader
            mode="line-image"
            value={s.previewUrl ? { mode: 'line-image' as const, originalContentUrl: s.previewUrl, previewImageUrl: s.previewUrl } : null}
            onChange={(v) => patch({ previewUrl: v?.mode === 'line-image' ? v.originalContentUrl : '' })}
            label="プレビュー画像（アップロード）"
          />
          <input type="text" className={`${fieldCls} mt-1`} placeholder="または画像URLを直接入力 (https://...)" value={s.previewUrl} onChange={(e) => patch({ previewUrl: e.target.value })} />
        </div>
        <p className="text-xs text-gray-500">動画本体は外部URLを貼るか、短い動画なら画像アップロードと同じ手順で上げられます。</p>
      </div>
    )
  }

  if (messageType === 'audio') {
    return (
      <div className="space-y-2">
        <div>
          <label className={labelCls}>音声ファイルのURL（m4a・https）<span className="text-red-500">*</span></label>
          <input type="text" className={fieldCls} placeholder="https://example.com/audio.m4a" value={s.audioUrl} onChange={(e) => patch({ audioUrl: e.target.value })} />
        </div>
        <div>
          <label className={labelCls}>再生時間（秒）<span className="text-red-500">*</span></label>
          <input type="number" min={1} className={fieldCls} placeholder="例: 30" value={s.durationSec} onChange={(e) => patch({ durationSec: e.target.value })} />
        </div>
        <p className="text-xs text-gray-500">音声は m4a 形式・再生時間（秒）を入れてください。</p>
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
          <ImageUploader
            mode="line-image"
            value={s.baseUrl ? { mode: 'line-image' as const, originalContentUrl: s.baseUrl, previewImageUrl: s.baseUrl } : null}
            onChange={(v) => patch({ baseUrl: v?.mode === 'line-image' ? v.originalContentUrl : '' })}
            label="ベース画像（アップロード）"
          />
          <input type="text" className={`${fieldCls} mt-1`} placeholder="または画像URLを直接入力 (https://...)" value={s.baseUrl} onChange={(e) => patch({ baseUrl: e.target.value })} />
        </div>
        <div className="flex gap-2">
          <div className="flex-1"><label className={labelCls}>画像の幅</label><input type="number" className={fieldCls} value={s.baseW} onChange={(e) => patch({ baseW: e.target.value })} /></div>
          <div className="flex-1"><label className={labelCls}>画像の高さ</label><input type="number" className={fieldCls} value={s.baseH} onChange={(e) => patch({ baseH: e.target.value })} /></div>
        </div>
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
              <ImagemapRegionEditor imageUrl={s.baseUrl} baseW={num(s.baseW)} baseH={num(s.baseH)} regions={s.regions} onChange={(regions) => patch({ regions })} />
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
                      onChange={(e) => patch({ regions: s.regions.map((rr, j) => j === i ? { ...rr, actionType: e.target.value as 'uri' | 'message' } : rr) })}>
                      <option value="uri">リンク</option>
                      <option value="message">テキスト応答</option>
                    </select>
                    <input type="text" className={`${fieldCls} flex-1`} placeholder={r.actionType === 'uri' ? '飛び先 (https://...)' : '送るテキスト'} value={r.value}
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
      </div>
    )
  }

  // richvideo
  return (
    <div className="space-y-2">
      <div>
        <label className={labelCls}>動画ファイルのURL（mp4・https）<span className="text-red-500">*</span></label>
        <input type="text" className={fieldCls} placeholder="https://example.com/video.mp4" value={s.videoUrl} onChange={(e) => patch({ videoUrl: e.target.value })} />
      </div>
      <div>
        <label className={labelCls}>プレビュー画像のURL（https）<span className="text-red-500">*</span></label>
        <ImageUploader
          mode="line-image"
          value={s.previewUrl ? { mode: 'line-image' as const, originalContentUrl: s.previewUrl, previewImageUrl: s.previewUrl } : null}
          onChange={(v) => patch({ previewUrl: v?.mode === 'line-image' ? v.originalContentUrl : '' })}
          label="プレビュー画像（アップロード）"
        />
        <input type="text" className={`${fieldCls} mt-1`} placeholder="または画像URLを直接入力 (https://...)" value={s.previewUrl} onChange={(e) => patch({ previewUrl: e.target.value })} />
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
        />
        <input type="text" className={fieldCls} placeholder="ボタンの飛び先 (https://...)" value={s.btnLink} onChange={(e) => patch({ btnLink: e.target.value })} />
      </div>
      <p className="text-xs text-gray-500">動画の再生後にボタンを出せます。</p>
    </div>
  )
}
