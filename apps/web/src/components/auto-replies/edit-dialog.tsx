'use client'

import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import { packToFormMessages } from '@/lib/template-packs/pack-insert'
import FlexBuilderModal from '@/components/flex-builder/flex-builder-modal'
import { flexToModel } from '@/lib/flex-builder/from-flex'
import type { BuilderModel } from '@/lib/flex-builder/types'
import ImageUploader from '@/components/shared/image-uploader'
import PersonalizedTextEditor from '@/components/shared/personalized-text-editor'

export type AutoReplyMessageType = 'text' | 'flex' | 'image'

export interface AutoReplyResponseMessage {
  messageType: AutoReplyMessageType
  messageContent: string
}

export interface AutoReplyDraft {
  id?: string
  keyword: string
  matchType: 'exact' | 'contains'
  responseType: string
  responseContent: string
  responseMessages?: AutoReplyResponseMessage[]
  templateId: string | null
  lineAccountId: string | null
  isActive: boolean
}

interface Props {
  draft: AutoReplyDraft
  /** 共通ルールでパックを読むときだけ使う。ルール自体の適用範囲は変えない。 */
  packAccountId?: string | null
  templates: Array<{ id: string; name: string; messageType: string; messageContent: string }>
  onClose: () => void
  onSaved: () => void
}

interface TemplatePackSummary {
  id: string
  name: string
  itemCount: number
}

type ReplyMode = 'messages' | 'silent'

const MAX_MESSAGES = 5

function supportedType(value: string): AutoReplyMessageType {
  return value === 'flex' || value === 'image' ? value : 'text'
}

function initialMessages(draft: AutoReplyDraft): AutoReplyResponseMessage[] {
  if (draft.responseMessages && draft.responseMessages.length > 0) {
    return draft.responseMessages.map((message) => ({ ...message }))
  }
  if (draft.responseType === 'silent') return []
  return [{ messageType: supportedType(draft.responseType), messageContent: draft.responseContent }]
}

function onlyBlankMessage(messages: AutoReplyResponseMessage[]): boolean {
  return messages.length === 1 && messages[0].messageType === 'text' && !messages[0].messageContent.trim()
}

function imageValue(content: string) {
  try {
    const parsed = JSON.parse(content) as { originalContentUrl?: string; previewImageUrl?: string }
    if (parsed.originalContentUrl) {
      return {
        mode: 'line-image' as const,
        originalContentUrl: parsed.originalContentUrl,
        previewImageUrl: parsed.previewImageUrl ?? parsed.originalContentUrl,
      }
    }
  } catch { /* 入力途中・旧値は未設定として扱う */ }
  return null
}

