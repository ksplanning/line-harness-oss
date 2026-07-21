'use client'

import { useEffect, useRef, useState } from 'react'
import type { InputHTMLAttributes, ReactNode, Ref, TextareaHTMLAttributes } from 'react'
import type { FriendFieldDefinition } from '@line-crm/shared'

export type PersonalizedTextEditorMode = 'variables-and-emoji' | 'emoji-only'

interface PersonalizedTextEditorProps {
  value: string
  onChange: (value: string) => void
  mode?: PersonalizedTextEditorMode
  ariaLabel?: string
  placeholder?: string
  rows?: number
  className?: string
  containerClassName?: string
  pickerPlacement?: 'above' | 'below'
  toolbarPlacement?: 'above' | 'below'
  compactToolbar?: boolean
  toolbarClassName?: string
  toolbarLeading?: ReactNode
  toolbarTrailing?: ReactNode
  multiline?: boolean
  disabled?: boolean
  textareaRef?: Ref<HTMLTextAreaElement>
  inputRef?: Ref<HTMLInputElement>
  textareaProps?: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'aria-label' | 'className' | 'disabled' | 'onChange' | 'placeholder' | 'rows' | 'value'>
  inputProps?: Omit<InputHTMLAttributes<HTMLInputElement>, 'aria-label' | 'className' | 'disabled' | 'onChange' | 'placeholder' | 'type' | 'value'>
}

const RECENT_EMOJIS_STORAGE_KEY = 'line-crm:recent-emojis'
const MAX_RECENT_EMOJIS = 8

function readRecentEmojis(): string[] | null {
  try {
    const stored = JSON.parse(window.localStorage.getItem(RECENT_EMOJIS_STORAGE_KEY) ?? '[]') as unknown
    if (!Array.isArray(stored)) return []
    return [...new Set(stored.filter((emoji): emoji is string => typeof emoji === 'string'))]
      .slice(0, MAX_RECENT_EMOJIS)
  } catch {
    return null
  }
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value)
  else if (ref) ref.current = value
}

const EMOJI_CATEGORIES = [
  {
    id: 'faces',
    label: '顔・気持ち',
    emojis: ['😊', '😂', '🥰', '😍', '😄', '😉', '😢', '😭', '🙏', '👍', '👏', '🎉'],
  },
  {
    id: 'symbols',
    label: '記号・ハート',
    emojis: ['❤️', '💕', '✨', '⭐', '💡', '✅', '⚠️', '📌', '🎁', '🔥', '💯', '🌈'],
  },
  {
    id: 'season',
    label: '季節・くらし',
    emojis: ['🌸', '🌻', '🍀', '🍁', '🎄', '🌙', '☀️', '☔', '🍽️', '☕', '🚗', '🏠'],
  },
] as const

