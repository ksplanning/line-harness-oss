'use client'

import { useEffect, useRef, useState } from 'react'
import type { Tag } from '@line-crm/shared'
import { api, eventsApi, type ApiBroadcast, type EventListItem, type MessageBlock } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import MultiAccountDedupSection from './multi-account-dedup-section'
import PackInsertSelector from './pack-insert-selector'
import MessageBlockEditor from './message-block-editor'
import SenderSelect from './sender-select'
import { validateMediaClient, type MediaMessageType } from '@/lib/broadcast-media'
import { validateFlex } from '@/lib/flex-builder/validate'
import type { FlexContents } from '@/lib/flex-builder/types'
import type { FormBubblePatch } from '@/lib/template-packs/pack-insert'

interface BroadcastFormProps {
  tags: Tag[]
  onSuccess: () => void
  onCancel: () => void
}

const MAX_MESSAGES = 5
const NEW_MEDIA_TYPES: MediaMessageType[] = ['video', 'audio', 'imagemap', 'richvideo']
const isMediaType = (t: MessageBlock['type']): t is MediaMessageType =>
  (NEW_MEDIA_TYPES as string[]).includes(t)

interface FormState {
  title: string
  targetType: ApiBroadcast['targetType']
  targetTagId: string
  scheduledAt: string
  sendNow: boolean
  accountIds: string[]
  dedupPriority: string[]
  senderPresetId: string | null
  // G1 A/B 紐付け (この配信を A/B テストの案 A/B として作る)。null = 非 A/B。
  abTestId: string | null
  abVariant: 'A' | 'B' | null
}

