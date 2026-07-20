'use client'

import { useState, useEffect, useCallback } from 'react'
import { api, type TemplatePackListItem, type TemplatePackItem, type TemplatePackItemInput } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import Header from '@/components/layout/header'
import FlexBuilderModal from '@/components/flex-builder/flex-builder-modal'
import { flexToModel } from '@/lib/flex-builder/from-flex'
import { validateFlex } from '@/lib/flex-builder/validate'
import type { BuilderModel } from '@/lib/flex-builder/types'
import TestSendDialog from '@/components/shared/test-send-dialog'
import PersonalizedTextEditor from '@/components/shared/personalized-text-editor'

function formatDate(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[1]}/${m[2]}/${m[3]}` : iso.slice(0, 10)
}

export default function TemplatePacksPage() {
  const { selectedAccountId } = useAccount()
  const [items, setItems] = useState<TemplatePackListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [pendingRemoveId, setPendingRemoveId] = useState<string | null>(null)
  const [editId, setEditId] = useState<string | 'new' | null>(null)

  const load = useCallback(async () => {
    if (!selectedAccountId) {
      setItems([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    try {
      const res = await api.templatePacks.list(selectedAccountId)
      if (res.success) setItems(res.data)
      else setError('配信セットの読み込みに失敗しました')
    } catch {
      setError('配信セットの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [selectedAccountId])

  useEffect(() => {
    load()
  }, [load])

  const handleDelete = async (id: string) => {
    if (!selectedAccountId) return
    try {
      await api.templatePacks.remove(id, selectedAccountId)
      setPendingRemoveId(null)
      await load()
    } catch {
      setError('削除に失敗しました')
      setPendingRemoveId(null)
    }
  }

  if (editId && selectedAccountId) {
    return (
      <PackEditor
        packId={editId}
        accountId={selectedAccountId}
        onBack={() => { setEditId(null); void load() }}
      />
    )
  }

  return (
    <div>
      <Header
        title="配信セット（テンプレパック）"
        description="よく使う吹き出しの組み合わせをひとまとめにしたセットです。配信作成時にパックを選ぶと複数の吹き出しがまとめて入ります。1パック = 複数吹き出し。"
        action={
          selectedAccountId ? (
            <button
              onClick={() => setEditId('new')}
              className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
              style={{ backgroundColor: '#06C755' }}
            >
              ＋ パックを作成
            </button>
          ) : undefined
        }
      />

      {error && <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

      {!selectedAccountId ? (
        <EmptyBox>上部でアカウントを選んでください。</EmptyBox>
      ) : loading ? (
        <EmptyBox>読み込み中...</EmptyBox>
      ) : items.length === 0 ? (
        <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
          <h3 className="text-lg font-semibold text-gray-800">まだ配信セットがありません</h3>
          <p className="mt-2 text-sm text-gray-500 leading-relaxed">
            例:『初回あいさつ → 商品説明 → CTA』のように複数の吹き出しをセットで保存できます。<br />
            配信作成時にパックを選ぶとまとめて入ります。
          </p>
          <button onClick={() => setEditId('new')} className="mt-5 px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90" style={{ backgroundColor: '#06C755' }}>
            ＋ 最初のパックを作る
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px]">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">パック名</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">吹き出し数</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">更新日</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider sticky right-0 z-10 bg-gray-50 border-l border-gray-200">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {items.map((item) => (
                  <tr key={item.id} className="group hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">{item.name}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{item.itemCount}吹き出し</td>
                    <td className="px-4 py-3 text-sm text-gray-500 whitespace-nowrap">{formatDate(item.updated_at)}</td>
                    <td className="px-4 py-3 text-right sticky right-0 z-10 bg-white group-hover:bg-gray-50 border-l border-gray-100">
                      {pendingRemoveId === item.id ? (
                        <span className="inline-flex items-center gap-1 justify-end">
                          <span className="text-xs text-gray-600">{item.itemCount}個の吹き出しを含むパックを削除しますか？</span>
                          <button onClick={() => handleDelete(item.id)} className="min-h-[36px] px-3 rounded-md text-xs font-medium text-white bg-red-600 hover:bg-red-700 whitespace-nowrap">はい</button>
                          <button onClick={() => setPendingRemoveId(null)} className="min-h-[36px] px-3 rounded-md text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 whitespace-nowrap">いいえ</button>
                        </span>
                      ) : (
                        <span className="inline-flex items-center justify-end">
                          <button onClick={() => setEditId(item.id)} className="px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-md">編集</button>
                          <button onClick={() => setPendingRemoveId(item.id)} className="ml-1 px-2.5 py-1 text-xs font-medium text-red-500 hover:bg-red-50 rounded-md">削除</button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function EmptyBox({ children }: { children: React.ReactNode }) {
  return <div className="bg-white rounded-lg shadow-sm border border-gray-200 px-4 py-8 text-center text-gray-400 text-sm">{children}</div>
}

// ---- パック編集 (吹き出しリスト: 追加/並び替え/削除) ----

interface DraftItem extends TemplatePackItemInput {
  key: string // React key (安定並び替え用)
}

function toDraft(items: TemplatePackItem[]): DraftItem[] {
  return items.map((it) => ({ key: it.id, messageType: it.message_type, messageContent: it.message_content }))
}

function PackEditor({ packId, accountId, onBack }: { packId: string | 'new'; accountId: string; onBack: () => void }) {
  const [name, setName] = useState('')
  const [drafts, setDrafts] = useState<DraftItem[]>([])
  const [loading, setLoading] = useState(packId !== 'new')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [pendingDeleteKey, setPendingDeleteKey] = useState<string | null>(null)
  const [flexEditor, setFlexEditor] = useState<{ mode: 'add' } | { mode: 'edit'; key: string } | null>(null)

  useEffect(() => {
    if (packId === 'new') { setLoading(false); return }
    let cancelled = false
    api.templatePacks.get(packId, accountId).then((r) => {
      if (cancelled) return
      if (r.success) { setName(r.data.name); setDrafts(toDraft(r.data.items)) }
      else setError('パックの読み込みに失敗しました')
    }).catch(() => setError('パックの読み込みに失敗しました')).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [packId, accountId])

  const newKey = () => `d-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

  const addText = () => setDrafts((d) => [...d, { key: newKey(), messageType: 'text', messageContent: '' }])
  const removeAt = (key: string) => { setDrafts((d) => d.filter((x) => x.key !== key)); setPendingDeleteKey(null) }
  const move = (idx: number, dir: -1 | 1) => {
    setDrafts((d) => {
      const j = idx + dir
      if (j < 0 || j >= d.length) return d
      const next = [...d]
      ;[next[idx], next[j]] = [next[j], next[idx]]
      return next
    })
  }
  const setText = (key: string, content: string) => setDrafts((d) => d.map((x) => (x.key === key ? { ...x, messageContent: content } : x)))

  const saveFlex = (json: string) => {
    if (flexEditor?.mode === 'edit') {
      setDrafts((d) => d.map((x) => (x.key === flexEditor.key ? { ...x, messageContent: json } : x)))
    } else {
      setDrafts((d) => [...d, { key: newKey(), messageType: 'flex', messageContent: json }])
    }
    setFlexEditor(null)
  }

  const flexInitialModel = (): BuilderModel | undefined => {
    if (flexEditor?.mode !== 'edit') return undefined
    const item = drafts.find((x) => x.key === flexEditor.key)
    if (!item) return undefined
    try {
      return flexToModel(JSON.parse(item.messageContent)) ?? undefined
    } catch {
      return undefined
    }
  }

  const handleSave = async () => {
    if (!name.trim()) { setError('パック名を入力してください'); return }
    // client 側 flex 検証 (server も同じ検証で二重)。
    for (const [i, it] of drafts.entries()) {
      if (it.messageType === 'text' && !it.messageContent.trim()) {
        setError(`#${i + 1} のテキストを入力してください`); return
      }
      if (it.messageType === 'flex') {
        try {
          const parsed = JSON.parse(it.messageContent)
          const v = validateFlex(parsed)
          if (!v.ok) { setError(`#${i + 1} のFlexが不正です: ${v.errors[0]?.messageJa ?? '内容を確認してください'}`); return }
        } catch {
          setError(`#${i + 1} のFlex JSONが不正です`); return
        }
      }
    }
    setSaving(true)
    setError('')
    try {
      const payloadItems: TemplatePackItemInput[] = drafts.map((d) => ({ messageType: d.messageType, messageContent: d.messageContent }))
      if (packId === 'new') {
        await api.templatePacks.create(accountId, { name: name.trim(), items: payloadItems })
      } else {
        await api.templatePacks.update(packId, { name: name.trim(), items: payloadItems }, accountId)
      }
      onBack()
    } catch {
      setError('保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <button onClick={onBack} className="mb-4 text-sm text-gray-500 hover:text-gray-700">← 配信セット一覧</button>

      {error && <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>}

      {loading ? (
        <EmptyBox>読み込み中...</EmptyBox>
      ) : (
        <>
          <div className="mb-4">
            <label className="block text-xs font-medium text-gray-600 mb-1">パック名 <span className="text-red-500">*</span></label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例: 初回あいさつセット"
              className="w-full max-w-md border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>

          <div className="bg-white rounded-lg shadow-sm border border-gray-200 divide-y divide-gray-100">
            {drafts.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-gray-400">吹き出しがありません。下のボタンで追加してください。</p>
            ) : (
              drafts.map((it, i) => (
                <div key={it.key} className="px-4 py-3 flex items-start gap-3">
                  <span className="mt-1 shrink-0 text-xs font-mono text-gray-400">#{i + 1}</span>
                  <span className={`mt-1 shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${it.messageType === 'flex' ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-700'}`}>
                    {it.messageType === 'flex' ? 'Flex' : 'テキスト'}
                  </span>
                  <div className="flex-1 min-w-0">
                    {it.messageType === 'text' ? (
                      <PersonalizedTextEditor
                        mode="emoji-only"
                        ariaLabel="テンプレパックのテキスト内容"
                        value={it.messageContent}
                        onChange={(messageContent) => setText(it.key, messageContent)}
                        rows={2}
                        placeholder="こんにちは！初めまして…"
                        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setFlexEditor({ mode: 'edit', key: it.key })}
                        className="text-xs text-purple-700 underline"
                      >
                        Flexメッセージを編集
                      </button>
                    )}
                  </div>
                  <div className="shrink-0 flex items-center gap-1">
                    <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="px-2 py-1 text-xs text-gray-500 disabled:opacity-30 hover:bg-gray-100 rounded" aria-label="上へ">↑</button>
                    <button type="button" onClick={() => move(i, 1)} disabled={i === drafts.length - 1} className="px-2 py-1 text-xs text-gray-500 disabled:opacity-30 hover:bg-gray-100 rounded" aria-label="下へ">↓</button>
                    {pendingDeleteKey === it.key ? (
                      <span className="inline-flex items-center gap-1">
                        <span className="text-xs text-gray-600">削除?</span>
                        <button onClick={() => removeAt(it.key)} className="min-h-[32px] px-2 rounded-md text-xs text-white bg-red-600">はい</button>
                        <button onClick={() => setPendingDeleteKey(null)} className="min-h-[32px] px-2 rounded-md text-xs text-gray-600 bg-gray-100">いいえ</button>
                      </span>
                    ) : (
                      <button type="button" onClick={() => setPendingDeleteKey(it.key)} className="px-2 py-1 text-xs text-red-500 hover:bg-red-50 rounded">削除</button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="mt-3 flex gap-2">
            <button type="button" onClick={addText} className="px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50">＋ テキスト吹き出しを追加</button>
            <button type="button" onClick={() => setFlexEditor({ mode: 'add' })} className="px-3 py-1.5 text-xs font-medium text-purple-700 border border-purple-300 rounded-lg hover:bg-purple-50">＋ Flex吹き出しを追加</button>
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <TestSendDialog
              accountIds={[accountId]}
              source="template_pack"
              messages={drafts.map((draft) => ({ type: draft.messageType, content: draft.messageContent }))}
              buttonLabel="テスト送信"
              disabled={saving || drafts.length === 0 || drafts.some((draft) => !draft.messageContent.trim())}
            />
            <button onClick={onBack} className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg">キャンセル</button>
            <button onClick={handleSave} disabled={saving} className="px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50" style={{ backgroundColor: '#06C755' }}>
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        </>
      )}

      {flexEditor && (
        <FlexBuilderModal initialModel={flexInitialModel()} onSave={saveFlex} onClose={() => setFlexEditor(null)} />
      )}
    </div>
  )
}
