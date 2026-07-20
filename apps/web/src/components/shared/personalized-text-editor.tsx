'use client'

import { useEffect, useRef, useState } from 'react'
import type { FriendFieldDefinition } from '@line-crm/shared'
import { api } from '@/lib/api'

interface PersonalizedTextEditorProps {
  value: string
  onChange: (value: string) => void
  ariaLabel?: string
  placeholder?: string
  rows?: number
  className?: string
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
  ariaLabel = 'メッセージ内容',
  placeholder,
  rows = 4,
  className = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-y',
}: PersonalizedTextEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [fieldDefinitions, setFieldDefinitions] = useState<FriendFieldDefinition[]>([])
  const [variablesOpen, setVariablesOpen] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [emojiCategory, setEmojiCategory] = useState<(typeof EMOJI_CATEGORIES)[number]['id']>('faces')

  useEffect(() => {
    let cancelled = false
    const listDefinitions = api.friendFieldDefinitions?.list
    if (!listDefinitions) return () => { cancelled = true }
    listDefinitions()
      .then((response) => {
        if (!cancelled && response.success) {
          setFieldDefinitions(response.data.filter((definition) => definition.isActive))
        }
      })
      .catch(() => {
        // 名前変数・絵文字・通常入力は API 障害時も使えるよう fail-soft にする。
      })
    return () => { cancelled = true }
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
    const textarea = textareaRef.current
    const start = textarea?.selectionStart ?? value.length
    const end = textarea?.selectionEnd ?? start
    const nextValue = `${value.slice(0, start)}${text}${value.slice(end)}`
    const nextCaret = start + text.length
    onChange(nextValue)
    setVariablesOpen(false)
    setEmojiOpen(false)
    requestAnimationFrame(() => {
      textarea?.focus()
      textarea?.setSelectionRange(nextCaret, nextCaret)
    })
  }

  const activeEmojiCategory = EMOJI_CATEGORIES.find((category) => category.id === emojiCategory)!

  return (
    <div className="space-y-2">
      <div className="relative flex flex-wrap gap-2">
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
        <button
          type="button"
          aria-label="絵文字"
          aria-expanded={emojiOpen}
          aria-haspopup="dialog"
          onClick={() => {
            setEmojiOpen((open) => !open)
            setVariablesOpen(false)
          }}
          className="min-h-[44px] rounded-md border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:border-green-500 hover:text-green-700"
        >
          😊 絵文字
        </button>

        {variablesOpen && (
          <div
            role="dialog"
            aria-label="挿入する変数を選ぶ"
            className="absolute left-0 top-full z-20 mt-1 w-72 rounded-lg border border-gray-200 bg-white p-3 shadow-lg"
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
            className="absolute left-0 top-full z-20 mt-1 w-80 rounded-lg border border-gray-200 bg-white p-3 shadow-lg"
          >
            <div className="mb-2 flex gap-1" role="tablist" aria-label="絵文字カテゴリ">
              {EMOJI_CATEGORIES.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  role="tab"
                  aria-selected={emojiCategory === category.id}
                  onClick={() => setEmojiCategory(category.id)}
                  className={`min-h-[36px] rounded-md px-2 py-1 text-xs ${
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
                  onClick={() => insertAtSelection(emoji)}
                  className="flex h-10 w-10 items-center justify-center rounded-md text-xl hover:bg-gray-100"
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <textarea
        ref={textareaRef}
        aria-label={ariaLabel}
        className={className}
        rows={rows}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <p className="text-xs text-gray-400">
        「友だちの名前」は送信時に表示名へ置き換わります。名前がない場合は「お客様」になります。
      </p>
    </div>
  )
}