/** 編集用ブロック: 並べ替え/削除でも UI 状態を安定させるため stable key を持つ。payload は msg のみ。 */
interface EditorBlock {
  key: string
  msg: MessageBlock
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
    targetType: 'all',
    targetTagId: '',
    scheduledAt: '',
    sendNow: true,
    accountIds: [],
    dedupPriority: [],
    senderPresetId: null,
    abTestId: null,
    abVariant: null,
  })

  // メッセージ・ブロック列 (combo messages Batch 2)。既定は 1 ブロック=従来の単発配信と同じ見た目。
  const keyCounter = useRef(0)
  const newBlock = (msg: MessageBlock): EditorBlock => ({ key: `blk-${++keyCounter.current}`, msg })
  const [blocks, setBlocks] = useState<EditorBlock[]>(() => [{ key: 'blk-0', msg: { type: 'text', content: '' } }])

  const addBlock = () =>
    setBlocks((prev) => (prev.length >= MAX_MESSAGES ? prev : [...prev, newBlock({ type: 'text', content: '' })]))
  const removeBlock = (i: number) =>
    setBlocks((prev) => (prev.length <= 1 ? prev : prev.filter((_, j) => j !== i)))
  const moveBlock = (i: number, dir: -1 | 1) =>
    setBlocks((prev) => {
      const j = i + dir
      if (j < 0 || j >= prev.length) return prev
      const next = [...prev]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  const updateBlock = (i: number, msg: MessageBlock) =>
    setBlocks((prev) => prev.map((b, j) => (j === i ? { ...b, msg } : b)))
  // パック追加 (append・置換でない)。PackInsertSelector が残枠を検証済 (silent 切り詰めしない)。
  const appendPatches = (patches: FormBubblePatch[]) =>
    setBlocks((prev) => [...prev, ...patches.map((p) => newBlock({ type: p.messageType, content: p.messageContent }))])

  // account の A/B テスト一覧 (この配信を案 A/B として紐付ける選択肢)。
  const [abTests, setAbTests] = useState<Array<{ id: string; name: string }>>([])
  useEffect(() => {
    if (!selectedAccountId) { setAbTests([]); return }
    api.abTests.list(selectedAccountId)
      .then((r) => { if (r.success && r.data) setAbTests(r.data.map((t) => ({ id: t.id, name: t.name }))) })
      .catch(() => { /* silent */ })
  }, [selectedAccountId])
  // account 切替でプリセット選択をリセット (別 account の preset id を残さない・batch2 L-2 教訓)。
  useEffect(() => {
    setForm((prev) => ({ ...prev, senderPresetId: null, abTestId: null, abVariant: null }))
  }, [selectedAccountId])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handleSave = async () => {
    if (!form.title.trim()) { setError('配信タイトルを入力してください'); return }
    // 各ブロックを順に検証 (先頭ミラーは payload 組立時に blocks[0] から取る)。
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i].msg
      const label = blocks.length > 1 ? `${i + 1}通目の` : ''
      if (!b.content.trim()) { setError(`${label}メッセージ内容を入力してください`); return }
      if (b.type === 'flex') {
        let parsed: FlexContents
        try { parsed = JSON.parse(b.content) as FlexContents } catch { setError(`${label}Flexメッセージの形式が正しくありません`); return }
        const v = validateFlex(parsed)
        if (!v.ok) { setError(`${label}${v.errors[0].messageJa}`); return }
      }
      if (isMediaType(b.type)) {
        const mediaErr = validateMediaClient(b.type, b.content)
        if (mediaErr) { setError(`${label}${mediaErr}`); return }
      }
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
      const messages: MessageBlock[] = blocks.map((b) => b.msg)
      const res = await api.broadcasts.create({
        title: form.title,
        // 先頭ミラー: messageType/messageContent は必ず messages[0] と一致 (既存 read 経路 + NOT NULL 制約)。
        messageType: messages[0].type,
        messageContent: messages[0].content,
        messages,
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
        // A/B 紐付け: test + 案 (A/B) が両方揃った時だけ送る (片方だけは server が 400)。
        abTestId: form.abTestId && form.abVariant ? form.abTestId : null,
        abVariant: form.abTestId && form.abVariant ? form.abVariant : null,
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

        {/* テンプレパックから入れる (G16・パック全体/個別を「追加」・送信しない) */}
        <PackInsertSelector
          accountId={selectedAccountId || null}
          remainingSlots={MAX_MESSAGES - blocks.length}
          onAppend={appendPatches}
        />

        {/* メッセージ・ブロック列 (最大5・画像+テキスト等を順序付きで束ねる) */}
        <div className="space-y-3">
          <label className="block text-xs font-medium text-gray-600">
            メッセージ（{blocks.length} / {MAX_MESSAGES} 通）
          </label>
          {blocks.map((b, i) => (
            <div key={b.key} className="border border-gray-200 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-gray-700">{i + 1}通目</span>
                {blocks.length > 1 && (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => moveBlock(i, -1)}
                      disabled={i === 0}
                      aria-label={`${i + 1}通目を上へ`}
                      className="px-2 py-1 min-h-[32px] text-xs text-gray-600 border border-gray-300 rounded disabled:opacity-30"
                    >
                      上へ
                    </button>
                    <button
                      type="button"
                      onClick={() => moveBlock(i, 1)}
                      disabled={i === blocks.length - 1}
                      aria-label={`${i + 1}通目を下へ`}
                      className="px-2 py-1 min-h-[32px] text-xs text-gray-600 border border-gray-300 rounded disabled:opacity-30"
                    >
                      下へ
                    </button>
                    <button
                      type="button"
                      onClick={() => removeBlock(i)}
                      aria-label={`${i + 1}通目を削除`}
                      className="px-2 py-1 min-h-[32px] text-xs text-gray-500 border border-gray-300 rounded hover:text-red-600"
                    >
                      削除
                    </button>
                  </div>
                )}
              </div>
              <MessageBlockEditor
                block={b.msg}
                onChange={(msg) => updateBlock(i, msg)}
                linkableEvents={linkableEvents}
              />
            </div>
          ))}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={addBlock}
              disabled={blocks.length >= MAX_MESSAGES}
              className="px-3 py-1.5 min-h-[40px] text-xs font-medium text-green-700 border border-green-500 bg-green-50 rounded-md hover:bg-green-100 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ＋ メッセージを追加
            </button>
            {blocks.length >= MAX_MESSAGES && (
              <span className="text-xs text-gray-500">最大{MAX_MESSAGES}通までです</span>
            )}
          </div>
        </div>

        {/* 送信者 (G25・account プリセットから選ぶ・任意入力不可) */}
        <SenderSelect
          accountId={selectedAccountId || null}
          value={form.senderPresetId}
          onChange={(id) => setForm((prev) => ({ ...prev, senderPresetId: id }))}
        />

        {/* A/B テスト紐付け (G1・この配信を案 A/B として作る)。実 A/B 送信は owner 立会後。 */}
        {abTests.length > 0 && (
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-2">A/B テスト（任意）</label>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={form.abTestId ?? ''}
                onChange={(e) => setForm((prev) => ({ ...prev, abTestId: e.target.value || null, abVariant: e.target.value ? (prev.abVariant ?? 'A') : null }))}
                aria-label="A/Bテストを選ぶ"
                className="text-xs border border-gray-300 rounded px-2 py-1 bg-white"
              >
                <option value="">紐付けない</option>
                {abTests.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              {form.abTestId && (
                <div className="flex items-center gap-3 text-xs text-gray-600">
                  <span>この配信は</span>
                  <label className="flex items-center gap-1">
                    <input type="radio" name="abVariant" style={{ accentColor: '#06C755' }} checked={form.abVariant === 'A'} onChange={() => setForm((prev) => ({ ...prev, abVariant: 'A' }))} />案A
                  </label>
                  <label className="flex items-center gap-1">
                    <input type="radio" name="abVariant" style={{ accentColor: '#06C755' }} checked={form.abVariant === 'B'} onChange={() => setForm((prev) => ({ ...prev, abVariant: 'B' }))} />案B
                  </label>
                </div>
              )}
            </div>
            {form.abTestId && (
              <p className="text-xs text-gray-400 mt-1">案A・案Bの2本を作って比べます。実際の A/B 送信は owner 確認後です。</p>
            )}
          </div>
        )}

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
    </div>
  )
}
