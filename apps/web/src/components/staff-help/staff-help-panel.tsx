'use client'
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { fetchStaffDocsEnabled, postStaffHelpChat, type StaffHelpAnswer, type StaffHelpCitation } from '@/lib/staff-help-api'

/**
 * line-staff-docs-chat Batch 2 — 管理画面の全ページから開ける常駐ヘルプチャット (staff-help)。
 *
 * AppShell の AuthGuard 内に mount (全認証ページ共通・/login は AppShell 冒頭 return で除外済 + 本 component も
 * pathname ガード)。static export (output:'export') 制約下の client component + lib/staff-help-api の fetch のみ
 * (新規動的ルート追加なし)。**送信ゼロ**: 顧客への LINE 送信経路に一切触れない (help 応答は HTTP のみ)。
 *
 * grandma UX 床: 本文 >=16px (シニア/非エンジニアが読める) / 本文色 #333 / アクセント #06C755 (LINE グリーン) /
 * 375px (スマホ) 収まり / タップ (クリック) で開く = hover-only にしない / 根拠資料タイトルを引用表示。
 * fail-closed: 根拠なし → 「資料にありません」と正直に返し推測回答しない。
 * capability-gate: STAFF_DOCS_ENABLED 無効なら描画しない (両面 OFF / plan §6)。
 */

const GREEN = '#06C755'
const TEXT = '#333333'

const FAIL_CLOSED: Record<Exclude<StaffHelpAnswer['status'], 'ok'>, string> = {
  no_evidence: '資料にありません。担当者にお尋ねください。',
  busy: 'ただいま混雑しています。少し後でお試しください。',
  error: 'うまく処理できませんでした。少し後でお試しください。',
}

interface ChatMsg {
  role: 'user' | 'assistant'
  text: string
  citations?: StaffHelpCitation[]
}

export default function StaffHelpPanel() {
  const pathname = usePathname()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [open, setOpen] = useState(false)
  const [question, setQuestion] = useState('')
  const [messages, setMessages] = useState<ChatMsg[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let alive = true
    fetchStaffDocsEnabled()
      .then((e) => { if (alive) setEnabled(e) })
      .catch(() => { if (alive) setEnabled(false) })
    return () => { alive = false }
  }, [])

  // /login では常駐しない (AppShell も除外するが component 側でも二重にガード)。
  if (pathname === '/login') return null
  // capability 無効 (or 未取得) は描画しない (dark-ship / 両面 OFF)。
  if (!enabled) return null

  async function ask() {
    const q = question.trim()
    if (!q || loading) return
    setMessages((prev) => [...prev, { role: 'user', text: q }])
    setQuestion('')
    setLoading(true)
    try {
      const res = await postStaffHelpChat(q)
      const text = res.status === 'ok' ? res.answer : FAIL_CLOSED[res.status]
      setMessages((prev) => [...prev, { role: 'assistant', text, citations: res.status === 'ok' ? res.citations : [] }])
    } catch {
      setMessages((prev) => [...prev, { role: 'assistant', text: FAIL_CLOSED.error, citations: [] }])
    } finally {
      setLoading(false)
    }
  }

  if (!open) {
    // ランチャー (タップで開く FAB / hover-only にしない)。
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="スタッフ用 使い方ヘルプを開く"
        style={{
          position: 'fixed', right: 16, bottom: 16, zIndex: 50,
          backgroundColor: GREEN, color: '#ffffff', fontSize: '16px', fontWeight: 700,
          border: 'none', borderRadius: 9999, padding: '12px 18px', cursor: 'pointer',
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
        }}
      >
        使い方を聞く
      </button>
    )
  }

  return (
    <div
      data-testid="staff-help-panel"
      role="dialog"
      aria-label="スタッフ用 使い方ヘルプ"
      style={{
        position: 'fixed', right: 16, bottom: 16, zIndex: 50,
        width: 'min(360px, calc(100vw - 32px))',
        maxWidth: 'calc(100vw - 32px)',
        maxHeight: '70vh',
        overflowY: 'auto',
        display: 'flex', flexDirection: 'column',
        backgroundColor: '#ffffff', color: TEXT, fontSize: '16px',
        border: '1px solid #e5e5e5', borderRadius: 12,
        boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', borderBottom: '1px solid #eee', backgroundColor: GREEN, color: '#ffffff', borderTopLeftRadius: 12, borderTopRightRadius: 12 }}>
        <strong style={{ fontSize: '16px' }}>使い方ヘルプ (ヘルプチャット)</strong>
        <button type="button" onClick={() => setOpen(false)} aria-label="閉じる" style={{ background: 'none', border: 'none', color: '#ffffff', fontSize: '18px', cursor: 'pointer' }}>×</button>
      </div>

      <div style={{ flex: 1, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {messages.length === 0 && (
          <p style={{ fontSize: '16px', color: TEXT, margin: 0 }}>
            管理画面の使い方を、この資料 (マニュアル) をもとにお答えします。例: 「一斉配信はどこから作りますか？」
          </p>
        )}
        {messages.map((msg, i) => (
          <div key={i} style={{ fontSize: '16px', color: TEXT, lineHeight: 1.6 }}>
            <div style={{ fontWeight: msg.role === 'user' ? 700 : 400, whiteSpace: 'pre-wrap' }}>
              {msg.role === 'user' ? `質問: ${msg.text}` : msg.text}
            </div>
            {msg.role === 'assistant' && msg.citations && msg.citations.length > 0 && (
              <div style={{ marginTop: 6, fontSize: '14px', color: '#555' }}>
                <span>根拠にした資料 (マニュアル):</span>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {msg.citations.map((cit) => (
                    <li key={cit.chunkId} style={{ color: '#555' }}>{cit.docTitle}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ))}
        {loading && <div style={{ fontSize: '16px', color: '#555' }}>調べています…</div>}
      </div>

      <div style={{ display: 'flex', gap: 8, padding: '12px 14px', borderTop: '1px solid #eee' }}>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask() } }}
          placeholder="使い方を入力してください"
          rows={2}
          style={{ flex: 1, fontSize: '16px', color: TEXT, padding: 8, border: '1px solid #ccc', borderRadius: 8, resize: 'none' }}
        />
        <button
          type="button"
          data-testid="staff-help-send"
          onClick={ask}
          disabled={loading}
          style={{ backgroundColor: GREEN, color: '#ffffff', fontSize: '16px', fontWeight: 700, border: 'none', borderRadius: 8, padding: '0 16px', cursor: 'pointer' }}
        >
          送信
        </button>
      </div>
    </div>
  )
}
