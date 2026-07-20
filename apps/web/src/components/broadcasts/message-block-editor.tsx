'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { type MessageBlock } from '@/lib/api'
import type { EventListItem } from '@/lib/api'
import FlexPreviewComponent from '@/components/flex-preview'
import ImageUploader from '@/components/shared/image-uploader'
import BroadcastMediaInputs from './broadcast-media-inputs'
import { type MediaMessageType } from '@/lib/broadcast-media'
import { messageTypeLabels, messageTypeHints } from '@/lib/broadcast-labels'
import FlexBuilderModal from '@/components/flex-builder/flex-builder-modal'
import { flexToModel } from '@/lib/flex-builder/from-flex'
import { imageLinkToFlexJson } from '@/lib/flex-builder/image-link'
import { PencilIcon, TrashIcon, PaletteIcon } from '@/components/shared/icons'
import type { BuilderModel, LinkSpec } from '@/lib/flex-builder/types'

const NEW_MEDIA_TYPES: MediaMessageType[] = ['video', 'audio', 'imagemap', 'richvideo']
const isMediaType = (t: MessageBlock['type']): t is MediaMessageType =>
  (NEW_MEDIA_TYPES as string[]).includes(t)
const flexRebuildPrompt = '今の本文はそのままではビジュアル編集できません。新しくビジュアルで作り直しますか？（今のテキストは破棄されます）'
const flexRebuildGuidance = '今の本文はそのままではビジュアル編集できません。本文を残す場合は、下の「上級者向け」で編集してください。'

interface MessageBlockEditorProps {
  /** このブロックの種別/内容 (親 broadcast-form が保持する messages[i])。 */
  block: MessageBlock
  /** 種別/内容の変更を親へ返す (先頭ミラーは親 handleSave が実施)。 */
  onChange: (block: MessageBlock) => void
  /** text 本文にイベントリンクを挿入するための公開イベント一覧 (任意)。 */
  linkableEvents: EventListItem[]
  /** エラー表示 (このブロックに紐づく検証エラー・任意)。 */
  error?: string | null
}

/**
 * 1 メッセージ・ブロックの編集 UI (broadcast-combo-messages Batch 2)。
 * 従来 broadcast-form の単一メッセージ編集 UI (種別ボタン + text/画像/Flex/メディア入力 +
 * 画像リンク化トグル + Flex ビジュアルビルダー) をそのままブロック単位に切り出したもの。
 * 画像リンク化/ビルダー/上級者 JSON の一時 UI 状態はブロックローカルに保持する。
 */
