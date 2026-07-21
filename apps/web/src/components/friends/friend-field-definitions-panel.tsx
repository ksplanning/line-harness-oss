'use client'

import { useState, type FormEvent } from 'react'
import type { FriendFieldDefinition } from '@line-crm/shared'
import { api } from '@/lib/api'

interface Props {
  id?: string
  definitions: readonly FriendFieldDefinition[]
  onRefresh: () => void | Promise<void>
}

function DefinitionRow({
  definition,
  onRefresh,
}: {
  definition: FriendFieldDefinition
  onRefresh: Props['onRefresh']
}) {
  const [name, setName] = useState(definition.name)
  const [defaultValue, setDefaultValue] = useState(definition.defaultValue)
  const [displayOrder, setDisplayOrder] = useState(String(definition.displayOrder))
  const [isActive, setIsActive] = useState(definition.isActive)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.friendFieldDefinitions.update(definition.id, {
        name: name.trim(),
        defaultValue,
        displayOrder: Number(displayOrder),
        isActive,
      })
      await onRefresh()
    } catch {
      setError('項目定義の保存に失敗しました')
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    setError('')
    try {
      await api.friendFieldDefinitions.delete(definition.id)
      await onRefresh()
    } catch {
      setError('項目定義の削除に失敗しました')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="grid gap-2 rounded-lg border border-gray-200 p-3 md:grid-cols-[1.2fr_1fr_6rem_auto_auto] md:items-end">
      <label className="text-xs text-gray-600">
        項目名
        <input
          aria-label={`${definition.name}の項目名`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
        />
      </label>
      <label className="text-xs text-gray-600">
        既定値
        <input
          aria-label={`${definition.name}の既定値`}
          value={defaultValue}
          onChange={(event) => setDefaultValue(event.target.value)}
          className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
        />
      </label>
      <label className="text-xs text-gray-600">
        表示順
        <input
          aria-label={`${definition.name}の表示順`}
          type="number"
          value={displayOrder}
          onChange={(event) => setDisplayOrder(event.target.value)}
          className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
        />
      </label>
      <label className="flex min-h-9 items-center gap-2 text-xs text-gray-600">
        <input
          aria-label={`${definition.name}を有効にする`}
          type="checkbox"
          checked={isActive}
          onChange={(event) => setIsActive(event.target.checked)}
        />
        有効
      </label>
      <div className="flex gap-2">
        <button
          type="submit"
          aria-label={`${definition.name}を保存`}
          disabled={busy || !name.trim()}
          className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
        >
          保存
        </button>
        <button
          type="button"
          aria-label={`${definition.name}を削除`}
          onClick={remove}
          disabled={busy}
          className="rounded-md bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 disabled:opacity-50"
        >
          削除
        </button>
      </div>
      {error && <p className="text-xs text-red-600 md:col-span-5">{error}</p>}
    </form>
  )
}

export default function FriendFieldDefinitionsPanel({ id = 'friend-custom-fields', definitions, onRefresh }: Props) {
  const [name, setName] = useState('')
  const [defaultValue, setDefaultValue] = useState('')
  const [displayOrder, setDisplayOrder] = useState('0')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const create = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.friendFieldDefinitions.create({
        name: name.trim(),
        defaultValue,
        displayOrder: Number(displayOrder),
        isActive: true,
      })
      setName('')
      setDefaultValue('')
      setDisplayOrder('0')
      await onRefresh()
    } catch {
      setError('項目定義の追加に失敗しました')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section id={id} className="mb-4 scroll-mt-20 rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-gray-800">カスタムフィールド（全員共通の項目）</h2>
      <p className="mt-1 text-xs text-gray-500">
        ここで一回作れば、すべての友だちの個人情報欄に同じカスタムフィールドが出ます。全員分の入力は不要で、未入力は既定値を表示します。
      </p>

      <form onSubmit={create} className="mt-3 grid gap-2 rounded-lg bg-gray-50 p-3 md:grid-cols-[1.2fr_1fr_6rem_auto] md:items-end">
        <label className="text-xs text-gray-600">
          項目名
          <input
            aria-label="新しい項目名"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="例: 入金確認"
            className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-xs text-gray-600">
          既定値
          <input
            aria-label="新しい既定値"
            value={defaultValue}
            onChange={(event) => setDefaultValue(event.target.value)}
            placeholder="例: 未"
            className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          />
        </label>
        <label className="text-xs text-gray-600">
          表示順
          <input
            aria-label="新しい表示順"
            type="number"
            value={displayOrder}
            onChange={(event) => setDisplayOrder(event.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
          />
        </label>
        <button
          type="submit"
          disabled={busy || !name.trim()}
          className="rounded-md bg-green-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
        >
          項目定義を追加
        </button>
        {error && <p className="text-xs text-red-600 md:col-span-4">{error}</p>}
      </form>

      {definitions.length === 0 ? (
        <p className="mt-3 text-xs text-gray-400">定義済みの項目はありません。</p>
      ) : (
        <div className="mt-3 space-y-2">
          {definitions.map((definition) => (
            <DefinitionRow key={definition.id} definition={definition} onRefresh={onRefresh} />
          ))}
        </div>
      )}
    </section>
  )
}
