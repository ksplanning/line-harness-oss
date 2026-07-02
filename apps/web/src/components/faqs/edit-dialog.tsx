'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

export interface FaqDraft {
  id?: string
  question: string
  variants: string[]
  answer: string
  lineAccountId: string | null
  isActive: boolean
  unmatchedId?: string
}

interface Props {
  draft: FaqDraft
  selectedAccountId: string | null
  onClose: () => void
  onSaved: () => void
}

export default function EditDialog({ draft, selectedAccountId, onClose, onSaved }: Props) {
  const [question, setQuestion] = useState(draft.question)
  const [variants, setVariants] = useState<string[]>(draft.variants)
  const [variantInput, setVariantInput] = useState('')
  const [answer, setAnswer] = useState(draft.answer)
  const [isActive, setIsActive] = useState(draft.isActive)
  const [advancedOpen, setAdvancedOpen] = useState(draft.lineAccountId === null)
  const [global, setGlobal] = useState(draft.lineAccountId === null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // 入力があれば「破棄しますか？」で確認してから閉じる。
  // 何も変えていなければ確認なしでそのまま閉じる（空なら即閉じ）。
  const isDirty =
    question !== draft.question ||
    answer !== draft.answer ||
    isActive !== draft.isActive ||
    global !== (draft.lineAccountId === null) ||
    variantInput.trim() !== '' ||
    variants.length !== draft.variants.length ||
    variants.some((v, i) => v !== draft.variants[i])

  const requestClose = () => {
    if (saving) return
    if (isDirty && !window.confirm('入力内容を破棄しますか？')) return
    onClose()
  }

  // Esc キーでも閉じられるように（破棄確認は requestClose 側で行う）。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
    // requestClose は毎レンダー再生成されるが、常に最新の dirty 状態を参照させたいので依存に含める。
  }, [requestClose])

  const addVariant = (raw: string) => {
    const values = raw
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
    if (values.length === 0) return
    setVariants((prev) => [...prev, ...values.filter((v) => !prev.includes(v))])
    setVariantInput('')
  }

  const handleSave = async () => {
    if (!question.trim()) { setError('お客さまの質問を入力してください'); return }
    if (!answer.trim()) { setError('答えを入力してください'); return }
    setError('')
    setSaving(true)
    try {
      const body = {
        question: question.trim(),
        variants,
        answer: answer.trim(),
        lineAccountId: global ? null : (draft.lineAccountId ?? selectedAccountId),
        isActive,
      }
      if (draft.unmatchedId) {
        await api.faqs.createFromUnmatched(draft.unmatchedId, body)
      } else if (draft.id) {
        await api.faqs.update(draft.id, body)
      } else {
        await api.faqs.create(body)
      }
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h3 className="text-base font-semibold text-gray-900">
            {draft.id ? '質問を編集' : draft.unmatchedId ? '答えられなかった質問を登録' : '質問を追加'}
          </h3>
          <button
            type="button"
            onClick={requestClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
            aria-label="閉じる"
          >
            ×
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-xs text-gray-600 mb-1">お客さまの質問（代表）</label>
            <input
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              placeholder="例: 営業時間は何時からですか？"
            />
          </div>

          <div>
            <label className="block text-xs text-gray-600 mb-1">言い換え</label>
            <div className="min-h-[42px] flex flex-wrap items-center gap-1.5 border border-gray-300 rounded-md px-2 py-1.5 focus-within:ring-2 focus-within:ring-green-500">
              {variants.map((variant) => (
                <span key={variant} className="inline-flex items-center gap-1 bg-gray-100 text-gray-600 rounded px-1.5 py-0.5 text-[10px]">
                  {variant}
                  <button
                    type="button"
                    onClick={() => setVariants((prev) => prev.filter((v) => v !== variant))}
                    className="text-gray-400 hover:text-gray-700"
                    aria-label={`${variant}を削除`}
                  >
                    x
                  </button>
                </span>
              ))}
              <input
                value={variantInput}
                onChange={(e) => setVariantInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault()
                    addVariant(variantInput)
                  }
                }}
                onBlur={() => addVariant(variantInput)}
                className="flex-1 min-w-[160px] border-0 outline-none text-sm py-1"
                placeholder="何時から、開店時間"
              />
            </div>
            <p className="mt-1 text-[11px] text-gray-500">
              「何時から」「開店時間」など、言い方が違っても同じ質問として拾えます。空でもOK。
            </p>
          </div>

          <div>
            <label className="block text-xs text-gray-600 mb-1">答え</label>
            <textarea
              rows={4}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-y"
              placeholder="例: 平日は10時〜19時、土日は11時〜18時です。"
            />
          </div>

          <label className="inline-flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
            />
            <span className="text-xs text-gray-600">この質問を有効にする</span>
          </label>

          <div>
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              className="text-xs text-gray-500 hover:text-gray-700"
            >
              {advancedOpen ? '▾' : '▸'} このアカウント以外でも使う（上級者向け）
            </button>
            {advancedOpen && (
              <label className="mt-2 inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={global}
                  onChange={(e) => setGlobal(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
                />
                <span className="text-xs text-gray-600">全アカ共通にする</span>
              </label>
            )}
          </div>

          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>
        <div className="sticky bottom-0 px-5 py-3 border-t bg-white flex gap-2 justify-end">
          <button onClick={requestClose} className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md">キャンセル</button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-3 py-1.5 text-xs font-medium text-white rounded-md disabled:opacity-50"
            style={{ backgroundColor: '#06C755' }}
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  )
}
