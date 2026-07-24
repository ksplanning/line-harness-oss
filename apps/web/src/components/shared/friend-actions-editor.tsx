'use client'

import type { FriendFieldDefinition, Tag } from '@line-crm/shared'
import type { FormSubmitAction } from '@/lib/formaloo-advanced-api'
import { ChevronDownIcon, ChevronUpIcon, TrashIcon } from '@/components/shared/icons'

const ACTION_OPTIONS: ReadonlyArray<{
  type: FormSubmitAction['type']
  label: string
}> = [
  { type: 'add_tag', label: 'タグを付ける' },
  { type: 'remove_tag', label: 'タグを外す' },
  { type: 'set_field', label: 'カスタム項目に値を入れる' },
  { type: 'clear_field', label: 'カスタム項目を空欄にする' },
]

function newAction(
  type: FormSubmitAction['type'],
  tags: readonly Tag[],
  fieldDefinitions: readonly FriendFieldDefinition[],
): FormSubmitAction {
  if (type === 'add_tag' || type === 'remove_tag') {
    return { type, tagId: tags[0]?.id ?? '' }
  }
  const fieldId = fieldDefinitions.find((definition) => definition.isActive)?.id ?? ''
  return type === 'set_field'
    ? { type, fieldId, value: '' }
    : { type, fieldId }
}

export function validateFriendActions(actions: readonly FormSubmitAction[]): string | null {
  const incompleteIndex = actions.findIndex((action) => (
    action.type === 'add_tag' || action.type === 'remove_tag'
      ? !action.tagId
      : !action.fieldId
  ))
  if (incompleteIndex < 0) return null
  const action = actions[incompleteIndex]
  return action.type === 'add_tag' || action.type === 'remove_tag'
    ? `アクション ${incompleteIndex + 1}のタグを選んでください。`
    : `アクション ${incompleteIndex + 1}のカスタム項目を選んでください。`
}

interface Props {
  actions: FormSubmitAction[]
  onChange: (actions: FormSubmitAction[]) => void
  tags: readonly Tag[]
  fieldDefinitions: readonly FriendFieldDefinition[]
  title?: string
  description?: string
  footnote?: string
  error?: string | null
  settingId?: string
  testId?: string
  className?: string
}