export default function EditDialog({ draft, packAccountId, templates, onClose, onSaved }: Props) {
  const [keyword, setKeyword] = useState(draft.keyword)
  const [matchType, setMatchType] = useState<'exact' | 'contains'>(draft.matchType)
  const [replyMode, setReplyMode] = useState<ReplyMode>(draft.responseType === 'silent' ? 'silent' : 'messages')
  const [messages, setMessagesState] = useState<AutoReplyResponseMessage[]>(() => initialMessages(draft))
  const messagesRef = useRef(messages)
  const [sourceTemplateId, setSourceTemplateId] = useState<string | null>(draft.templateId)
  const [selectedTemplateId, setSelectedTemplateId] = useState(draft.templateId ?? '')
  const [packs, setPacks] = useState<TemplatePackSummary[]>([])
  const [selectedPackId, setSelectedPackId] = useState('')
  const [packLoading, setPackLoading] = useState(false)
  const [builderIndex, setBuilderIndex] = useState<number | null>(null)
  const [builderInitial, setBuilderInitial] = useState<BuilderModel | undefined>()
  const [advancedJsonIndex, setAdvancedJsonIndex] = useState<number | null>(null)
  const [isActive, setIsActive] = useState(draft.isActive)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const resolvedPackAccountId = draft.lineAccountId ?? packAccountId ?? null

  useEffect(() => {
    let cancelled = false
    if (!resolvedPackAccountId) {
      setPacks([])
      return () => { cancelled = true }
    }
    api.templatePacks.list(resolvedPackAccountId)
      .then((result) => {
        if (!cancelled && result.success) setPacks(result.data)
      })
      .catch(() => {
        if (!cancelled) setPacks([])
      })
    return () => { cancelled = true }
  }, [resolvedPackAccountId])

  const replaceMessages = (next: AutoReplyResponseMessage[]) => {
    messagesRef.current = next
    setMessagesState(next)
    setSourceTemplateId(null)
    setError('')
  }

  const restoreMessages = (next: AutoReplyResponseMessage[]) => {
    messagesRef.current = next
    setMessagesState(next)
  }

  const updateMessage = (index: number, patch: Partial<AutoReplyResponseMessage>) => {
    replaceMessages(messages.map((message, current) => current === index ? { ...message, ...patch } : message))
  }

  const addMessage = () => {
    if (messages.length >= MAX_MESSAGES) return
    replaceMessages([...messages, { messageType: 'text', messageContent: '' }])
  }

  const removeMessage = (index: number) => {
    if (messages.length <= 1) return
    replaceMessages(messages.filter((_, current) => current !== index))
  }

  const moveMessage = (index: number, direction: -1 | 1) => {
    const target = index + direction
    if (target < 0 || target >= messages.length) return
    const next = [...messages]
    ;[next[index], next[target]] = [next[target], next[index]]
    replaceMessages(next)
  }

  const addTemplate = () => {
    const template = templates.find((item) => item.id === selectedTemplateId)
    if (!template) { setError('テンプレートを選んでください'); return }
    const message: AutoReplyResponseMessage = {
      messageType: supportedType(template.messageType),
      messageContent: template.messageContent,
    }
    if (onlyBlankMessage(messages)) {
      restoreMessages([message])
      setSourceTemplateId(template.id)
    } else if (messages.length < MAX_MESSAGES) {
      replaceMessages([...messages, message])
    } else {
      setError('吹き出しは最大5件までです')
      return
    }
    setReplyMode('messages')
    setError('')
  }

  const expandPack = async () => {
    if (!resolvedPackAccountId) { setError('テンプレートパックはLINEアカウントを選んでから使えます'); return }
    if (!selectedPackId) { setError('テンプレートパックを選んでください'); return }
    setPackLoading(true)
    setError('')
    try {
      const result = await api.templatePacks.get(selectedPackId, resolvedPackAccountId)
      if (!result.success) throw new Error(result.error ?? 'パックの読み込みに失敗しました')
      const expanded = packToFormMessages(result.data.items)
      const latestMessages = messagesRef.current
      const base = onlyBlankMessage(latestMessages) ? [] : latestMessages
      if (expanded.length < 1) {
        setError('このテンプレートパックには吹き出しがありません')
      } else if (base.length + expanded.length > MAX_MESSAGES) {
        setError(`このパックを展開すると${base.length + expanded.length}件になります。吹き出しは最大5件までです`)
      } else {
        replaceMessages([...base, ...expanded])
        setReplyMode('messages')
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'パックの読み込みに失敗しました')
    } finally {
      setPackLoading(false)
    }
  }

  const openBuilder = (index: number) => {
    const content = messages[index].messageContent
    if (content.trim()) {
      const model = flexToModel(content)
      if (!model) {
        setAdvancedJsonIndex(index)
        setError('このFlexはビジュアル編集に変換できません。上級者向け JSON で内容を保ったまま編集できます')
        return
      }
      setBuilderInitial(model)
    } else {
      setBuilderInitial(undefined)
    }
    setError('')
    setBuilderIndex(index)
  }

  const handleBuilderSave = (json: string) => {
    if (builderIndex === null) return
    updateMessage(builderIndex, { messageType: 'flex', messageContent: json })
    setBuilderIndex(null)
  }

  const handleSave = async () => {
    if (!keyword.trim()) { setError('keyword を入力してください'); return }
    if (replyMode === 'messages') {
      if (messages.length < 1 || messages.length > MAX_MESSAGES) { setError('吹き出しは1〜5件で指定してください'); return }
      if (messages.some((message) => !message.messageContent.trim())) { setError('空の吹き出しがあります'); return }
    }
    setError('')
    setSaving(true)
    try {
      const first = replyMode === 'messages' ? messages[0] : null
      const preserveTemplateReference = replyMode === 'messages' && messages.length === 1 && Boolean(sourceTemplateId)
      const body = {
        keyword,
        matchType,
        responseType: first?.messageType ?? 'silent',
        responseContent: first?.messageContent ?? '',
        responseMessages: preserveTemplateReference || replyMode === 'silent' ? null : messages,
        templateId: preserveTemplateReference ? sourceTemplateId : null,
        lineAccountId: draft.lineAccountId,
        isActive,
      }
      if (draft.id) await api.autoReplies.update(draft.id, body)
      else await api.autoReplies.create(body)
      onSaved()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-4 border-b">
          <h3 className="text-base font-semibold">{draft.id ? '自動返信ルール 編集' : '新規 自動返信ルール'}</h3>
        </div>
        <div className="p-5 space-y-5">
          <div>
            <label className="block text-xs text-gray-600 mb-1">keyword</label>
            <input type="text" value={keyword} onChange={(event) => setKeyword(event.target.value)} className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500" placeholder="例: コスト比較" />
          </div>

          <div>
            <label className="block text-xs text-gray-600 mb-1">マッチ方法</label>
            <div className="flex gap-2">
              {(['exact', 'contains'] as const).map((value) => (
                <button key={value} type="button" aria-pressed={matchType === value} onClick={() => setMatchType(value)} className={`px-3 py-1.5 text-xs rounded-md border ${matchType === value ? 'border-green-600 bg-green-600 text-white' : 'border-gray-200 bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                  {value === 'exact' ? '完全一致' : '包含'}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs text-gray-600 mb-1">応答方法</label>
            <div className="flex gap-2" role="group" aria-label="応答方法">
              <button type="button" aria-pressed={replyMode === 'messages'} onClick={() => { setReplyMode('messages'); if (messages.length === 0) restoreMessages([{ messageType: 'text', messageContent: '' }]) }} className={`px-3 py-2 text-xs rounded-md border ${replyMode === 'messages' ? 'border-green-600 bg-green-50 text-green-800 ring-1 ring-green-500' : 'border-gray-200 text-gray-600'}`}>吹き出しを送る</button>
              <button type="button" aria-pressed={replyMode === 'silent'} onClick={() => setReplyMode('silent')} className={`px-3 py-2 text-xs rounded-md border ${replyMode === 'silent' ? 'border-green-600 bg-green-50 text-green-800 ring-1 ring-green-500' : 'border-gray-200 text-gray-600'}`}>返信なし (silent)</button>
            </div>
          </div>

          {replyMode === 'messages' && (
            <>
              <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
                <p className="text-xs font-semibold text-blue-900">テンプレートから追加</p>
                <div className="mt-2 flex gap-2">
                  <select aria-label="テンプレート" value={selectedTemplateId} onChange={(event) => setSelectedTemplateId(event.target.value)} className="min-w-0 flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm bg-white">
                    <option value="">-- 選択 --</option>
                    {templates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                  </select>
                  <button type="button" onClick={addTemplate} className="px-3 py-2 text-xs font-medium text-blue-700 border border-blue-300 bg-white rounded-md">テンプレートを追加</button>
                </div>
              </div>

              <div className="rounded-lg border border-purple-200 bg-purple-50 p-3">
                <p className="text-xs font-semibold text-purple-900">テンプレートパックから</p>
                <div className="mt-2 flex gap-2">
                  <select aria-label="テンプレートパック" value={selectedPackId} onChange={(event) => setSelectedPackId(event.target.value)} className="min-w-0 flex-1 border border-gray-300 rounded-md px-3 py-2 text-sm bg-white">
                    <option value="">-- 選択 --</option>
                    {packs.map((pack) => <option key={pack.id} value={pack.id}>{pack.name}（{pack.itemCount}吹き出し）</option>)}
                  </select>
                  <button type="button" onClick={expandPack} disabled={packLoading} className="px-3 py-2 text-xs font-medium text-purple-700 border border-purple-300 bg-white rounded-md disabled:opacity-50">{packLoading ? '読込中...' : 'パックを展開'}</button>
                </div>
              </div>

              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-gray-800">{messages.length} / 5 吹き出し</p>
                <button type="button" onClick={addMessage} disabled={messages.length >= MAX_MESSAGES} className="px-3 py-2 text-xs font-medium text-green-700 border border-green-300 rounded-md disabled:cursor-not-allowed disabled:opacity-40">＋ 吹き出しを追加</button>
              </div>

              <div className="space-y-4">
                {messages.map((message, index) => (
                  <section key={index} className="rounded-lg border border-gray-200 bg-gray-50 p-4" aria-labelledby={`auto-reply-message-${index}`}>
                    <div className="flex items-center justify-between gap-2">
                      <h4 id={`auto-reply-message-${index}`} className="text-sm font-semibold text-gray-800">吹き出し {index + 1}</h4>
                      <div className="flex gap-1">
                        <button type="button" aria-label={`吹き出し ${index + 1} を上へ`} disabled={index === 0} onClick={() => moveMessage(index, -1)} className="px-2 py-1 text-xs border rounded disabled:opacity-30">↑</button>
                        <button type="button" aria-label={`吹き出し ${index + 1} を下へ`} disabled={index === messages.length - 1} onClick={() => moveMessage(index, 1)} className="px-2 py-1 text-xs border rounded disabled:opacity-30">↓</button>
                        <button type="button" aria-label={`吹き出し ${index + 1} を削除`} disabled={messages.length === 1} onClick={() => removeMessage(index)} className="px-2 py-1 text-xs border border-red-200 text-red-600 rounded disabled:opacity-30">削除</button>
                      </div>
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={`吹き出し ${index + 1} の種類`}>
                      {([
                        ['text', 'テキスト'],
                        ['flex', 'Flex'],
                        ['image', '画像'],
                      ] as const).map(([type, label]) => (
                        <button key={type} type="button" aria-pressed={message.messageType === type} onClick={() => updateMessage(index, { messageType: type, messageContent: type === message.messageType ? message.messageContent : '' })} className={`px-3 py-1.5 text-xs rounded-md border ${message.messageType === type ? 'border-green-500 bg-green-50 text-green-800' : 'border-gray-300 bg-white text-gray-600'}`}>{label}</button>
                      ))}
                    </div>

                    <div className="mt-3">
                      {message.messageType === 'text' && (
                        <PersonalizedTextEditor mode="variables-and-emoji" ariaLabel={`吹き出し ${index + 1} テキスト`} rows={4} value={message.messageContent} onChange={(value) => updateMessage(index, { messageContent: value })} className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-y" />
                      )}
                      {message.messageType === 'image' && (
                        <ImageUploader mode="line-image" value={imageValue(message.messageContent)} onChange={(value) => updateMessage(index, { messageContent: value?.mode === 'line-image' ? JSON.stringify({ originalContentUrl: value.originalContentUrl, previewImageUrl: value.previewImageUrl }) : '' })} label={`吹き出し ${index + 1} の返信画像`} />
                      )}
                      {message.messageType === 'flex' && (
                        <div className="space-y-3">
                          <button type="button" onClick={() => openBuilder(index)} className="w-full min-h-[44px] px-4 py-3 text-sm font-medium text-white bg-green-600 rounded-md">ビジュアルで編集</button>
                          <button type="button" aria-label="上級者向け JSON" aria-expanded={advancedJsonIndex === index} onClick={() => setAdvancedJsonIndex(advancedJsonIndex === index ? null : index)} className="text-xs text-gray-500 hover:text-gray-700">上級者向け JSON</button>
                          {advancedJsonIndex === index && (
                            <textarea aria-label="Flex JSON" rows={8} value={message.messageContent} onChange={(event) => updateMessage(index, { messageContent: event.target.value })} className="w-full border border-gray-300 rounded-md px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-green-500 resize-y" />
                          )}
                        </div>
                      )}
                    </div>
                  </section>
                ))}
              </div>
            </>
          )}

          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500" />
            <span className="text-xs text-gray-600">有効</span>
          </label>
          {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
        </div>

        <div className="px-5 py-3 border-t flex gap-2 justify-end">
          <button type="button" onClick={onClose} className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md">キャンセル</button>
          <button type="button" onClick={handleSave} disabled={saving} className="px-3 py-1.5 text-xs font-medium text-white bg-green-600 rounded-md disabled:opacity-50">{saving ? '保存中...' : '保存'}</button>
        </div>
      </div>

      {builderIndex !== null && (
        <FlexBuilderModal initialModel={builderInitial} textEditorMode="variables-and-emoji" onSave={handleBuilderSave} onClose={() => setBuilderIndex(null)} />
      )}
    </div>
  )
}
