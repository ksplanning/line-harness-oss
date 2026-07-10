'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { api } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import Header from '@/components/layout/header'
import { extractKnowledgeText, type PdfjsLike } from '@/lib/knowledge-extract'
import {
  deriveEmbedStatus,
  formatUsageBar,
  sumNeurons,
  formatStoredDimsEstimate,
  extractErrorMessage,
  AI_OPERATIONAL_CAP,
  AI_FREE_TIER_CAP,
} from '@/components/knowledge/format'

interface KnowledgeDoc {
  id: string
  lineAccountId: string | null
  sourceType: 'url' | 'text'
  sourceUrl: string | null
  title: string | null
  createdAt: string
  updatedAt: string
  chunkCount: number
  embeddedCount: number
}
interface UsageRow {
  usageDate: string
  llmNeurons: number
  embedNeurons: number
  imageNeurons: number
  replyCount: number
}
interface Draft {
  id: string
  question: string
  draftAnswer: string
  status: string
  createdAt: string
}

type Tab = 'documents' | 'ai'

function formatDateTime(iso: string): string {
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/)
  return m ? `${m[1]} ${m[2]}` : iso.slice(0, 16)
}

// pdf.js は本番ブラウザで workerSrc が必要。動的 import した**同一 module** に /public の worker asset を配線する
// (別インスタンスに設定しても効かない / B5-2・H-6)。docx は既定 loader (browser build は arrayBuffer 対応)。
async function loadPdfjsWithWorker(): Promise<PdfjsLike> {
  const pdfjs = await import('pdfjs-dist')
  ;(pdfjs as unknown as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc =
    '/pdf.worker.min.mjs'
  return pdfjs as unknown as PdfjsLike
}

export default function KnowledgePage() {
  const { selectedAccountId } = useAccount()
  const [tab, setTab] = useState<Tab>('documents')

  const [docs, setDocs] = useState<KnowledgeDoc[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // upload 入力
  const [textContent, setTextContent] = useState('')
  const [urlValue, setUrlValue] = useState('')
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  // 行内削除確認 (native window.confirm は使わない / M-16)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // AI ログ・コスト
  const [usage, setUsage] = useState<{ account: UsageRow[]; global: UsageRow[]; embeddedChunks: number } | null>(null)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [unresolvedCount, setUnresolvedCount] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const accountId = selectedAccountId || undefined
      const res = await api.knowledge.documents({ accountId })
      if (res.success) setDocs(res.data)
    } catch {
      setError('資料の読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [selectedAccountId])

  const loadAi = useCallback(async () => {
    try {
      const accountId = selectedAccountId || undefined
      const [usageRes, draftRes, unmatchedRes] = await Promise.all([
        api.knowledge.aiUsage({ accountId, days: 30 }),
        api.knowledge.aiDrafts({ accountId, limit: 50 }),
        api.faqs.unmatched({ accountId }),
      ])
      if (usageRes.success) setUsage(usageRes.data)
      if (draftRes.success) setDrafts(draftRes.data)
      if (unmatchedRes.success) setUnresolvedCount(unmatchedRes.data.filter((u) => !u.resolvedFaqId).length)
    } catch {
      // AI ログは best-effort (資料管理をブロックしない)
    }
  }, [selectedAccountId])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (tab === 'ai') loadAi() }, [tab, loadAi])

  const ingestText = async (content: string, docTitle: string) => {
    if (!selectedAccountId) { setError('LINEアカウントを選択してください'); return }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const res = await api.knowledge.ingest({ accountId: selectedAccountId, kind: 'text', content, title: docTitle || undefined })
      if (res.success) { setNotice('資料を取り込みました'); setTextContent(''); setTitle(''); load() }
      else setError('取り込みに失敗しました')
    } catch {
      setError('取り込みに失敗しました')
    } finally {
      setBusy(false)
    }
  }

  const handleFile = async (file: File) => {
    if (!selectedAccountId) { setError('LINEアカウントを選択してください'); return }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const text = await extractKnowledgeText(file, { loadPdfjs: loadPdfjsWithWorker })
      await api.knowledge.ingest({ accountId: selectedAccountId, kind: 'text', content: text, title: file.name })
      setNotice(`「${file.name}」を取り込みました`)
      load()
    } catch (e) {
      setError(extractErrorMessage(e))
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const ingestUrl = async () => {
    if (!selectedAccountId) { setError('LINEアカウントを選択してください'); return }
    if (!urlValue.trim()) { setError('URLを入力してください'); return }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const res = await api.knowledge.ingest({ accountId: selectedAccountId, kind: 'url', url: urlValue.trim(), title: title || undefined })
      if (res.success) { setNotice('URLの内容を取り込みました'); setUrlValue(''); setTitle(''); load() }
      else setError('取り込みに失敗しました')
    } catch {
      setError('URLの取り込みに失敗しました。取り込めるページか確認してください。')
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (id: string) => {
    try {
      await api.knowledge.deleteDocument(id, selectedAccountId)
      setConfirmDeleteId(null)
      load()
    } catch {
      setError('削除に失敗しました')
    }
  }

  const handleReingest = async (doc: KnowledgeDoc) => {
    if (doc.sourceType !== 'url') {
      setError('この資料は貼り付け/アップロードのため、再取込できません。新しい内容で取り込み直してください。')
      return
    }
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const res = await api.knowledge.reingest(doc.id, selectedAccountId)
      if (res.success) { setNotice('最新の内容で取り込み直しました'); load() }
      else setError(res.error || '再取込に失敗しました')
    } catch {
      setError('再取込に失敗しました')
    } finally {
      setBusy(false)
    }
  }

  // ── AI コスト集計 (当日 global 合算) ──
  const todayGlobal = usage?.global[0]
  const todayGlobalNeurons = todayGlobal ? sumNeurons({ llmNeurons: todayGlobal.llmNeurons, embedNeurons: todayGlobal.embedNeurons, imageNeurons: todayGlobal.imageNeurons }) : 0
  const opBar = formatUsageBar(todayGlobalNeurons, AI_OPERATIONAL_CAP, '運用上限')
  const freeBar = formatUsageBar(todayGlobalNeurons, AI_FREE_TIER_CAP, '無料枠')

  return (
    <div>
      <Header
        title="資料・AIログ"
        description="AIが答えるための資料（PDF・Word・テキスト・URL）を取り込み、AIの使用量や回答の記録を確認できます。"
      />

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
      )}
      {notice && (
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">{notice}</div>
      )}

      {/* タブ */}
      <div className="mb-4 inline-flex bg-gray-100 rounded-lg p-1 w-fit">
        {([
          { key: 'documents', label: '資料' },
          { key: 'ai', label: 'AI ログ・コスト' },
        ] as const).map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`min-h-[44px] px-4 rounded-md text-sm font-medium transition-colors ${
              tab === key ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── 資料 タブ ── */}
      {tab === 'documents' && (
        <div className="space-y-4">
          {!selectedAccountId && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-800">
              資料を取り込むには、上の「アカウント切替」でLINEアカウントを選んでください。
            </div>
          )}

          {/* upload コントロール */}
          <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-4">
            <h3 className="text-sm font-semibold text-gray-800">資料を追加する</h3>

            {/* ファイル */}
            <div>
              <label className="block text-xs text-gray-600 mb-1">ファイル（PDF / Word .docx）</label>
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                disabled={busy || !selectedAccountId}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f) }}
                className="block w-full text-sm text-gray-600 file:mr-3 file:py-2 file:px-3 file:rounded-md file:border-0 file:text-sm file:font-medium file:bg-green-50 file:text-green-700 hover:file:bg-green-100"
              />
              <p className="mt-1 text-[11px] text-gray-400">スキャン画像だけのPDF・パスワード付きPDF・古い .doc は取り込めません。</p>
            </div>

            {/* テキスト貼付 */}
            <div>
              <label className="block text-xs text-gray-600 mb-1">テキストを貼り付け</label>
              <textarea
                rows={3}
                value={textContent}
                onChange={(e) => setTextContent(e.target.value)}
                disabled={busy || !selectedAccountId}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-y"
                placeholder="営業時間や料金など、AIに覚えさせたい文章を貼り付けます。"
              />
            </div>

            {/* URL */}
            <div>
              <label className="block text-xs text-gray-600 mb-1">URLから取り込み</label>
              <input
                type="url"
                value={urlValue}
                onChange={(e) => setUrlValue(e.target.value)}
                disabled={busy || !selectedAccountId}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                placeholder="https://example.com/info"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-600 mb-1">タイトル（任意）</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={busy || !selectedAccountId}
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                placeholder="例: 料金表"
              />
            </div>

            <div className="flex gap-2">
              <button
                onClick={() => ingestText(textContent, title)}
                disabled={busy || !selectedAccountId || !textContent.trim()}
                className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90 disabled:opacity-50"
                style={{ backgroundColor: '#06C755' }}
              >
                テキストを取り込む
              </button>
              <button
                onClick={ingestUrl}
                disabled={busy || !selectedAccountId || !urlValue.trim()}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
              >
                URLを取り込む
              </button>
            </div>
          </div>

          {/* 資料一覧 */}
          {loading ? (
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 px-4 py-8 text-center text-gray-400 text-sm">読み込み中...</div>
          ) : docs.length === 0 ? (
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 px-4 py-8 text-center text-gray-400 text-sm">
              まだ資料がありません。上のフォームから最初の資料を取り込みましょう。
            </div>
          ) : (
            <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px]">
                  <thead>
                    <tr className="bg-gray-50 border-b border-gray-200">
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">タイトル / 取込元</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">種類</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">状態</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">取込日</th>
                      <th className="px-4 py-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {docs.map((d) => {
                      const status = deriveEmbedStatus({ chunkCount: d.chunkCount, embeddedCount: d.embeddedCount })
                      return (
                        <tr key={d.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3 text-sm text-gray-900">
                            <span className="block font-medium truncate max-w-[280px]">{d.title || (d.sourceUrl ?? '(無題)')}</span>
                            {d.sourceUrl && <span className="block text-[11px] text-gray-400 truncate max-w-[280px]">{d.sourceUrl}</span>}
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-600">{d.sourceType === 'url' ? 'URL' : 'テキスト'}</td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${
                              status.kind === 'done' ? 'bg-green-100 text-green-700'
                                : status.kind === 'partial' ? 'bg-amber-100 text-amber-700'
                                  : status.kind === 'unembedded' ? 'bg-gray-100 text-gray-500'
                                    : 'bg-gray-100 text-gray-400'
                            }`}>
                              {status.label}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">{formatDateTime(d.createdAt)}</td>
                          <td className="px-4 py-3 text-right whitespace-nowrap">
                            {confirmDeleteId === d.id ? (
                              <span className="inline-flex items-center gap-1">
                                <span className="text-[11px] text-gray-500">削除しますか？</span>
                                <button onClick={() => handleDelete(d.id)} className="px-2 py-1 text-xs font-medium text-white bg-red-500 rounded-md hover:bg-red-600">削除する</button>
                                <button onClick={() => setConfirmDeleteId(null)} className="px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-md">やめる</button>
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1">
                                {d.sourceType === 'url' && (
                                  <button onClick={() => handleReingest(d)} disabled={busy} className="px-2.5 py-1 text-xs font-medium text-blue-600 hover:bg-blue-50 rounded-md disabled:opacity-50">再取込</button>
                                )}
                                <button onClick={() => setConfirmDeleteId(d.id)} className="px-2.5 py-1 text-xs font-medium text-red-500 hover:bg-red-50 rounded-md">削除</button>
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── AI ログ・コスト タブ ── */}
      {tab === 'ai' && (
        <div className="space-y-4">
          {/* コスト dashboard */}
          <div className="bg-white border border-gray-200 rounded-lg p-5 space-y-3">
            <h3 className="text-sm font-semibold text-gray-800">今日のAI使用量（無料枠）</h3>
            <p className="text-[11px] text-gray-500">
              AIの利用は無料枠のなかで動きます。数値は1日ごとの合計です（1回ごとの内訳は記録していません）。
              いまは自動応答がOFF（準備中）のため、ここは0のことがあります。
            </p>
            {[opBar, freeBar].map((bar) => (
              <div key={bar.name}>
                <div className="flex justify-between text-xs text-gray-600 mb-1">
                  <span>{bar.name}（{bar.cap.toLocaleString('ja-JP')}）</span>
                  <span className="tabular-nums">{bar.used.toLocaleString('ja-JP')}（{bar.percent}%）</span>
                </div>
                <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${bar.percent}%`, backgroundColor: bar.percent >= 90 ? '#EF4444' : '#06C755' }} />
                </div>
              </div>
            ))}
            {todayGlobal && (
              <div className="text-[11px] text-gray-500 space-x-3">
                <span>回答生成 {todayGlobal.llmNeurons.toLocaleString('ja-JP')}</span>
                <span>意味検索 {todayGlobal.embedNeurons.toLocaleString('ja-JP')}</span>
                <span>画像 {todayGlobal.imageNeurons.toLocaleString('ja-JP')}</span>
                <span>生成試行 {todayGlobal.replyCount.toLocaleString('ja-JP')} 回（送信数ではありません）</span>
              </div>
            )}
            <div className="text-[11px] text-gray-500">
              意味検索の容量：{formatStoredDimsEstimate(usage?.embeddedChunks ?? 0, null)}
            </div>
          </div>

          {/* 日次推移 (global) */}
          {usage && usage.global.length > 0 && (
            <div className="bg-white border border-gray-200 rounded-lg p-5">
              <h3 className="text-sm font-semibold text-gray-800 mb-2">最近の使用量（全アカウント合算）</h3>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-400">
                    <th className="text-left py-1 font-medium">日付</th>
                    <th className="text-right py-1 font-medium">回答生成</th>
                    <th className="text-right py-1 font-medium">意味検索</th>
                    <th className="text-right py-1 font-medium">合計</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.global.map((r) => (
                    <tr key={r.usageDate} className="border-t border-gray-50">
                      <td className="py-1 text-gray-600">{r.usageDate}</td>
                      <td className="py-1 text-right tabular-nums text-gray-600">{r.llmNeurons.toLocaleString('ja-JP')}</td>
                      <td className="py-1 text-right tabular-nums text-gray-600">{r.embedNeurons.toLocaleString('ja-JP')}</td>
                      <td className="py-1 text-right tabular-nums text-gray-800 font-medium">{sumNeurons(r).toLocaleString('ja-JP')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* escalation 要約 */}
          <div className="bg-white border border-gray-200 rounded-lg p-5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-gray-800">AIを含む「答えられなかった質問」</h3>
                <p className="text-[11px] text-gray-500 mt-0.5">未対応の質問が {unresolvedCount} 件あります。</p>
              </div>
              <a href="/faqs" className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">
                よくある質問へ
              </a>
            </div>
          </div>

          {/* AI 草案ログ */}
          <div className="bg-white border border-gray-200 rounded-lg p-5">
            <h3 className="text-sm font-semibold text-gray-800 mb-1">AI 草案ログ</h3>
            <p className="text-[11px] text-gray-500 mb-3">下書きモードでAIが作った回答案です（自動送信された回答は記録されません）。</p>
            {drafts.length === 0 ? (
              <p className="text-xs text-gray-400">まだ草案はありません。</p>
            ) : (
              <div className="space-y-2">
                {drafts.map((d) => (
                  <div key={d.id} className="border border-gray-100 rounded-md p-3">
                    <div className="flex justify-between items-center">
                      <span className="text-xs font-medium text-gray-900 truncate max-w-[360px]">Q: {d.question}</span>
                      <span className="text-[10px] text-gray-400 whitespace-nowrap">{formatDateTime(d.createdAt)}</span>
                    </div>
                    <p className="mt-1 text-xs text-gray-600 line-clamp-2">A: {d.draftAnswer}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