export default function FriendActionsEditor({
  actions,
  onChange,
  tags,
  fieldDefinitions,
  title = '送信後にやること',
  description = '回答した友だちに対して、上から順番に実行します。必要なものをいくつでも追加できます。',
  footnote = '※ 友だち情報がない場合は安全のため実行しません。元の処理はそのまま完了します。',
  error,
  settingId,
  testId,
  className = '',
}: Props) {
  const changeType = (index: number, type: FormSubmitAction['type']) => {
    onChange(actions.map((action, currentIndex) => (
      currentIndex === index ? newAction(type, tags, fieldDefinitions) : action
    )))
  }

  const changeTarget = (index: number, targetId: string) => {
    onChange(actions.map((action, currentIndex) => {
      if (currentIndex !== index) return action
      if (action.type === 'add_tag' || action.type === 'remove_tag') {
        return { ...action, tagId: targetId }
      }
      return { ...action, fieldId: targetId }
    }))
  }

  const move = (index: number, direction: -1 | 1) => {
    const destination = index + direction
    if (destination < 0 || destination >= actions.length) return
    const next = [...actions]
    ;[next[index], next[destination]] = [next[destination], next[index]]
    onChange(next)
  }

  return (
    <div
      data-setting-id={settingId}
      data-testid={testId}
      className={`rounded-md border border-blue-100 bg-blue-50/40 px-3 py-3 ${className}`}
    >
      <div className="text-sm font-semibold text-gray-800">{title}</div>
      <p className="mt-1 text-[11px] leading-relaxed text-gray-500">{description}</p>

      {actions.length === 0 ? (
        <p className="mt-3 rounded border border-dashed border-gray-200 bg-white px-3 py-3 text-center text-xs text-gray-400">
          まだ設定されていません。
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {actions.map((action, index) => {
            const number = index + 1
            const isTagAction = action.type === 'add_tag' || action.type === 'remove_tag'
            const currentTagId = isTagAction ? action.tagId : ''
            const currentFieldId = isTagAction ? '' : action.fieldId
            const fieldOptions = fieldDefinitions.filter((definition) => (
              definition.isActive || definition.id === currentFieldId
            ))
            return (
              <article
                key={`${index}:${action.type}`}
                aria-label={`アクション ${number}`}
                className="rounded-lg border border-gray-200 bg-white p-3"
              >
                <div className="flex flex-wrap items-end gap-2">
                  <label className="min-w-48 flex-1 text-[11px] text-gray-500">
                    やること {number}
                    <select
                      aria-label={`アクション ${number}の種類`}
                      value={action.type}
                      onChange={(event) => changeType(
                        index,
                        event.target.value as FormSubmitAction['type'],
                      )}
                      className="mt-0.5 w-full rounded border border-gray-300 bg-white px-2 py-2 text-sm"
                    >
                      {ACTION_OPTIONS.map((option) => (
                        <option key={option.type} value={option.type}>{option.label}</option>
                      ))}
                    </select>
                  </label>

                  <div className="flex gap-1">
                    <button
                      type="button"
                      aria-label={`アクション ${number}を上へ移動`}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                      className="inline-flex min-h-10 items-center gap-1 rounded border border-gray-200 px-2 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-30"
                    >
                      <ChevronUpIcon className="h-4 w-4" />
                      上へ
                    </button>
                    <button
                      type="button"
                      aria-label={`アクション ${number}を下へ移動`}
                      disabled={index === actions.length - 1}
                      onClick={() => move(index, 1)}
                      className="inline-flex min-h-10 items-center gap-1 rounded border border-gray-200 px-2 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-30"
                    >
                      <ChevronDownIcon className="h-4 w-4" />
                      下へ
                    </button>
                    <button
                      type="button"
                      aria-label={`アクション ${number}を削除`}
                      onClick={() => onChange(actions.filter((_, currentIndex) => currentIndex !== index))}
                      className="inline-flex min-h-10 items-center gap-1 rounded bg-red-50 px-2 text-xs text-red-600 hover:bg-red-100"
                    >
                      <TrashIcon className="h-4 w-4" />
                      削除
                    </button>
                  </div>
                </div>

                {isTagAction ? (
                  <label className="mt-2 block text-[11px] text-gray-500">
                    対象のタグ
                    <select
                      aria-label={`アクション ${number}のタグ`}
                      value={action.tagId}
                      onChange={(event) => changeTarget(index, event.target.value)}
                      className="mt-0.5 w-full rounded border border-gray-300 bg-white px-2 py-2 text-sm"
                    >
                      <option value="">タグを選んでください</option>
                      {tags.map((tag) => (
                        <option key={tag.id} value={tag.id}>{tag.name}</option>
                      ))}
                      {currentTagId && !tags.some((tag) => tag.id === currentTagId) && (
                        <option value={currentTagId}>保存済みのタグ（現在は一覧にありません）</option>
                      )}
                    </select>
                  </label>
                ) : (
                  <>
                    <label className="mt-2 block text-[11px] text-gray-500">
                      対象のカスタム項目
                      <select
                        aria-label={`アクション ${number}のカスタム項目`}
                        value={action.fieldId}
                        onChange={(event) => changeTarget(index, event.target.value)}
                        className="mt-0.5 w-full rounded border border-gray-300 bg-white px-2 py-2 text-sm"
                      >
                        <option value="">カスタム項目を選んでください</option>
                        {fieldOptions.map((definition) => (
                          <option key={definition.id} value={definition.id}>
                            {definition.name}{definition.isActive ? '' : '（無効）'}
                          </option>
                        ))}
                        {currentFieldId && !fieldDefinitions.some((definition) => definition.id === currentFieldId) && (
                          <option value={currentFieldId}>保存済みの項目（現在は一覧にありません）</option>
                        )}
                      </select>
                    </label>
                    {action.type === 'set_field' ? (
                      <label className="mt-2 block text-[11px] text-gray-500">
                        入れる値
                        <input
                          aria-label={`アクション ${number}の値`}
                          value={action.value}
                          onChange={(event) => onChange(actions.map((current, currentIndex) => (
                            currentIndex === index && current.type === 'set_field'
                              ? { ...current, value: event.target.value }
                              : current
                          )))}
                          placeholder="例: 済"
                          className="mt-0.5 w-full rounded border border-gray-300 bg-white px-2 py-2 text-sm"
                        />
                      </label>
                    ) : (
                      <p className="mt-2 text-[11px] text-gray-500">選んだ項目を空欄にします。</p>
                    )}
                  </>
                )}
              </article>
            )
          })}
        </div>
      )}

      <button
        type="button"
        aria-label="やることを追加"
        onClick={() => onChange([...actions, newAction('add_tag', tags, fieldDefinitions)])}
        className="mt-3 min-h-11 w-full rounded-lg border border-dashed border-blue-300 bg-white text-sm font-medium text-blue-700 hover:bg-blue-50"
      >
        ＋ やることを追加
      </button>
      {error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
      <p className="mt-2 text-[10px] leading-snug text-gray-400">{footnote}</p>
    </div>
  )
}
