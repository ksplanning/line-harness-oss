'use client'

import { useEffect, useState } from 'react'
import type { Tag } from '@line-crm/shared'
import { api, eventsApi, type ApiBroadcast, type EventListItem } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import FlexPreviewComponent from '@/components/flex-preview'
import ImageUploader from '@/components/shared/image-uploader'
import MultiAccountDedupSection from './multi-account-dedup-section'
import PackInsertSelector from './pack-insert-selector'
import BroadcastMediaInputs from './broadcast-media-inputs'
import SenderSelect from './sender-select'
import { validateMediaClient, type MediaMessageType } from '@/lib/broadcast-media'
import { messageTypeLabels, messageTypeHints } from '@/lib/broadcast-labels'
import FlexBuilderModal from '@/components/flex-builder/flex-builder-modal'
import { flexToModel } from '@/lib/flex-builder/from-flex'
import { imageLinkToFlexJson } from '@/lib/flex-builder/image-link'
import { validateFlex } from '@/lib/flex-builder/validate'
import type { FlexContents } from '@/lib/flex-builder/types'
import type { BuilderModel, LinkSpec } from '@/lib/flex-builder/types'

interface BroadcastFormProps {
  tags: Tag[]
  onSuccess: () => void
  onCancel: () => void
}

const NEW_MEDIA_TYPES: MediaMessageType[] = ['video', 'audio', 'imagemap', 'richvideo']
const isMediaType = (t: ApiBroadcast['messageType']): t is MediaMessageType =>
  (NEW_MEDIA_TYPES as string[]).includes(t)

interface FormState {
  title: string
  messageType: ApiBroadcast['messageType']
  messageContent: string
  targetType: ApiBroadcast['targetType']
  targetTagId: string
  scheduledAt: string
  sendNow: boolean
  accountIds: string[]
  dedupPriority: string[]
  senderPresetId: string | null
}

