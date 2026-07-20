'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import Header from '@/components/layout/header'
import Toggle from '@/components/shared/toggle'
import EditDialog, { type FaqDraft } from '@/components/faqs/edit-dialog'
import BulkImportDialog from '@/components/faqs/bulk-import-dialog'
import PersonalizedTextEditor from '@/components/shared/personalized-text-editor'
import type { FriendFieldDefinition } from '@line-crm/shared'

interface Faq {
  id: string
  lineAccountId: string | null
  question: string
  variants: string[]
  answer: string
  isActive: boolean
  hitCount: number
  createdAt: string
  updatedAt: string
}

interface Unmatched {
  id: string
  lineAccountId: string | null
  friendId: string | null
  question: string
  topScore: number | null
  resolvedFaqId: string | null
  createdAt: string
}

interface FaqBotSettings {
  enabled: boolean
  threshold: number
  handoffMessage: string
  autoReplyNotice: string
  maxRepliesPerDay: number
  // 'draft'=AIは草案を作るだけで送信しない / 'auto'=お客さまへ自動送信。
  answerMode: 'draft' | 'auto'
  personalContext: {
    enabled: boolean
    /** null=有効な全項目、[]=対象なし。 */
    selectedCustomFieldIds: string[] | null
    includeFormAnswers: boolean
    maxTokens: number
  }
}

const DEFAULT_SETTINGS: FaqBotSettings = {
  enabled: false,
  threshold: 0.6,
  handoffMessage: '',
  autoReplyNotice: '',
  maxRepliesPerDay: 5,
  // 安全側の既定。未取得状態で誤って自動送信化しないよう 'draft' 始点
  // (実値は GET 応答で上書きされる — settings.get の answerMode をそのまま保持)。
  answerMode: 'draft',
  personalContext: {
    enabled: true,
    selectedCustomFieldIds: null,
    includeFormAnswers: true,
    maxTokens: 1200,
  },
}

type Tab = 'faqs' | 'unmatched' | 'settings'

function thresholdLabel(pct: number): string {
  if (pct < 40) return 'ゆるめ寄り（拾いやすいですが、間違えやすくなります）'
  if (pct < 70) return 'ふつう（似ている質問に答えます）'
  return 'きびしめ寄り（似ている質問だけ答えます）'
}

function formatDateTime(iso: string): string {
  // '2026-07-02T18:00:00.000+09:00' -> '2026-07-02 18:00'
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/)
  return m ? `${m[1]} ${m[2]}` : iso.slice(0, 16)
}

