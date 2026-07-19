'use client'

import { useEffect, useState } from 'react'
import type { ChoiceFetchItem, HarnessFieldConfig } from '@line-crm/shared'
import { formalooChoiceListsApi, type FormalooChoiceList } from '@/lib/formaloo-choice-lists-api'

const LINE_GREEN = '#06C755'

export interface ChoiceFetchFieldPanelProps {
  formId?: string
  config: HarnessFieldConfig
  onChange: (patch: Partial<HarnessFieldConfig>) => void
  onManagedListChange?: (listId: string, next: { sourceUrl: string; items: ChoiceFetchItem[] } | null) => void
}

function message(error: unknown): string {
  return (error as { body?: { error?: string } })?.body?.error
    ?? (error instanceof Error ? error.message : '選択肢リストの操作に失敗しました')
}

export default function ChoiceFetchFieldPanel({ formId, config, onChange, onManagedListChange }: ChoiceFetchFieldPanelProps) {
  const [lists, setLists] = useState<FormalooChoiceList[]>([])
  const [newName, setNewName] = useState('')
  const [draftName, setDraftName] = useState('')
  const [draftItems, setDraftItems] = useState<ChoiceFetchItem[]>([])
  const [loading, setLoading] = useState(Boolean(formId))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selected = lists.find((list) => list.id === config.choiceListId)

  useEffect(() => {
    let active = true
    if (!formId) {
      setLoading(false)
      return () => { active = false }
    }
    setLoading(true)
    void formalooChoiceListsApi.list(formId)
      .then((loaded) => {
        if (!active) return
        setLists(loaded)
        const configured = loaded.find((list) => list.id === config.choiceListId)
          ?? (!config.choiceListId && config.choicesSource
            ? loaded.find((list) => list.sourceUrl === config.choicesSource)
            : undefined)
        if (configured) {
          const snapshot = {
            sourceUrl: configured.sourceUrl,
            items: configured.items.map((item) => ({ ...item })),
          }
          setDraftName(configured.name)
          setDraftItems(snapshot.items)
          onChange({
            choiceListId: configured.id,
            choicesSource: snapshot.sourceUrl,
            choiceFetchItems: snapshot.items,
          })
          onManagedListChange?.(configured.id, snapshot)
        }
        setError(null)
      })
      .catch((cause) => { if (active) setError(message(cause)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [formId])

  const adopt = (list: FormalooChoiceList) => {
    setDraftName(list.name)
    setDraftItems(list.items.map((item) => ({ ...item })))
    onChange({
      choiceListId: list.id,
      choicesSource: list.sourceUrl,
      choiceFetchItems: list.items.map((item) => ({ ...item })),
    })
  }

  const select = (id: string) => {
    const list = lists.find((candidate) => candidate.id === id)
    if (list) adopt(list)
    else onChange({ choiceListId: undefined, choicesSource: undefined, choiceFetchItems: undefined })
  }

  const create = async () => {
    if (!formId || !newName.trim() || loading || busy) return
    setBusy(true)
    try {
      const created = await formalooChoiceListsApi.create(formId, { name: newName.trim(), items: [] })
      setLists((current) => [...current, created])
      setNewName('')
      setError(null)
      adopt(created)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!formId || !selected || !draftName.trim() || busy) return
    setBusy(true)
    try {
      const updated = await formalooChoiceListsApi.update(formId, selected.id, {
        name: draftName.trim(),
        items: draftItems,
      })
      setLists((current) => current.map((list) => list.id === updated.id ? updated : list))
      setError(null)
      adopt(updated)
      onManagedListChange?.(updated.id, { sourceUrl: updated.sourceUrl, items: updated.items })
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!formId || !selected || busy) return
    setBusy(true)
    try {
      await formalooChoiceListsApi.remove(formId, selected.id)
      setLists((current) => current.filter((list) => list.id !== selected.id))
      setDraftName('')
      setDraftItems([])
      setError(null)
      onChange({ choiceListId: undefined, choicesSource: undefined, choiceFetchItems: undefined })
      onManagedListChange?.(selected.id, null)
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBusy(false)
    }
  }

  if (!formId) {
    return (
      <p className="text-[10px] leading-snug text-amber-600">
        フォームを一度保存してから、供給する選択肢リストを設定できます。
      </p>
    )
  }

  return (
    <div className="space-y-3" data-testid="choice-fetch-field-panel">
      <div>
        <label className="mb-1 block text-xs text-gray-500">選択肢リスト</label>
        <select
          aria-label="選択肢リスト"
          value={config.choiceListId ?? ''}
          onChange={(event) => select(event.target.value)}
          disabled={loading || busy}
          className="w-full rounded border border-gray-300 px-2 py-1"
        >
          <option value="">{loading ? '読み込み中...' : 'リストを選択'}</option>
          {lists.map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}
        </select>
        {config.choicesSource && (
          <p className="mt-1 break-all text-[10px] leading-snug text-gray-400">
            供給URL: {config.choicesSource}
          </p>
        )}
      </div>

      <div className="rounded border border-gray-200 bg-gray-50 p-2">
        <label className="mb-1 block text-xs text-gray-500">新しいリスト名</label>
        <div className="flex gap-1">
          <input
            aria-label="新しいリスト名"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="例: 予約店舗"
            className="min-w-0 flex-1 rounded border border-gray-300 bg-white px-2 py-1"
          />
          <button
            type="button"
            aria-label="リストを作成"
            onClick={() => void create()}
            disabled={loading || busy || !newName.trim()}
            className="shrink-0 rounded px-2 py-1 text-xs text-white disabled:opacity-50"
            style={{ backgroundColor: LINE_GREEN }}
          >
            作成
          </button>
        </div>
      </div>

      {selected && (
        <div className="space-y-2 rounded border border-gray-200 p-2">
          <div>
            <label className="mb-1 block text-xs text-gray-500">リスト名</label>
            <input
              aria-label="リスト名"
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              className="w-full rounded border border-gray-300 px-2 py-1"
            />
          </div>
          <div className="space-y-1">
            {draftItems.map((item, index) => (
              <div key={index} data-testid={`choice-list-item-${index}`} className="grid grid-cols-[1fr_1fr_auto] gap-1">
                <input
                  aria-label="表示名"
                  value={item.label}
                  onChange={(event) => setDraftItems((current) => current.map((candidate, currentIndex) => (
                    currentIndex === index ? { ...candidate, label: event.target.value } : candidate
                  )))}
                  placeholder="表示名"
                  className="min-w-0 rounded border border-gray-300 px-1 py-1"
                />
                <input
                  aria-label="値"
                  value={item.value}
                  onChange={(event) => setDraftItems((current) => current.map((candidate, currentIndex) => (
                    currentIndex === index ? { ...candidate, value: event.target.value } : candidate
                  )))}
                  placeholder="value"
                  className="min-w-0 rounded border border-gray-300 px-1 py-1"
                />
                <button
                  type="button"
                  aria-label={`選択肢${index + 1}を削除`}
                  onClick={() => setDraftItems((current) => current.filter((_, currentIndex) => currentIndex !== index))}
                  className="px-1 text-gray-400 hover:text-red-600"
                >✕</button>
              </div>
            ))}
          </div>
          <button
            type="button"
            aria-label="選択肢を追加"
            onClick={() => setDraftItems((current) => [...current, { label: '', value: '' }])}
            className="text-xs"
            style={{ color: LINE_GREEN }}
          >＋ 選択肢を追加</button>
          <div className="flex gap-2">
            <button
              type="button"
              aria-label="リストを保存"
              onClick={() => void save()}
              disabled={busy || !draftName.trim()}
              className="rounded px-2 py-1 text-xs text-white disabled:opacity-50"
              style={{ backgroundColor: LINE_GREEN }}
            >リストを保存</button>
            <button
              type="button"
              aria-label="リストを削除"
              onClick={() => void remove()}
              disabled={busy}
              className="text-xs text-red-600 disabled:opacity-50"
            >削除</button>
          </div>
        </div>
      )}

      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
      <p className="text-[10px] leading-snug text-gray-400">
        リストを選ぶと、このフォーム専用の公開供給 URL が自動設定されます。
      </p>
    </div>
  )
}
