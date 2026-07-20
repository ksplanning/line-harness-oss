// @vitest-environment jsdom
/**
 * B-5 (T-E1/T-E4) — /knowledge page の api 配線 component test (visual-qa 封印の代替・dead-code 防止 / M-15・§9-2)。
 *  - 資料一覧が embed 状態を表示・削除/再取込が api を呼ぶ・AI タブがコスト api を呼ぶ、を mock api で assert。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'

const m = vi.hoisted(() => ({
  documents: vi.fn(), deleteDocument: vi.fn(), reingest: vi.fn(), aiUsage: vi.fn(), aiDrafts: vi.fn(), unmatched: vi.fn(),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-1' }) }))
vi.mock('@/components/layout/header', () => ({ default: () => <div data-testid="legacy-page-header" /> }))
vi.mock('@/lib/api', () => ({ api: {
  knowledge: {
    documents: (...a: unknown[]) => m.documents(...a),
    deleteDocument: (...a: unknown[]) => m.deleteDocument(...a),
    reingest: (...a: unknown[]) => m.reingest(...a),
    aiUsage: (...a: unknown[]) => m.aiUsage(...a),
    aiDrafts: (...a: unknown[]) => m.aiDrafts(...a),
    ingest: vi.fn(),
  },
  faqs: { unmatched: (...a: unknown[]) => m.unmatched(...a) },
} }))

import KnowledgePage from './page'
import { AutoReplyCenterEmbed } from '@/components/auto-reply-center/embed-context'

const doc = (over: Record<string, unknown>) => ({
  id: 'd', lineAccountId: 'acc-1', sourceType: 'text', sourceUrl: null, title: '資料', createdAt: '2026-07-11T10:00:00+09:00',
  updatedAt: '2026-07-11T10:00:00+09:00', chunkCount: 0, embeddedCount: 0, ...over,
})

beforeEach(() => {
  m.documents.mockResolvedValue({ success: true, data: [
    doc({ id: 'text-doc', sourceType: 'text', title: '料金表', chunkCount: 3, embeddedCount: 3 }),
    doc({ id: 'url-doc', sourceType: 'url', title: '店舗案内', sourceUrl: 'https://shop.example/', chunkCount: 5, embeddedCount: 0 }),
  ] })
  m.deleteDocument.mockResolvedValue({ success: true })
  m.reingest.mockResolvedValue({ success: true, data: { id: 'url-doc', chunkCount: 4 } })
  m.aiUsage.mockResolvedValue({ success: true, data: { account: [], global: [{ usageDate: '2026-07-11', llmNeurons: 100, embedNeurons: 20, imageNeurons: 0, replyCount: 2 }], embeddedChunks: 0 } })
  m.aiDrafts.mockResolvedValue({ success: true, data: [] })
  m.unmatched.mockResolvedValue({ success: true, data: [] })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('/knowledge page — 資料タブ', () => {
  it('資料一覧を embed 状態つきで表示する', async () => {
    render(<KnowledgePage />)
    await waitFor(() => expect(screen.getByText('料金表')).toBeTruthy())
    expect(screen.getByText('embed済 3/3')).toBeTruthy() // 全 embed
    expect(screen.getByText('未embed（意味検索は未設定）')).toBeTruthy() // 未 embed
  })

  it('削除は行内確認 → api.knowledge.deleteDocument を呼ぶ (native confirm 不使用 / M-16)', async () => {
    render(<KnowledgePage />)
    await waitFor(() => expect(screen.getByText('料金表')).toBeTruthy())
    fireEvent.click(screen.getAllByText('削除')[0])
    // 行内確認が出る。
    const confirmBtn = await screen.findByText('削除する')
    fireEvent.click(confirmBtn)
    await waitFor(() => expect(m.deleteDocument).toHaveBeenCalled())
    expect(m.deleteDocument.mock.calls[0][0]).toBe('text-doc')
  })

  it('URL 資料の再取込は api.knowledge.reingest を呼ぶ', async () => {
    render(<KnowledgePage />)
    await waitFor(() => expect(screen.getByText('店舗案内')).toBeTruthy())
    fireEvent.click(screen.getByText('再取込'))
    await waitFor(() => expect(m.reingest).toHaveBeenCalled())
    expect(m.reingest.mock.calls[0][0]).toBe('url-doc')
  })
})

describe('/knowledge page — AI ログ・コストタブ', () => {
  it('centerの下書き受信箱ではAI tabへ直着地し、旧page headerを重ねない', async () => {
    const openFaq = vi.fn()
    render(
      <AutoReplyCenterEmbed hideHeader knowledgeInitialTab="ai" knowledgeTabs={['ai']} onOpenFaq={openFaq}>
        <KnowledgePage />
      </AutoReplyCenterEmbed>,
    )

    await waitFor(() => expect(m.aiDrafts).toHaveBeenCalled())
    expect(screen.getByText('AI 草案ログ')).toBeTruthy()
    expect(screen.queryByTestId('legacy-page-header')).toBeNull()
    expect(screen.queryByRole('button', { name: '資料' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'よくある質問へ' }))
    expect(openFaq).toHaveBeenCalledOnce()
  })

  it('タブ切替でコスト api を呼び headroom を表示する', async () => {
    render(<KnowledgePage />)
    await waitFor(() => expect(screen.getByText('料金表')).toBeTruthy())
    fireEvent.click(screen.getByText('AI ログ・コスト'))
    await waitFor(() => expect(m.aiUsage).toHaveBeenCalled())
    expect(m.aiDrafts).toHaveBeenCalled()
    // 運用上限 9,000 と 無料枠 10,000 を別表示 (H-2) — 両ラベルが出る (heading 含め複数箇所)。
    expect(screen.getAllByText(/運用上限/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/無料枠/).length).toBeGreaterThan(0)
  })
})