export default function PersonalizedTextEditor({
  value,
  onChange,
  mode = 'variables-and-emoji',
  ariaLabel = 'メッセージ内容',
  placeholder,
  rows = 4,
  className = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-y',
  containerClassName = 'space-y-2',
  pickerPlacement = 'below',
  toolbarPlacement = 'above',
  compactToolbar = false,
  toolbarClassName = 'flex-wrap',
  toolbarLeading,
  toolbarTrailing,
  multiline = true,
  disabled = false,
  textareaRef,
  inputRef,
  textareaProps,
  inputProps,
}: PersonalizedTextEditorProps) {
  const fieldRef = useRef<HTMLTextAreaElement | HTMLInputElement>(null)
  const [fieldDefinitions, setFieldDefinitions] = useState<FriendFieldDefinition[]>([])
  const [variablesOpen, setVariablesOpen] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [emojiCategory, setEmojiCategory] = useState<(typeof EMOJI_CATEGORIES)[number]['id']>('faces')
  const [recentEmojis, setRecentEmojis] = useState<string[]>([])
  const variablesEnabled = mode === 'variables-and-emoji'
  const pickerPositionClass = pickerPlacement === 'above' ? 'bottom-full mb-1' : 'top-full mt-1'

  useEffect(() => {
    if (!variablesEnabled) return
    let cancelled = false
    import('@/lib/api')
      .then(({ api }) => api.friendFieldDefinitions?.list?.())
      .then((response) => {
        if (!cancelled && response?.success) {
          setFieldDefinitions(response.data.filter((definition) => definition.isActive))
        }
      })
      .catch(() => {
        // 名前変数・絵文字・通常入力は API 障害時も使えるよう fail-soft にする。
      })
    return () => { cancelled = true }
  }, [variablesEnabled])

  useEffect(() => {
    const stored = readRecentEmojis()
    if (stored) setRecentEmojis(stored)
  }, [])

  useEffect(() => {
    if (!variablesOpen && !emojiOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setVariablesOpen(false)
        setEmojiOpen(false)
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [variablesOpen, emojiOpen])

  const insertAtSelection = (text: string) => {
    const field = fieldRef.current
    const start = field?.selectionStart ?? value.length
    const end = field?.selectionEnd ?? start
    const nextValue = `${value.slice(0, start)}${text}${value.slice(end)}`
    const nextCaret = start + text.length
    onChange(nextValue)
    setVariablesOpen(false)
    setEmojiOpen(false)
    requestAnimationFrame(() => {
      field?.focus()
      field?.setSelectionRange(nextCaret, nextCaret)
    })
  }

  const insertEmoji = (emoji: string) => {
    setRecentEmojis((current) => {
      const next = [emoji, ...current.filter((item) => item !== emoji)].slice(0, MAX_RECENT_EMOJIS)
      try {
        window.localStorage.setItem(RECENT_EMOJIS_STORAGE_KEY, JSON.stringify(next))
      } catch {
        // 保存できない端末でも挿入自体は止めない。
      }
      return next
    })
    insertAtSelection(emoji)
  }

  const activeEmojiCategory = EMOJI_CATEGORIES.find((category) => category.id === emojiCategory)!

  const toolbar = (
      <div
        role="group"
        aria-label="テキスト編集ツール"
        className={`relative flex gap-2 ${toolbarClassName}`}
      >
        {toolbarLeading}
        {variablesEnabled && (
          <button
            type="button"
            aria-label="変数を挿入"
            aria-expanded={variablesOpen}
            aria-haspopup="dialog"
            onClick={() => {
              setVariablesOpen((open) => !open)
              setEmojiOpen(false)
            }}
            className="min-h-[44px] rounded-md border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:border-green-500 hover:text-green-700"
          >
            {'{ }'} 変数を挿入
          </button>
        )}
        <button
          type="button"
          aria-label={compactToolbar ? '絵文字を選ぶ' : '絵文字'}
          aria-expanded={emojiOpen}
          aria-haspopup="dialog"
          title={compactToolbar ? '絵文字を選ぶ' : undefined}
          onClick={() => {
            if (!emojiOpen) {
              const stored = readRecentEmojis()
              if (stored) setRecentEmojis(stored)
            }
            setEmojiOpen((open) => !open)
            setVariablesOpen(false)
          }}
          className={compactToolbar
            ? `inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border transition-colors focus:outline-none focus:ring-2 focus:ring-green-500 ${
                emojiOpen
                  ? 'border-green-500 bg-green-50 text-green-700'
                  : 'border-gray-300 bg-white text-gray-600 hover:bg-gray-50'
              }`
            : 'min-h-[44px] rounded-md border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:border-green-500 hover:text-green-700'}
        >
          {compactToolbar ? (
            <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 14s1.5 2 4 2 4-2 4-2m-5-4h.01M16 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          ) : '😊 絵文字'}
        </button>
        {toolbarTrailing}

        {variablesOpen && (
          <div
            role="dialog"
            aria-label="挿入する変数を選ぶ"
            className={`absolute left-0 z-20 w-72 rounded-lg border border-gray-200 bg-white p-3 shadow-lg ${pickerPositionClass}`}
          >
            <p className="mb-2 text-xs font-semibold text-gray-700">送信時に友だちごとの情報へ変わります</p>
            <div className="space-y-1">
              <button
                type="button"
                aria-label="友だちの名前"
                onClick={() => insertAtSelection('{{display_name|お客様}}')}
                className="flex min-h-[44px] w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm text-gray-700 hover:bg-green-50 hover:text-green-700"
              >
                <span>友だちの名前</span>
                <span className="text-xs text-gray-400">例: 山田さん</span>
              </button>
              {fieldDefinitions.map((definition) => (
                <button
                  key={definition.id}
                  type="button"
                  onClick={() => insertAtSelection(`{{field:${definition.name}}}`)}
                  className="min-h-[44px] w-full rounded-md px-3 py-2 text-left text-sm text-gray-700 hover:bg-green-50 hover:text-green-700"
                >
                  {definition.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {emojiOpen && (
          <div
            role="dialog"
            aria-label="絵文字を選ぶ"
            className={`absolute left-0 z-20 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-gray-200 bg-white p-3 shadow-lg ${pickerPositionClass}`}
          >
            {recentEmojis.length > 0 && (
              <div className="mb-2">
                <p className="mb-1 text-xs font-semibold text-gray-700">最近使った</p>
                <div className="flex flex-nowrap gap-1 overflow-x-auto pb-1">
                  {recentEmojis.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      aria-label={`最近使った絵文字 ${emoji} を挿入`}
                      onClick={() => insertEmoji(emoji)}
                      className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md text-xl hover:bg-gray-100"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="mb-2 flex gap-1 overflow-x-auto" role="tablist" aria-label="絵文字カテゴリ">
              {EMOJI_CATEGORIES.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  role="tab"
                  aria-selected={emojiCategory === category.id}
                  onClick={() => setEmojiCategory(category.id)}
                  className={`min-h-[44px] shrink-0 rounded-md px-2 py-1 text-xs ${
                    emojiCategory === category.id
                      ? 'bg-green-50 font-medium text-green-700'
                      : 'text-gray-500 hover:bg-gray-50'
                  }`}
                >
                  {category.label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-6 gap-1">
              {activeEmojiCategory.emojis.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={`絵文字 ${emoji} を挿入`}
                  onClick={() => insertEmoji(emoji)}
                  className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-xl hover:bg-gray-100"
                >
                  {emoji}
                </button>
              ))}
            </div>
            <p className="mt-2 border-t border-gray-100 pt-2 text-[11px] text-gray-500">
              PC は Win+. / Mac は Ctrl+Cmd+Space でも入力できます
            </p>
          </div>
        )}
      </div>
  )

  return (
    <div className={containerClassName}>
      {toolbarPlacement === 'above' && toolbar}

      {multiline ? (
        <textarea
          {...textareaProps}
          ref={(element) => {
            fieldRef.current = element
            assignRef(textareaRef, element)
          }}
          aria-label={ariaLabel}
          className={className}
          disabled={disabled}
          rows={rows}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          {...inputProps}
          ref={(element) => {
            fieldRef.current = element
            assignRef(inputRef, element)
          }}
          type="text"
          aria-label={ariaLabel}
          className={className}
          disabled={disabled}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {toolbarPlacement === 'below' && toolbar}
      {variablesEnabled && (
        <p className="text-xs text-gray-400">
          「友だちの名前」は送信時に表示名へ置き換わります。名前がない場合は「お客様」になります。
        </p>
      )}
    </div>
  )
}