export default function MessageBlockEditor({ block, onChange, linkableEvents, error }: MessageBlockEditorProps) {
  // Flex ビジュアルビルダー / 画像リンク化 / 上級者 JSON の一時 UI 状態 (ブロックローカル)。
  const [builderOpen, setBuilderOpen] = useState(false)
  const [builderInitial, setBuilderInitial] = useState<BuilderModel | undefined>(undefined)
  const [advancedJsonOpen, setAdvancedJsonOpen] = useState(false)
  const [builderError, setBuilderError] = useState('')
  const [rebuildConfirmOpen, setRebuildConfirmOpen] = useState(false)
  const [imageLinkOn, setImageLinkOn] = useState(false)
  const [imageUrl, setImageUrl] = useState('')
  const [imageLink, setImageLink] = useState<LinkSpec>({ type: 'url', uri: '' })
  const builderTriggerRef = useRef<HTMLButtonElement>(null)
  const rebuildConfirmButtonRef = useRef<HTMLButtonElement>(null)
  const rebuildDescriptionId = useId()

  useEffect(() => {
    if (rebuildConfirmOpen) rebuildConfirmButtonRef.current?.focus()
  }, [rebuildConfirmOpen])

  const resetBuilderFeedback = () => {
    setRebuildConfirmOpen(false)
    setBuilderError('')
    setAdvancedJsonOpen(false)
  }

  const setType = (type: MessageBlock['type']) => {
    // メディア種別に出入りする切替は内容の形式が変わるため content をリセットする。
    const switchingMedia = isMediaType(type) || isMediaType(block.type)
    resetBuilderFeedback()
    onChange({ ...block, type, content: switchingMedia ? '' : block.content })
  }
  const setContent = (content: string) => onChange({ ...block, content })

  // ビルダーを開く。既存 content があれば逆変換して初期モデルに (再編集)。
  const openBuilder = () => {
    if (block.content.trim()) {
      const model = flexToModel(block.content)
      if (!model) {
        setBuilderError('')
        setAdvancedJsonOpen(false)
        setRebuildConfirmOpen(true)
        return
      }
      setBuilderInitial(model)
    } else {
      setBuilderInitial(undefined)
    }
    setBuilderError('')
    setRebuildConfirmOpen(false)
    setBuilderOpen(true)
  }

  const confirmBuilderRebuild = () => {
    setBuilderInitial(undefined)
    setBuilderError('')
    setRebuildConfirmOpen(false)
    setAdvancedJsonOpen(false)
    setBuilderOpen(true)
  }

  const cancelBuilderRebuild = () => {
    setRebuildConfirmOpen(false)
    setAdvancedJsonOpen(true)
    setBuilderError(flexRebuildGuidance)
    builderTriggerRef.current?.focus()
  }

  const handleBuilderSave = (jsonString: string) => {
    onChange({ ...block, type: 'flex', content: jsonString })
    setBuilderOpen(false)
  }

  // 画像リンク化トグル。ON=画像を単一 bubble Flex に変換し type='flex' で保存。
  // OFF=従来の純 image (originalContentUrl/previewImageUrl / type='image') に戻す。
  const applyImageLink = (on: boolean, url: string, link: LinkSpec) => {
    if (on && url) {
      onChange({ ...block, type: 'flex', content: imageLinkToFlexJson(url, link) })
    } else {
      onChange({
        ...block,
        type: 'image',
        content: url ? JSON.stringify({ originalContentUrl: url, previewImageUrl: url }) : '',
      })
    }
  }

  return (
    <div>
      {/* 種別ボタン (単一 form 時と同一 DOM・combobox を増やさない) */}
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-2">メッセージ種別</label>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(messageTypeLabels) as MessageBlock['type'][]).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => setType(type)}
              className={`px-3 py-1.5 min-h-[44px] text-xs font-medium rounded-md border transition-colors ${
                block.type === type
                  ? 'border-green-500 text-green-700 bg-green-50'
                  : 'border-gray-300 text-gray-600 bg-white hover:border-gray-400'
              }`}
            >
              {messageTypeLabels[type]}
            </button>
          ))}
        </div>
        {messageTypeHints[block.type] && (
          <p className="text-xs text-gray-500 mt-2">{messageTypeHints[block.type]}</p>
        )}
      </div>

      {/* Message content */}
      <div className="mt-3">
        <label className="block text-xs font-medium text-gray-600 mb-1">
          メッセージ内容 <span className="text-red-500">*</span>
        </label>

        {/* text: textarea + イベントリンク挿入 */}
        {block.type === 'text' && (
          <>
            {linkableEvents.length > 0 && (
              <div className="mb-2">
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  リンクするイベント（任意）
                </label>
                <select
                  value=""
                  onChange={(e) => {
                    const id = e.target.value
                    if (!id) return
                    const url = `https://liff.line.me/{{liff_id}}/?page=event&id=${id}`
                    setContent(block.content ? `${block.content}\n${url}` : url)
                    e.target.value = ''
                  }}
                  className="border border-gray-300 rounded-lg px-2 py-1.5 text-sm w-full"
                >
                  <option value="">— 選択しない —</option>
                  {linkableEvents.map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      {ev.name} ({ev.target_type === 'multi-account-dedup' ? 'multi' : 'single'})
                    </option>
                  ))}
                </select>
                <p className="text-xs text-gray-500 mt-1">
                  選ぶと本文末尾にテンプレ URL を挿入。{'{{liff_id}}'} は配信時に各友だちのアカに対応した値に自動置換されます。
                </p>
              </div>
            )}
            <textarea
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-y"
              rows={4}
              placeholder="配信するメッセージを入力..."
              value={block.content}
              onChange={(e) => setContent(e.target.value)}
            />
          </>
        )}

        {/* image: ImageUploader + 「画像にリンクを付ける」トグル (ON で単一 bubble Flex に変換) */}
        {(block.type === 'image' || (block.type === 'flex' && imageLinkOn)) && (
          <div className="space-y-2">
            <ImageUploader
              mode="line-image"
              value={imageUrl ? { mode: 'line-image' as const, originalContentUrl: imageUrl, previewImageUrl: imageUrl } : null}
              onChange={(v) => {
                const url = v?.mode === 'line-image' ? v.originalContentUrl : ''
                setImageUrl(url)
                applyImageLink(imageLinkOn, url, imageLink)
              }}
              label="送信する画像"
            />
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={imageLinkOn}
                onChange={(e) => {
                  setImageLinkOn(e.target.checked)
                  applyImageLink(e.target.checked, imageUrl, imageLink)
                }}
                className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
              />
              <span className="text-xs text-gray-600">画像を押したら移動する（リンクを付ける）</span>
            </label>
            {imageLinkOn && (
              <input
                type="text"
                value={'uri' in imageLink ? imageLink.uri : ''}
                onChange={(e) => {
                  const link: LinkSpec = { type: 'url', uri: e.target.value }
                  setImageLink(link)
                  applyImageLink(true, imageUrl, link)
                }}
                placeholder="押したときの飛び先 (https://...)"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            )}
            {block.type === 'flex' && imageLinkOn && block.content && (
              <div className="mt-2">
                <p className="text-xs font-medium text-gray-500 mb-1">プレビュー</p>
                <FlexPreviewComponent content={block.content} maxWidth={240} />
              </div>
            )}
          </div>
        )}

        {/* flex (画像リンク以外): ビジュアルビルダー起動 + プレビュー。生 JSON は上級者折りたたみへ */}
        {block.type === 'flex' && !imageLinkOn && (
          <div className="space-y-3">
            {block.content && (() => { try { JSON.parse(block.content); return true } catch { return false } })() ? (
              <div className="border border-gray-200 rounded-lg p-3">
                <FlexPreviewComponent content={block.content} maxWidth={300} />
                <div className="mt-2 flex gap-2">
                  <button
                    ref={builderTriggerRef}
                    type="button"
                    onClick={openBuilder}
                    className="px-3 py-1.5 min-h-[36px] text-xs font-medium text-green-700 border border-green-500 bg-green-50 rounded-md hover:bg-green-100 inline-flex items-center gap-1.5"
                  >
                    <PencilIcon /> カードを編集
                  </button>
                  <button
                    type="button"
                    onClick={() => setContent('')}
                    className="px-3 py-1.5 min-h-[36px] text-xs font-medium text-gray-500 border border-gray-300 rounded-md hover:text-red-600 inline-flex items-center gap-1.5"
                  >
                    <TrashIcon /> 削除
                  </button>
                </div>
              </div>
            ) : (
              <button
                ref={builderTriggerRef}
                type="button"
                onClick={openBuilder}
                className="w-full min-h-[44px] px-4 py-3 text-sm font-medium text-white rounded-md inline-flex items-center justify-center gap-2"
                style={{ backgroundColor: '#06C755' }}
              >
                <PaletteIcon /> ビジュアルでカードを作る
              </button>
            )}

            {rebuildConfirmOpen && (
              <div
                role="alertdialog"
                aria-label="Flexを新しく作り直す確認"
                aria-describedby={rebuildDescriptionId}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelBuilderRebuild()
                  }
                }}
                className="rounded-lg border border-amber-300 bg-amber-50 p-3"
              >
                <p id={rebuildDescriptionId} className="text-sm text-amber-900">{flexRebuildPrompt}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    ref={rebuildConfirmButtonRef}
                    type="button"
                    onClick={confirmBuilderRebuild}
                    className="min-h-[40px] rounded-md bg-amber-600 px-3 py-2 text-xs font-medium text-white hover:bg-amber-700"
                  >
                    新しく作り直す
                  </button>
                  <button
                    type="button"
                    onClick={cancelBuilderRebuild}
                    className="min-h-[40px] rounded-md border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
                  >
                    キャンセル
                  </button>
                </div>
              </div>
            )}

            {/* 上級者向け: 生 JSON 直貼り (既定閉・後方互換) */}
            <div>
              <button
                type="button"
                onClick={() => setAdvancedJsonOpen((v) => !v)}
                className="text-xs text-gray-500 hover:text-gray-700"
              >
                {advancedJsonOpen ? '▾' : '▸'} 上級者向け: JSONを直接貼り付ける
              </button>
              {advancedJsonOpen && (
                <div className="mt-2">
                  <textarea
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-y"
                    rows={8}
                    placeholder='{"type":"bubble","body":{...}}'
                    value={block.content}
                    onChange={(e) => {
                      let next = e.target.value
                      // message object 丸ごと貼付 ({type:'flex',altText,contents}) を自動アンラップ
                      try {
                        const parsed = JSON.parse(next)
                        if (parsed && typeof parsed === 'object' && parsed.type === 'flex' && parsed.contents) {
                          next = JSON.stringify(parsed.contents, null, 2)
                        }
                      } catch { /* 入力途中は無視 */ }
                      setContent(next)
                    }}
                    style={{ fontFamily: 'monospace' }}
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    ⓘ contents(bubble/carousel)だけを貼ってください。message object を貼ると contents だけ自動で取り出します。
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* video / audio / imagemap / richvideo: 種別ごとの入力 (JSON に直列化して保存) */}
        {isMediaType(block.type) && (
          <BroadcastMediaInputs
            messageType={block.type}
            onChange={(content) => setContent(content)}
          />
        )}

        {(error || builderError) && <p role="alert" className="text-xs text-red-600 mt-2">{error || builderError}</p>}
      </div>

      {builderOpen && (
        <FlexBuilderModal
          initialModel={builderInitial}
          onSave={handleBuilderSave}
          onClose={() => setBuilderOpen(false)}
        />
      )}
    </div>
  )
}
