'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Header from '@/components/layout/header'
import { useAccount } from '@/contexts/account-context'
import { formsAdvancedApi, type AdvancedForm } from '@/lib/formaloo-advanced-api'
import {
  formalooAiChatApi,
  formalooAiChatErrorMessage,
  type FormalooAiChatHistoryItem,
} from '@/lib/formaloo-ai-chat-api'

const EXAMPLES = [
  '今週の回答の傾向は？',
  'よくある困りごとは？',
  '満足度が低い回答に共通する点は？',
]

function displayTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function providerLabel(status: string | null): string {
  if (status === 'workers_ai') return 'Cloudflare AI'
  if (status === 'openai') return 'OpenAI'
  return 'AI'
}

export default function FormalooAiChatPage() {
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const [forms, setForms] = useState<AdvancedForm[]>([])
  const [selectedFormId, setSelectedFormId] = useState('')
  const [items, setItems] = useState<FormalooAiChatHistoryItem[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [question, setQuestion] = useState('')
  const [formsLoading, setFormsLoading] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const accountRef = useRef(selectedAccountId)
  const formRef = useRef(selectedFormId)
  const formsTokenRef = useRef(0)
  const formsAccountRef = useRef<string | null>(null)
  const historyTokenRef = useRef(0)
  const sendTokenRef = useRef(0)
  const sendLockRef = useRef(false)

  useEffect(() => { accountRef.current = selectedAccountId }, [selectedAccountId])
  useEffect(() => { formRef.current = selectedFormId }, [selectedFormId])

  useEffect(() => {
    const token = ++formsTokenRef.current
    formsAccountRef.current = null
    ++historyTokenRef.current
    setForms([])
    setSelectedFormId('')
    setItems([])
    setActiveId(null)
    setQuestion('')
    setError(null)

    if (accountLoading) return
    if (!selectedAccountId) {
      setFormsLoading(false)
      return
    }

    setFormsLoading(true)
    void formsAdvancedApi.list(selectedAccountId).then((loaded) => {
      if (token !== formsTokenRef.current || accountRef.current !== selectedAccountId) return
      const linked = loaded.filter((form) => Boolean(form.formalooSlug))
      formsAccountRef.current = selectedAccountId
      setForms(linked)
      setSelectedFormId(linked[0]?.id ?? '')
      setError(linked.length === 0
        ? 'AIに聞ける Formaloo 連携済みフォームがありません。先に高機能フォームを Formaloo へ保存してください'
        : null)
    }).catch(() => {
      if (token !== formsTokenRef.current || accountRef.current !== selectedAccountId) return
      setForms([])
      setError('フォーム一覧を読み込めませんでした。画面を再読み込みしてください')
    }).finally(() => {
      if (token === formsTokenRef.current) setFormsLoading(false)
    })

    return () => { formsTokenRef.current += 1 }
  }, [accountLoading, selectedAccountId])

  useEffect(() => {
    const token = ++historyTokenRef.current
    setItems([])
    setActiveId(null)
    if (
      accountLoading
      || !selectedAccountId
      || !selectedFormId
      || formsAccountRef.current !== selectedAccountId
    ) {
      setHistoryLoading(false)
      return
    }
    setHistoryLoading(true)
    setError(null)
    void formalooAiChatApi.history({
      formId: selectedFormId,
      lineAccountId: selectedAccountId,
      limit: 50,
    }).then((loaded) => {
      if (
        token !== historyTokenRef.current
        || accountRef.current !== selectedAccountId
        || formRef.current !== selectedFormId
      ) return
      setItems(loaded)
      setActiveId(loaded[0]?.id ?? null)
    }).catch((caught) => {
      if (
        token !== historyTokenRef.current
        || accountRef.current !== selectedAccountId
        || formRef.current !== selectedFormId
      ) return
      setError(formalooAiChatErrorMessage(caught))
    }).finally(() => {
      if (token === historyTokenRef.current) setHistoryLoading(false)
    })
    return () => { historyTokenRef.current += 1 }
  }, [accountLoading, selectedAccountId, selectedFormId])

  const activeItem = useMemo(
    () => items.find((item) => item.id === activeId) ?? items[0] ?? null,
    [activeId, items],
  )

  const send = useCallback(async () => {
    const prompt = question.trim()
    const accountId = selectedAccountId
    const formId = selectedFormId
    if (sendLockRef.current || !accountId || !formId || !prompt) return

    sendLockRef.current = true
    const token = ++sendTokenRef.current
    setSending(true)
    setError(null)
    try {
      const saved = await formalooAiChatApi.analyze({ formId, lineAccountId: accountId, prompt })
      if (
        token !== sendTokenRef.current
        || accountRef.current !== accountId
        || formRef.current !== formId
      ) return
      setItems((current) => [saved, ...current.filter((item) => item.id !== saved.id)])
      setActiveId(saved.id)
      setQuestion('')
    } catch (caught) {
      if (
        token === sendTokenRef.current
        && accountRef.current === accountId
        && formRef.current === formId
      ) {
        setError(formalooAiChatErrorMessage(caught))
        try {
          const loaded = await formalooAiChatApi.history({
            formId,
            lineAccountId: accountId,
            limit: 50,
          })
          if (
            token === sendTokenRef.current
            && accountRef.current === accountId
            && formRef.current === formId
          ) {
            setItems(loaded)
            setActiveId(loaded[0]?.id ?? null)
          }
        } catch {
          // Keep the primary analysis error visible; a secondary history failure must not hide it.
        }
      }
    } finally {
      if (token === sendTokenRef.current) {
        sendLockRef.current = false
        setSending(false)
      }
    }
  }, [question, selectedAccountId, selectedFormId])

  const canSend = Boolean(selectedAccountId && selectedFormId && question.trim() && !sending)

  return (
    <div className="p-4 md:p-6 max-w-7xl mx-auto">
      <Header title="AIチャット" />

      <div className="mb-5 rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-base text-gray-700">
        フォームの回答について、いつもの言葉で質問できます。まずフォームを選び、例文を押して試してください。
      </div>

      {!accountLoading && !selectedAccountId && (
        <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-base text-amber-900">
          先に左のメニューでLINEアカウントを選んでください
        </div>
      )}

      {error && (
        <div role="alert" className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-base text-red-800">
          {error}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <label htmlFor="ai-chat-form" className="mb-2 block text-base font-semibold text-gray-900">
            どのフォームについて聞きますか？
          </label>
          <select
            id="ai-chat-form"
            aria-label="分析するフォーム"
            value={selectedFormId}
            onChange={(event) => setSelectedFormId(event.target.value)}
            disabled={formsLoading || sending || forms.length === 0}
            className="min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 text-base text-gray-900 disabled:bg-gray-100"
          >
            {forms.length === 0 && <option value="">{formsLoading ? '読み込み中…' : '選べるフォームがありません'}</option>}
            {forms.map((form) => <option key={form.id} value={form.id}>{form.title}</option>)}
          </select>

          <h2 className="mb-2 mt-6 text-base font-semibold text-gray-900">これまでの質問</h2>
          {historyLoading && <p className="text-sm text-gray-500">履歴を読み込んでいます…</p>}
          {!historyLoading && items.length === 0 && (
            <p className="rounded-lg bg-gray-50 p-3 text-sm leading-6 text-gray-600">まだ質問はありません。</p>
          )}
          <div className="space-y-2">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveId(item.id)}
                aria-pressed={activeItem?.id === item.id}
                className={`min-h-11 w-full rounded-lg border px-3 py-2 text-left text-sm ${
                  activeItem?.id === item.id
                    ? 'border-green-500 bg-green-50 text-green-900'
                    : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50'
                }`}
              >
                <span className="block truncate font-medium">{item.question}</span>
                <span className="mt-1 block text-xs text-gray-500">{displayTime(item.createdAt)}</span>
              </button>
            ))}
          </div>
        </aside>

        <section aria-label="AIチャットの会話" className="flex min-h-[560px] flex-col rounded-xl border border-gray-200 bg-white shadow-sm">
          <div aria-live="polite" aria-busy={sending} className="flex-1 space-y-5 overflow-y-auto p-4 md:p-6">
            {!activeItem && !sending && (
              <div className="mx-auto mt-12 max-w-lg text-center text-base leading-7 text-gray-600">
                聞きたいことを下の欄に入力してください。むずかしい言葉でなくて大丈夫です。
              </div>
            )}
            {activeItem && (
              <>
                <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-[#06C755] px-4 py-3 text-base leading-7 text-white shadow-sm">
                  <p className="whitespace-pre-wrap">{activeItem.question}</p>
                </div>
                <div className="mr-auto max-w-[90%] rounded-2xl rounded-bl-sm border border-gray-200 bg-gray-50 px-4 py-3 text-base leading-7 text-gray-800">
                  <p className="mb-1 text-xs font-semibold text-green-700">
                    {providerLabel(activeItem.providerStatus)}
                  </p>
                  <p className="whitespace-pre-wrap">
                    {activeItem.status === 'completed'
                      ? activeItem.answerText
                      : activeItem.status === 'failed'
                        ? activeItem.errorMessage || '分析を完了できませんでした'
                        : '分析しています…'}
                  </p>
                  {activeItem.creditsConsumed && (
                    <p className="mt-2 text-xs text-gray-500">本日のAI利用枠を使用</p>
                  )}
                </div>
              </>
            )}
            {sending && (
              <div role="status" className="mr-auto rounded-2xl rounded-bl-sm border border-green-200 bg-green-50 px-4 py-3 text-base text-green-800">
                分析しています…
              </div>
            )}
          </div>

          <div className="border-t border-gray-200 p-4 md:p-5">
            <p className="mb-2 text-sm font-medium text-gray-700">質問の例</p>
            <div className="mb-4 flex flex-wrap gap-2">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setQuestion(example)}
                  disabled={!selectedFormId || sending}
                  className="min-h-11 rounded-full border border-green-300 bg-white px-4 text-sm text-green-800 hover:bg-green-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {example}
                </button>
              ))}
            </div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <textarea
                aria-label="AIへの質問"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    void send()
                  }
                }}
                disabled={!selectedFormId || sending}
                maxLength={2000}
                rows={3}
                placeholder="例：今週の回答の傾向は？"
                className="min-h-24 flex-1 resize-y rounded-xl border border-gray-300 px-4 py-3 text-base leading-7 text-gray-900 focus:border-green-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-green-500 disabled:bg-gray-100"
              />
              <button
                type="button"
                onClick={() => void send()}
                disabled={!canSend}
                className="min-h-11 rounded-xl bg-[#06C755] px-6 text-base font-semibold text-white hover:bg-green-600 disabled:cursor-not-allowed disabled:bg-gray-300"
              >
                {sending ? '分析中…' : 'AIに聞く'}
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}