export default function FaqsPage() {
  const { selectedAccountId, accounts } = useAccount()
  const [tab, setTab] = useState<Tab>('faqs')

  const [faqs, setFaqs] = useState<Faq[]>([])
  const [unmatched, setUnmatched] = useState<Unmatched[]>([])
  const [settings, setSettings] = useState<FaqBotSettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<FaqDraft | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [fieldDefinitions, setFieldDefinitions] = useState<FriendFieldDefinition[]>([])
  // 「自動で送信する」に切り替える時だけ出す行内確認 (native window.confirm は使わない / M-16)。
  const [confirmAutoMode, setConfirmAutoMode] = useState(false)

  const accountName =
    accounts.find((a) => a.id === selectedAccountId)?.displayName ??
    accounts.find((a) => a.id === selectedAccountId)?.name ??
    '（アカウント未選択）'

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    // account 切替時に前アカウントの「自動送信にしますか？」確認を残さない
    // (パネル残存 → 別アカウントを誤って auto 化する cross-account 事故の防止)。
    setConfirmAutoMode(false)
    try {
      const accountId = selectedAccountId || undefined
      const fieldDefinitionsRequest = api.friendFieldDefinitions?.list?.()
      const [faqRes, unmatchedRes, fieldDefinitionsRes] = await Promise.all([
        api.faqs.list({ accountId }),
        api.faqs.unmatched({ accountId }),
        fieldDefinitionsRequest ?? Promise.resolve(null),
      ])
      if (faqRes.success) setFaqs(faqRes.data)
      if (unmatchedRes.success) setUnmatched(unmatchedRes.data)
      if (fieldDefinitionsRes?.success) setFieldDefinitions(fieldDefinitionsRes.data)
      else setFieldDefinitions([])
      if (selectedAccountId) {
        const setRes = await api.faqs.settings.get({ accountId: selectedAccountId })
        if (setRes.success) {
          setSettings({
            ...DEFAULT_SETTINGS,
            ...setRes.data,
            personalContext: {
              ...DEFAULT_SETTINGS.personalContext,
              ...setRes.data.personalContext,
            },
          })
        }
      } else {
        setSettings(DEFAULT_SETTINGS)
      }
    } catch {
      setError('読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [selectedAccountId])

  useEffect(() => { load() }, [load])

  const unresolvedCount = unmatched.filter((u) => !u.resolvedFaqId).length

  const handleDelete = async (id: string) => {
    if (!confirm('この質問を削除しますか？')) return
    try {
      await api.faqs.delete(id)
      load()
    } catch {
      setError('削除に失敗しました')
    }
  }

  const openNewFaq = () => setEditing({
    question: '',
    variants: [],
    answer: '',
    lineAccountId: selectedAccountId,
    isActive: true,
  })

  const openFromUnmatched = (u: Unmatched) => setEditing({
    question: u.question,
    variants: [],
    answer: '',
    lineAccountId: selectedAccountId,
    isActive: true,
    unmatchedId: u.id,
  })

  const handleToggleSettings = () => {
    if (!settings.enabled) {
      if (!confirm('自動応答をONにすると、これ以降のお客さまの質問に自動で答え始めます。よろしいですか？')) return
      setSettings((s) => ({ ...s, enabled: true }))
    } else {
      // OFF is the safe direction — no confirmation.
      setSettings((s) => ({ ...s, enabled: false }))
    }
  }

  const selectAnswerMode = (mode: 'draft' | 'auto') => {
    if (mode === 'auto') {
      if (settings.answerMode === 'auto') return
      // 自動送信化は危険方向 → 行内確認を挟む (この時点では state を変えない)。
      setConfirmAutoMode(true)
    } else {
      // 下書きは安全方向 → 確認なしで即切替。
      setConfirmAutoMode(false)
      setSettings((s) => ({ ...s, answerMode: 'draft' }))
    }
  }

  const confirmSwitchToAuto = () => {
    setSettings((s) => ({ ...s, answerMode: 'auto' }))
    setConfirmAutoMode(false)
  }

  const saveSettings = async () => {
    if (!selectedAccountId) { setError('LINEアカウントを選択してください'); return }
    setError('')
    setNotice('')
    setSavingSettings(true)
    try {
      await api.faqs.settings.put({ accountId: selectedAccountId, ...settings })
      setNotice('保存しました')
    } catch {
      setError('保存に失敗しました')
    } finally {
      setSavingSettings(false)
    }
  }

  const thresholdPct = Math.round(settings.threshold * 100)
  const activeFieldDefinitions = fieldDefinitions.filter((definition) => definition.isActive)

  const updatePersonalContext = (patch: Partial<FaqBotSettings['personalContext']>) => {
    setSettings((current) => ({
      ...current,
      personalContext: { ...current.personalContext, ...patch },
    }))
  }

  const toggleCustomField = (fieldId: string) => {
    const activeIds = activeFieldDefinitions.map((definition) => definition.id)
    const selected = settings.personalContext.selectedCustomFieldIds === null
      ? activeIds
      : settings.personalContext.selectedCustomFieldIds.filter((id) => activeIds.includes(id))
    const next = selected.includes(fieldId)
      ? selected.filter((id) => id !== fieldId)
      : [...selected, fieldId]
    updatePersonalContext({
      selectedCustomFieldIds: activeIds.length > 0 && next.length === activeIds.length ? null : next,
    })
  }

  return (
    <div>
      <Header
        title="よくある質問（自動応答）"
        description="お客さまがLINEで送ってきた質問に、あらかじめ登録した答えを自動で返します。"
        action={
          <div className="flex items-center gap-2">
            {tab === 'faqs' && (
              <button
                onClick={() => setBulkOpen(true)}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                まとめて登録
              </button>
            )}
            <button
              onClick={openNewFaq}
              className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
              style={{ backgroundColor: '#06C755' }}
            >
              + 質問を追加
            </button>
          </div>
        }
      />

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* タブ (ピル型) */}
      <div className="mb-4 inline-flex bg-gray-100 rounded-lg p-1 w-fit">
        {([
          { key: 'faqs', label: 'よくある質問' },
          { key: 'unmatched', label: '答えられなかった質問' },
          { key: 'settings', label: '設定' },
        ] as const).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`min-h-[44px] px-4 rounded-md text-sm font-medium transition-colors inline-flex items-center gap-2 ${
              tab === key ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {label}
            {key === 'unmatched' && unresolvedCount > 0 && (
              <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 bg-rose-500 text-white rounded-full text-[10px] font-semibold">
                {unresolvedCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── よくある質問 一覧 ── */}
      {tab === 'faqs' && (
        loading ? (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 px-4 py-8 text-center text-gray-400 text-sm">読み込み中...</div>
        ) : faqs.length === 0 ? (
          <div className="bg-white border border-gray-200 rounded-lg p-8 text-center">
            <svg className="mx-auto h-12 w-12 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <h3 className="mt-4 text-lg font-semibold text-gray-800">まだ「よくある質問」がありません</h3>
            <p className="mt-2 text-sm text-gray-500 leading-relaxed">
              お客さまがよく聞くこと（営業時間・場所・料金など）を登録すると、<br />
              LINEで質問がきたときに自動で答えられるようになります。<br />
              まずは1つ、いちばん多い質問から登録してみましょう。
            </p>
            <button
              onClick={openNewFaq}
              className="mt-5 px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
              style={{ backgroundColor: '#06C755' }}
            >
              ＋ 最初の質問を追加
            </button>
            <p className="mt-3 text-xs text-gray-500">
              エクセルやCSVでまとめて用意した質問がある場合は
              <button onClick={() => setBulkOpen(true)} className="text-gray-600 hover:text-gray-800 underline">まとめて登録</button>
            </p>
            <p className="mt-4 text-xs text-gray-400">
              答え方の設定（自信のしきい値など）は「設定」タブから
            </p>
          </div>
        ) : (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px]">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">質問</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">言い換え</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">回答</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">使われた回数</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">対象アカウント</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">状態</th>
                    <th className="px-4 py-3 sticky right-0 z-10 bg-gray-50 border-l border-gray-200" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {faqs.map((f) => (
                    <tr key={f.id} className="group hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">{f.question}</td>
                      <td className="px-4 py-3">
                        {f.variants.length === 0 ? (
                          <span className="text-gray-400 text-xs">—</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {f.variants.slice(0, 3).map((v) => (
                              <span key={v} className="bg-gray-100 text-gray-600 text-[10px] rounded px-1.5 py-0.5">{v}</span>
                            ))}
                            {f.variants.length > 3 && (
                              <span className="text-gray-400 text-[10px]">+{f.variants.length - 3}</span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className="block truncate max-w-[280px] text-xs text-gray-600" title={f.answer}>{f.answer}</span>
                      </td>
                      <td className={`px-4 py-3 text-sm tabular-nums ${f.hitCount === 0 ? 'text-gray-400' : 'text-gray-700'}`}>
                        {f.hitCount}
                      </td>
                      <td className="px-4 py-3">
                        {f.lineAccountId === null ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-100 text-blue-700">全アカ共通</span>
                        ) : (
                          <span className="text-xs text-gray-700">
                            {accounts.find((a) => a.id === f.lineAccountId)?.displayName ??
                              accounts.find((a) => a.id === f.lineAccountId)?.name ??
                              f.lineAccountId.slice(0, 8)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${f.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                          {f.isActive ? '有効' : '無効'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right whitespace-nowrap sticky right-0 z-10 bg-white group-hover:bg-gray-50 border-l border-gray-100">
                        <button
                          onClick={() => setEditing({
                            id: f.id,
                            question: f.question,
                            variants: f.variants,
                            answer: f.answer,
                            lineAccountId: f.lineAccountId,
                            isActive: f.isActive,
                          })}
                          className="px-2.5 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 rounded-md"
                        >
                          編集
                        </button>
                        <button
                          onClick={() => handleDelete(f.id)}
                          className="ml-1 px-2.5 py-1 text-xs font-medium text-red-500 hover:bg-red-50 rounded-md"
                        >
                          削除
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      )}

      {/* ── 答えられなかった質問 ── */}
      {tab === 'unmatched' && (
        <div>
          <div className="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-800 leading-relaxed">
            自動で答えられなかった質問がここに溜まります。「これはよくある質問だ」と思ったら
            <span className="font-semibold">［＋ 質問にする］</span>を押すと、その文章がそのまま新しい質問の下書きになります。
            答えを書いて保存すれば、次からは自動で返せます。
          </div>
          {loading ? (
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 px-4 py-8 text-center text-gray-400 text-sm">読み込み中...</div>
          ) : unmatched.filter((u) => !u.resolvedFaqId).length === 0 ? (
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 px-4 py-8 text-center text-gray-400 text-sm">
              いまのところ、答えられなかった質問はありません。
            </div>
          ) : (
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px]">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">お客さまが送った質問</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">いつ</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">惜しさ</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {unmatched.filter((u) => !u.resolvedFaqId).map((u) => (
                      <tr key={u.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm font-medium text-gray-900">
                          <span className="block truncate max-w-[360px]" title={u.question}>{u.question}</span>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{formatDateTime(u.createdAt)}</td>
                        <td className="px-4 py-3">
                          {u.topScore !== null && u.topScore >= 0.4 ? (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 text-amber-700" title={`スコア ${u.topScore.toFixed(2)}`}>
                              もう少しで拾えた
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-500" title={u.topScore !== null ? `スコア ${u.topScore.toFixed(2)}` : 'スコアなし'}>
                              似た質問が未登録
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          <button
                            onClick={() => openFromUnmatched(u)}
                            className="px-3 py-1.5 text-xs font-medium text-white rounded-md transition-opacity hover:opacity-90"
                            style={{ backgroundColor: '#06C755' }}
                          >
                            ＋ 質問にする
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── 設定 ── */}
      {tab === 'settings' && (
        <div className="space-y-4 max-w-2xl">
          <p className="text-xs text-gray-500">いま設定中: {accountName}</p>

          {notice && (
            <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">{notice}</div>
          )}

          {/* ① ON/OFF */}
          <div className="bg-white border border-gray-200 rounded-lg p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-800">この LINE アカウントで自動応答を使う</h3>
              <Toggle value={settings.enabled} onClick={handleToggleSettings} />
            </div>
            {!settings.enabled ? (
              <p className="mt-2 text-xs text-gray-500">いまはOFFです。ONにすると、お客さまの質問に自動で答え始めます。</p>
            ) : (
              <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
                ※ 全体スイッチ（管理者設定）もONのときだけ実際に返信されます。
              </div>
            )}
          </div>

          {/* 回答モード (下書き / 自動送信) */}
          <div className="bg-white border border-gray-200 rounded-lg p-5">
            <h3 className="text-sm font-semibold text-gray-800">AIの答えをどうする？</h3>
            <div className="mt-3 inline-flex bg-gray-100 rounded-lg p-1 w-fit">
              {([
                { key: 'draft', label: '下書きにする' },
                { key: 'auto', label: '自動で送信する' },
              ] as const).map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => selectAnswerMode(key)}
                  className={`min-h-[44px] px-4 rounded-md text-sm font-medium transition-colors ${
                    settings.answerMode === key ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {settings.answerMode === 'draft' ? (
              <p className="mt-3 text-xs text-gray-600 bg-gray-50 rounded-md px-3 py-2 leading-relaxed">
                いまは<span className="font-semibold">下書き</span>です。AIは答えの草案を作るだけで、お客さまには送信しません。草案は「資料・AIログ」画面で確認できます。
              </p>
            ) : (
              <p className="mt-3 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2 leading-relaxed">
                いまは<span className="font-semibold">自動送信</span>です。AIがお客さまに自動で返信します。
              </p>
            )}

            {confirmAutoMode && (
              <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <p className="text-xs text-amber-800 leading-relaxed">
                  自動送信にすると、これ以降お客さまの質問にAIが実際に返信します。よろしいですか？
                </p>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={confirmSwitchToAuto}
                    className="px-3 py-1.5 text-xs font-medium text-white bg-amber-600 rounded-md hover:bg-amber-700"
                  >
                    自動送信にする
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmAutoMode(false)}
                    className="px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-md"
                  >
                    やめる
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* 質問者本人の登録情報 */}
          <div className="bg-white border border-gray-200 rounded-lg p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-gray-800">質問者本人の登録情報を答えに使う</h3>
                <p className="mt-1 text-xs text-gray-500 leading-relaxed">
                  表示名・選んだカスタム項目・過去のフォーム回答を、その人への回答だけに使います。他の人の情報は検索しません。
                </p>
              </div>
              <input
                type="checkbox"
                aria-label="本人情報を回答に使う"
                checked={settings.personalContext.enabled}
                onChange={(event) => updatePersonalContext({ enabled: event.target.checked })}
                className="mt-1 h-5 w-5 shrink-0 accent-green-500"
              />
            </div>

            <fieldset
              disabled={!settings.personalContext.enabled}
              className="mt-4 space-y-4 disabled:opacity-50"
            >
              <div>
                <p className="text-xs font-medium text-gray-700">使うカスタム項目</p>
                <label className="mt-2 flex min-h-[36px] items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    aria-label="すべてのカスタム項目"
                    checked={settings.personalContext.selectedCustomFieldIds === null}
                    onChange={() => updatePersonalContext({
                      selectedCustomFieldIds: settings.personalContext.selectedCustomFieldIds === null ? [] : null,
                    })}
                    className="h-4 w-4 accent-green-500"
                  />
                  すべてのカスタム項目
                </label>
                {activeFieldDefinitions.length === 0 ? (
                  <p className="mt-2 text-xs text-gray-400">有効なカスタム項目はありません。</p>
                ) : (
                  <div className="mt-1 grid gap-1 sm:grid-cols-2">
                    {activeFieldDefinitions.map((definition) => (
                      <label key={definition.id} className="flex min-h-[36px] items-center gap-2 text-sm text-gray-700">
                        <input
                          type="checkbox"
                          aria-label={definition.name}
                          checked={
                            settings.personalContext.selectedCustomFieldIds === null
                            || settings.personalContext.selectedCustomFieldIds.includes(definition.id)
                          }
                          onChange={() => toggleCustomField(definition.id)}
                          className="h-4 w-4 accent-green-500"
                        />
                        {definition.name}
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <label className="flex min-h-[36px] items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  aria-label="過去のフォーム回答を含める"
                  checked={settings.personalContext.includeFormAnswers}
                  onChange={(event) => updatePersonalContext({ includeFormAnswers: event.target.checked })}
                  className="h-4 w-4 accent-green-500"
                />
                過去のフォーム回答を含める（直近3件の要旨）
              </label>

              <div>
                <label htmlFor="faq-personal-context-max-tokens" className="block text-xs font-medium text-gray-700">
                  本人情報の最大トークン数
                </label>
                <input
                  id="faq-personal-context-max-tokens"
                  aria-label="本人情報の最大トークン数"
                  type="number"
                  min={128}
                  max={2000}
                  value={settings.personalContext.maxTokens}
                  onChange={(event) => updatePersonalContext({
                    maxTokens: Math.max(128, Math.min(2000, Number(event.target.value) || 128)),
                  })}
                  className="mt-2 w-32 border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                />
                <p className="mt-1 text-[11px] text-gray-500">
                  本人情報を一度に渡しすぎないための上限です（128〜2000）。
                </p>
              </div>
            </fieldset>
          </div>

          {/* ② しきい値 */}
          <div className="bg-white border border-gray-200 rounded-lg p-5">
            <h3 className="text-sm font-semibold text-gray-800">どれくらい似ていたら自動で答える？</h3>
            <input
              type="range"
              min={0}
              max={100}
              value={thresholdPct}
              onChange={(e) => setSettings((s) => ({ ...s, threshold: Number(e.target.value) / 100 }))}
              className="mt-4 w-full accent-green-500"
            />
            <div className="flex justify-between text-[10px] text-gray-400 mt-1">
              <span>ゆるめ（拾いやすいが間違えやすい）</span>
              <span>きびしめ（間違えにくいが拾いにくい）</span>
            </div>
            <p className="mt-2 text-xs text-gray-600">いまの設定: {thresholdLabel(thresholdPct)}</p>
            <p className="mt-3 text-xs text-gray-500 bg-gray-50 rounded-md px-3 py-2">
              自信がないときは自動で答えず、担当者に引き継ぎます。まちがった答えは返しません。
            </p>
          </div>

          {/* ③ 引き継ぎメッセージ */}
          <div className="bg-white border border-gray-200 rounded-lg p-5">
            <h3 className="text-sm font-semibold text-gray-800">自動で答えられないときに送る文</h3>
            <PersonalizedTextEditor
              mode="emoji-only"
              ariaLabel="引き継ぎメッセージ"
              rows={3}
              value={settings.handoffMessage}
              onChange={(handoffMessage) => setSettings((s) => ({ ...s, handoffMessage }))}
              className="mt-2 w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-y"
              placeholder="例: お問い合わせありがとうございます。担当者より順次ご返信いたします。少々お待ちください。"
            />
            <p className="mt-1 text-[11px] text-gray-500">
              自動で答えられなかったとき、この文をお客さまに送って、あとで担当者が対応します。（この会話は「未対応」に入ります）
            </p>
          </div>

          {/* ④ 明記文 */}
          <div className="bg-white border border-gray-200 rounded-lg p-5">
            <h3 className="text-sm font-semibold text-gray-800">答えの最後に付ける「自動応答です」の一文</h3>
            <PersonalizedTextEditor
              mode="emoji-only"
              multiline={false}
              ariaLabel="自動応答の明記文"
              value={settings.autoReplyNotice}
              onChange={(autoReplyNotice) => setSettings((s) => ({ ...s, autoReplyNotice }))}
              className="mt-2 w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              placeholder="例: ※この返信は自動応答です"
            />
            <p className="mt-1 text-[11px] text-gray-500">
              付けておくと、お客さまが「自動で返ってきた」と分かって安心します。空にすると付けません。
            </p>
          </div>

          {/* ⑤ 上限 */}
          <div className="bg-white border border-gray-200 rounded-lg p-5">
            <h3 className="text-sm font-semibold text-gray-800">同じ人への自動返信は1日何回まで？</h3>
            <input
              type="number"
              min={1}
              value={settings.maxRepliesPerDay}
              onChange={(e) => setSettings((s) => ({ ...s, maxRepliesPerDay: Math.max(1, Number(e.target.value) || 1) }))}
              className="mt-2 w-32 border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            <p className="mt-1 text-[11px] text-gray-500">
              多すぎる自動返信を防ぎます。上限を超えたら自動では答えず、担当者に引き継ぎます。
            </p>
          </div>

          <div className="flex justify-end">
            <button
              onClick={saveSettings}
              disabled={savingSettings}
              className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ backgroundColor: '#06C755' }}
            >
              {savingSettings ? '保存中...' : '設定を保存'}
            </button>
          </div>
        </div>
      )}

      {editing && (
        <EditDialog
          draft={editing}
          selectedAccountId={selectedAccountId}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}

      {bulkOpen && (
        <BulkImportDialog
          selectedAccountId={selectedAccountId}
          existingFaqs={faqs.map((f) => ({ id: f.id, lineAccountId: f.lineAccountId, question: f.question }))}
          onClose={() => setBulkOpen(false)}
          onImported={() => { setBulkOpen(false); load() }}
        />
      )}
    </div>
  )
}
