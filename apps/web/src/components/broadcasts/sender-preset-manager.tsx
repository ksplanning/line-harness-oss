'use client'

import { useEffect, useState } from 'react'
import { api, type SenderPresetItem } from '@/lib/api'
import { validateSenderPresetInput } from '@/lib/sender-preset'
import ImageUploader from '@/components/shared/image-uploader'

/** 送信者プリセットの最小 CRUD (G25・account 設定側)。名前 + アイコン画像URL の登録/編集/削除。
 *  account-scoped (選択中 account のみ)。削除は行内確認 (window.confirm 不使用)。値検証は server が正典。 */
export default function SenderPresetManager({
  accountId,
  onClose,
}: {
  accountId: string | null
  onClose: () => void
}) {
  const [presets, setPresets] = useState<SenderPresetItem[]>([])
  const [name, setName] = useState('')
  const [iconUrl, setIconUrl] = useState('')
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editIcon, setEditIcon] = useState('')

  const load = () => {
    if (!accountId) {
      setPresets([])
      return
    }
    api.senderPresets.list(accountId).then((r) => { if (r.success) setPresets(r.data) }).catch(() => {})
  }
  // account 切替で一覧をリセット + 再取得 (別 account のプリセットを残さない)。
  useEffect(() => {
    setConfirmDelete(null)
    setEditing(null)
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId])

  const add = async () => {
    if (!accountId) return
    const err = validateSenderPresetInput(name, iconUrl)
    if (err) { setError(err); return }
    setError('')
    const res = await api.senderPresets.create(accountId, { name: name.trim(), iconUrl: iconUrl || null })
    if (res.success) { setName(''); setIconUrl(''); load() } else setError(res.error)
  }

  const saveEdit = async (id: string) => {
    if (!accountId) return
    const err = validateSenderPresetInput(editName, editIcon)
    if (err) { setError(err); return }
    setError('')
    const res = await api.senderPresets.update(id, accountId, { name: editName.trim(), iconUrl: editIcon || null })
    if (res.success) { setEditing(null); load() } else setError(res.error)
  }

  const remove = async (id: string) => {
    if (!accountId) return
    const res = await api.senderPresets.remove(id, accountId)
    if (res.success) { setConfirmDelete(null); load() } else setError(res.error)
  }

  const inputCls = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500'

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-gray-800">送信者の管理</h2>
        <button onClick={onClose} className="text-xs text-gray-500 hover:text-gray-700 min-h-[36px]">閉じる</button>
      </div>
      <p className="text-xs text-gray-500 mb-4">
        ここで登録した送信者（名前・アイコン）を、配信作成時に選べます。配信では登録済みの送信者からのみ選べます（なりすまし防止）。
      </p>

      {/* 一覧 */}
      <div className="space-y-2 mb-5">
        {presets.length === 0 && <p className="text-xs text-gray-400">まだ送信者が登録されていません。</p>}
        {presets.map((p) => (
          <div key={p.id} className="flex items-center gap-3 border border-gray-200 rounded-lg p-2">
            {p.iconUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={p.iconUrl} alt="" className="w-8 h-8 rounded-full object-cover border border-gray-200" />
            ) : (
              <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-xs text-gray-500">{p.name.slice(0, 1)}</div>
            )}
            {editing === p.id ? (
              <div className="flex-1 space-y-1">
                <input className={inputCls} value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="送信者の名前（20文字以内）" />
                <input className={inputCls} value={editIcon} onChange={(e) => setEditIcon(e.target.value)} placeholder="アイコン画像URL (https://...)" />
                <div className="flex gap-2">
                  <button onClick={() => saveEdit(p.id)} className="px-3 py-1.5 min-h-[36px] text-xs font-medium text-white rounded-md" style={{ backgroundColor: '#06C755' }}>保存</button>
                  <button onClick={() => setEditing(null)} className="px-3 py-1.5 min-h-[36px] text-xs font-medium text-gray-600 bg-gray-100 rounded-md">キャンセル</button>
                </div>
              </div>
            ) : (
              <>
                <span className="flex-1 text-sm text-gray-800">{p.name}</span>
                {confirmDelete === p.id ? (
                  <span className="flex items-center gap-1 text-xs text-gray-600">
                    消す?
                    <button onClick={() => remove(p.id)} className="px-2 py-1 min-h-[32px] text-white bg-red-600 rounded-md">はい</button>
                    <button onClick={() => setConfirmDelete(null)} className="px-2 py-1 min-h-[32px] text-gray-600 bg-gray-100 rounded-md">いいえ</button>
                  </span>
                ) : (
                  <>
                    <button onClick={() => { setEditing(p.id); setEditName(p.name); setEditIcon(p.iconUrl ?? ''); }} className="text-xs text-green-700 hover:underline min-h-[32px] px-1">編集</button>
                    <button onClick={() => setConfirmDelete(p.id)} className="text-xs text-gray-500 hover:text-red-600 min-h-[32px] px-1">削除</button>
                  </>
                )}
              </>
            )}
          </div>
        ))}
      </div>

      {/* 新規登録 */}
      <div className="border-t border-gray-100 pt-4 space-y-2">
        <p className="text-xs font-medium text-gray-600">送信者を追加</p>
        <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="送信者の名前（20文字以内）" />
        <ImageUploader
          mode="line-image"
          value={iconUrl ? { mode: 'line-image' as const, originalContentUrl: iconUrl, previewImageUrl: iconUrl } : null}
          onChange={(v) => setIconUrl(v?.mode === 'line-image' ? v.originalContentUrl : '')}
          label="アイコン画像（アップロード・任意）"
        />
        <input className={inputCls} value={iconUrl} onChange={(e) => setIconUrl(e.target.value)} placeholder="またはアイコン画像URL (https://...)" />
        {error && <p className="text-xs text-red-600">{error}</p>}
        <button onClick={add} disabled={!accountId} className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50" style={{ backgroundColor: '#06C755' }}>
          追加
        </button>
      </div>
    </div>
  )
}