export default function BroadcastForm({ tags, onSuccess, onCancel }: BroadcastFormProps) {
  const { selectedAccountId } = useAccount()
  // 「リンクするイベント」セレクタ用: 公開中の events を取得して
  // 選択された event の LIFF URL (テンプレ) を message に挿入する。
  const [linkableEvents, setLinkableEvents] = useState<EventListItem[]>([])
  useEffect(() => {
    if (!selectedAccountId) return
    let cancelled = false
    eventsApi.listEvents(selectedAccountId)
      .then((r) => { if (!cancelled) setLinkableEvents(r.items.filter((e) => e.is_published === 1)) })
      .catch(() => { /* silent */ })
    return () => { cancelled = true }
  }, [selectedAccountId])
  const [form, setForm] = useState<FormState>({
    title: '',
    messageType: 'text',
    messageContent: '',
    targetType: 'all',
    targetTagId: '',
    scheduledAt: '',
    sendNow: true,
    accountIds: [],
    dedupPriority: [],
    senderPresetId: null,
  })
  // account 切替でプリセット選択をリセット (別 account の preset id を残さない・batch2 L-2 教訓)。
  useEffect(() => {
    setForm((prev) => ({ ...prev, senderPresetId: null }))
  }, [selectedAccountId])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  // Flex ビジュアルビルダー: flex 作成/編集をビルダー起動に置換 (raw textarea は上級者折りたたみへ)
  const [builderOpen, setBuilderOpen] = useState(false)
  const [builderInitial, setBuilderInitial] = useState<BuilderModel | undefined>(undefined)
  const [advancedJsonOpen, setAdvancedJsonOpen] = useState(false)
  // 画像リッチ化: 「画像にリンクを付ける」ON で単一 bubble Flex に切替 (plan 判断A)
  const [imageLinkOn, setImageLinkOn] = useState(false)
  const [imageUrl, setImageUrl] = useState('')
  const [imageLink, setImageLink] = useState<LinkSpec>({ type: 'url', uri: '' })

  // ビルダーを開く。既存 messageContent があれば逆変換して初期モデルに (再編集)。
  // 逆変換不能 (高度な形式) なら上級者 JSON 折りたたみに誘導し、ビルダーは新規で開かない。
  const openBuilder = () => {
    if (form.messageContent.trim()) {
      const model = flexToModel(form.messageContent)
      if (!model) {
        setAdvancedJsonOpen(true)
        setError('このFlexは高度な形式のため、ビジュアル編集できません。下の「上級者向け」で編集してください。')
        return
      }
      setBuilderInitial(model)
    } else {
      setBuilderInitial(undefined)
    }
    setError('')
    setBuilderOpen(true)
  }

  const handleBuilderSave = (jsonString: string) => {
    setForm((prev) => ({ ...prev, messageContent: jsonString, messageType: 'flex' }))
    setBuilderOpen(false)
  }

  // 画像リッチ化トグル。ON=画像を単一 bubble Flex に変換し message_type='flex' で保存 (plan 判断A)。
  // OFF=従来の純 image 送信 (originalContentUrl/previewImageUrl / message_type='image') に戻す。
  const applyImageLink = (on: boolean, url: string, link: LinkSpec) => {
    if (on && url) {
      setForm((prev) => ({ ...prev, messageType: 'flex', messageContent: imageLinkToFlexJson(url, link) }))
    } else {
      setForm((prev) => ({
        ...prev,
        messageType: 'image',
        messageContent: url ? JSON.stringify({ originalContentUrl: url, previewImageUrl: url }) : '',
      }))
    }
  }

  const handleSave = async () => {
    if (!form.title.trim()) { setError('配信タイトルを入力してください'); return }
    if (!form.messageContent.trim()) { setError('メッセージ内容を入力してください'); return }
    if (form.messageType === 'flex') {
      // 画像リンク化/上級者直貼り/ビルダー保存の**全 flex 経路**を保存前に validateFlex に通す (M1)。
      // これで LINE 制約違反 (不正 uri / http 画像 / 空 等) が送信時に初めて失敗する経路を潰す。
      let parsed: FlexContents
      try { parsed = JSON.parse(form.messageContent) as FlexContents } catch { setError('Flexメッセージの形式が正しくありません'); return }
      const v = validateFlex(parsed)
      if (!v.ok) { setError(v.errors[0].messageJa); return }
    }
    if (isMediaType(form.messageType)) {
      const mediaErr = validateMediaClient(form.messageType, form.messageContent)
      if (mediaErr) { setError(mediaErr); return }
    }
    if (!form.sendNow && !form.scheduledAt) {
      setError('予約配信の場合は配信日時を指定してください')
      return
    }
    if (form.targetType === 'multi-account-dedup' && form.accountIds.length === 0) {
      setError('複数アカ重複除外: 配信先アカウントを 1 つ以上選択してください')
      return
    }

    setSaving(true)
    setError('')
    try {
      const res = await api.broadcasts.create({
        title: form.title,
        messageType: form.messageType,
        messageContent: form.messageContent,
        targetType: form.targetType,
        // tag mode: required; multi-account-dedup mode: optional narrowing filter; else: null
        targetTagId:
          form.targetType === 'tag'
            ? form.targetTagId || null
            : form.targetType === 'multi-account-dedup'
            ? form.targetTagId || null
            : null,
        status: 'draft',
        lineAccountId: form.targetType === 'multi-account-dedup' ? null : (selectedAccountId || null),
        accountIds: form.targetType === 'multi-account-dedup' ? form.accountIds : undefined,
        dedupPriority: form.targetType === 'multi-account-dedup' ? form.dedupPriority : undefined,
        senderPresetId: form.senderPresetId,
        // datetime-local returns YYYY-MM-DDTHH:mm in JST wall-clock time
        // Append +09:00 so new Date() parses correctly for epoch comparisons
        scheduledAt: form.sendNow || !form.scheduledAt
          ? null
          : form.scheduledAt + ':00.000+09:00',
      })
      if (res.success) {
        onSuccess()
      } else {
        setError(res.error)
      }
    } catch {
      setError('作成に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
      <h2 className="text-sm font-semibold text-gray-800 mb-5">新規配信を作成</h2>

      <div className="space-y-4 max-w-lg">
        {/* Title */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            配信タイトル <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            placeholder="例: 3月のキャンペーン告知"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </div>

        {/* テンプレパックから入れる (G16・挿入のみ・送信しない) */}
        <PackInsertSelector
          accountId={selectedAccountId || null}
          onInsert={(patch) => setForm((prev) => ({ ...prev, messageType: patch.messageType, messageContent: patch.messageContent }))}
        />

        {/* Message type */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-2">メッセージ種別</label>
          <div className="flex flex-wrap gap-2">
            {(Object.keys(messageTypeLabels) as ApiBroadcast['messageType'][]).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => {
                  // メディア種別に出入りする切替は内容の形式が変わるため messageContent をリセットする。
                  const switchingMedia = isMediaType(type) || isMediaType(form.messageType)
                  setForm({ ...form, messageType: type, ...(switchingMedia ? { messageContent: '' } : {}) })
                }}
                className={`px-3 py-1.5 min-h-[44px] text-xs font-medium rounded-md border transition-colors ${
                  form.messageType === type
                    ? 'border-green-500 text-green-700 bg-green-50'
                    : 'border-gray-300 text-gray-600 bg-white hover:border-gray-400'
                }`}
              >
                {messageTypeLabels[type]}
              </button>
            ))}
          </div>
          {messageTypeHints[form.messageType] && (
            <p className="text-xs text-gray-500 mt-2">{messageTypeHints[form.messageType]}</p>
          )}
        </div>

        {/* Message content */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            メッセージ内容 <span className="text-red-500">*</span>
          </label>

          {/* text: 従来どおり textarea + イベントリンク挿入 */}
          {form.messageType === 'text' && (
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
                      setForm((prev) => ({
                        ...prev,
                        messageContent: prev.messageContent ? `${prev.messageContent}\n${url}` : url,
                      }))
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
                value={form.messageContent}
                onChange={(e) => setForm({ ...form, messageContent: e.target.value })}
              />
            </>
          )}

          {/* image: ImageUploader + 「画像にリンクを付ける」トグル (ON で単一 bubble Flex に変換) */}
          {(form.messageType === 'image' || (form.messageType === 'flex' && imageLinkOn)) && (
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
                  value={imageLink.uri}
                  onChange={(e) => {
                    const link: LinkSpec = { type: 'url', uri: e.target.value }
                    setImageLink(link)
                    applyImageLink(true, imageUrl, link)
                  }}
                  placeholder="押したときの飛び先 (https://...)"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              )}
              {form.messageType === 'flex' && imageLinkOn && form.messageContent && (
                <div className="mt-2">
                  <p className="text-xs font-medium text-gray-500 mb-1">プレビュー</p>
                  <FlexPreviewComponent content={form.messageContent} maxWidth={240} />
                </div>
              )}
            </div>
          )}

          {/* flex (画像リンク以外): ビジュアルビルダー起動 + プレビュー。生 JSON textarea は撤去し上級者折りたたみへ */}
          {form.messageType === 'flex' && !imageLinkOn && (
            <div className="space-y-3">
              {form.messageContent && (() => { try { JSON.parse(form.messageContent); return true } catch { return false } })() ? (
                <div className="border border-gray-200 rounded-lg p-3">
                  <FlexPreviewComponent content={form.messageContent} maxWidth={300} />
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={openBuilder}
                      className="px-3 py-1.5 min-h-[36px] text-xs font-medium text-green-700 border border-green-500 bg-green-50 rounded-md hover:bg-green-100"
                    >
                      ✎ カードを編集
                    </button>
                    <button
                      type="button"
                      onClick={() => setForm((prev) => ({ ...prev, messageContent: '' }))}
                      className="px-3 py-1.5 min-h-[36px] text-xs font-medium text-gray-500 border border-gray-300 rounded-md hover:text-red-600"
                    >
                      🗑 削除
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={openBuilder}
                  className="w-full min-h-[44px] px-4 py-3 text-sm font-medium text-white rounded-md"
                  style={{ backgroundColor: '#06C755' }}
                >
                  🎨 ビジュアルでカードを作る
                </button>
              )}

              {/* 上級者向け: 生 JSON 直貼り (既定閉・後方互換 / A9)。運用者はここを触らずビルダーで完結できる。 */}
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
                      value={form.messageContent}
                      onChange={(e) => {
                        let next = e.target.value
                        // message object 丸ごと貼付 ({type:'flex',altText,contents}) を自動アンラップ (W5 T-E3(c))
                        try {
                          const parsed = JSON.parse(next)
                          if (parsed && typeof parsed === 'object' && parsed.type === 'flex' && parsed.contents) {
                            next = JSON.stringify(parsed.contents, null, 2)
                          }
                        } catch { /* 入力途中は無視 */ }
                        setForm({ ...form, messageContent: next })
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
          {isMediaType(form.messageType) && (
            <BroadcastMediaInputs
              messageType={form.messageType}
              onChange={(content) => setForm((prev) => ({ ...prev, messageContent: content }))}
            />
          )}
        </div>

        {/* 送信者 (G25・account プリセットから選ぶ・任意入力不可) */}
        <SenderSelect
          accountId={selectedAccountId || null}
          value={form.senderPresetId}
          onChange={(id) => setForm((prev) => ({ ...prev, senderPresetId: id }))}
        />

        {/* Target */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-2">配信対象</label>
          <div className="flex flex-wrap gap-2 mb-2">
            <button
              type="button"
              onClick={() => setForm({ ...form, targetType: 'all', targetTagId: '' })}
              className={`px-3 py-1.5 min-h-[44px] text-xs font-medium rounded-md border transition-colors ${
                form.targetType === 'all'
                  ? 'border-green-500 text-green-700 bg-green-50'
                  : 'border-gray-300 text-gray-600 bg-white hover:border-gray-400'
              }`}
            >
              全員
            </button>
            <button
              type="button"
              onClick={() => setForm({ ...form, targetType: 'tag' })}
              className={`px-3 py-1.5 min-h-[44px] text-xs font-medium rounded-md border transition-colors ${
                form.targetType === 'tag'
                  ? 'border-green-500 text-green-700 bg-green-50'
                  : 'border-gray-300 text-gray-600 bg-white hover:border-gray-400'
              }`}
            >
              タグで絞り込み
            </button>
            <button
              type="button"
              onClick={() => setForm({ ...form, targetType: 'multi-account-dedup', targetTagId: '' })}
              className={`px-3 py-1.5 min-h-[44px] text-xs font-medium rounded-md border transition-colors ${
                form.targetType === 'multi-account-dedup'
                  ? 'border-green-500 text-green-700 bg-green-50'
                  : 'border-gray-300 text-gray-600 bg-white hover:border-gray-400'
              }`}
            >
              複数アカ重複除外
            </button>
          </div>
          {form.targetType === 'tag' && (
            <select
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
              value={form.targetTagId}
              onChange={(e) => setForm({ ...form, targetTagId: e.target.value })}
            >
              <option value="">タグを選択...</option>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>{tag.name}</option>
              ))}
            </select>
          )}
          {form.targetType === 'multi-account-dedup' && (
            <MultiAccountDedupSection
              accountIds={form.accountIds}
              dedupPriority={form.dedupPriority}
              targetTagId={form.targetTagId || null}
              tags={tags}
              onAccountIdsChange={(ids) => setForm({ ...form, accountIds: ids })}
              onDedupPriorityChange={(ids) => setForm({ ...form, dedupPriority: ids })}
              onTargetTagIdChange={(id) => setForm({ ...form, targetTagId: id ?? '' })}
            />
          )}
        </div>

        {/* Schedule */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-2">配信タイミング</label>
          <div className="flex flex-wrap gap-2 mb-2">
            <button
              type="button"
              onClick={() => setForm({ ...form, sendNow: true, scheduledAt: '' })}
              className={`px-3 py-1.5 min-h-[44px] text-xs font-medium rounded-md border transition-colors ${
                form.sendNow
                  ? 'border-green-500 text-green-700 bg-green-50'
                  : 'border-gray-300 text-gray-600 bg-white hover:border-gray-400'
              }`}
            >
              下書きとして保存
            </button>
            <button
              type="button"
              onClick={() => setForm({ ...form, sendNow: false })}
              className={`px-3 py-1.5 min-h-[44px] text-xs font-medium rounded-md border transition-colors ${
                !form.sendNow
                  ? 'border-green-500 text-green-700 bg-green-50'
                  : 'border-gray-300 text-gray-600 bg-white hover:border-gray-400'
              }`}
            >
              予約配信
            </button>
          </div>
          {!form.sendNow && (
            <input
              type="datetime-local"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              value={form.scheduledAt}
              onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })}
            />
          )}
        </div>

        {/* Error */}
        {error && <p className="text-xs text-red-600">{error}</p>}

        {/* Actions */}
        <div className="flex gap-2 pt-1">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
            style={{ backgroundColor: '#06C755' }}
          >
            {saving ? '作成中...' : '作成'}
          </button>
          <button
            onClick={onCancel}
            disabled={saving}
            className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
          >
            キャンセル
          </button>
        </div>
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
