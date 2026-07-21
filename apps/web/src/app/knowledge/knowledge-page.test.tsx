// @vitest-environment jsdom
/**
 * B-5 (T-E1/T-E4) — /knowledge page の api 配線 component test (visual-qa 封印の代替・dead-code 防止 / M-15・§9-2)。
 *  - 資料一覧が embed 状態を表示・削除/再取込が api を呼ぶ・AI タブがコスト api を呼ぶ、を mock api で assert。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup, within } from '@testing-library/react'

const m = vi.hoisted(() => ({
  documents: vi.fn(), deleteDocument: vi.fn(), reingest: vi.fn(), aiUsage: vi.fn(), aiDrafts: vi.fn(), unmatched: vi.fn(),
  reviewList: vi.fn(), reviewUpdate: vi.fn(), reviewApprove: vi.fn(), reviewDiscard: vi.fn(),
  account: { selectedAccountId: 'acc-1' as string | null },
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: m.account.selectedAccountId }) }))
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
  faqDraftReviews: {
    list: (...a: unknown[]) => m.reviewList(...a),
    update: (...a: unknown[]) => m.reviewUpdate(...a),
    approve: (...a: unknown[]) => m.reviewApprove(...a),
    discard: (...a: unknown[]) => m.reviewDiscard(...a),
  },
} }))

import KnowledgePage from './page'
import { AutoReplyCenterEmbed } from '@/components/auto-reply-center/embed-context'

const doc = (over: Record<string, unknown>) => ({
  id: 'd', lineAccountId: 'acc-1', sourceType: 'text', sourceUrl: null, title: '資料', createdAt: '2026-07-11T10:00:00+09:00',
  updatedAt: '2026-07-11T10:00:00+09:00', chunkCount: 0, embeddedCount: 0, ...over,
})

const reviewDraft = {
  id: 'draft-1',
  friendName: 'あやこ',
  question: '営業時間は？',
  draftAnswer: '10時からです',
  status: 'pending',
  createdAt: '2026-07-21T10:01:00+09:00',
  updatedAt: '2026-07-21T10:01:00+09:00',
}

function renderCentralInbox() {
  return render(
    <AutoReplyCenterEmbed hideHeader knowledgeInitialTab="ai" knowledgeTabs={['ai']}>
      <KnowledgePage />
    </AutoReplyCenterEmbed>,
  )
}

beforeEach(() => {
  m.account.selectedAccountId = 'acc-1'
  m.documents.mockResolvedValue({ success: true, data: [
    doc({ id: 'text-doc', sourceType: 'text', title: '料金表', chunkCount: 3, embeddedCount: 3 }),
    doc({ id: 'url-doc', sourceType: 'url', title: '店舗案内', sourceUrl: 'https://shop.example/', chunkCount: 5, embeddedCount: 0 }),
  ] })
  m.deleteDocument.mockResolvedValue({ success: true })
  m.reingest.mockResolvedValue({ success: true, data: { id: 'url-doc', chunkCount: 4 } })
  m.aiUsage.mockResolvedValue({ success: true, data: { account: [], global: [{ usageDate: '2026-07-11', llmNeurons: 100, embedNeurons: 20, imageNeurons: 0, replyCount: 2 }], embeddedChunks: 0 } })
  m.aiDrafts.mockResolvedValue({ success: true, data: [] })
  m.unmatched.mockResolvedValue({ success: true, data: [] })
  m.reviewList.mockResolvedValue({ success: true, data: [reviewDraft] })
  m.reviewUpdate.mockImplementation(async (_id: string, body: { accountId: string; draftAnswer: string }) => ({
    success: true,
    data: { ...reviewDraft, draftAnswer: body.draftAnswer },
  }))
  m.reviewApprove.mockResolvedValue({ success: true, data: { draft: { ...reviewDraft, status: 'approved' } } })
  m.reviewDiscard.mockResolvedValue({ success: true, data: { ...reviewDraft, status: 'discarded' } })
})
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals() })

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
    expect(m.reviewList).toHaveBeenCalledWith('acc-1')
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
    expect(m.reviewList).not.toHaveBeenCalled()
    // 運用上限 9,000 と 無料枠 10,000 を別表示 (H-2) — 両ラベルが出る (heading 含め複数箇所)。
    expect(screen.getAllByText(/運用上限/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/無料枠/).length).toBeGreaterThan(0)
  })

  it('中央の下書き受信箱だけが pending 草案を編集し、成功をその場で反映する', async () => {
    renderCentralInbox()
    const card = await screen.findByTestId('central-ai-draft-draft-1')
    expect(within(card).getByText('あやこ')).toBeTruthy()
    expect(within(card).getByText('10時からです')).toBeTruthy()

    fireEvent.click(within(card).getByRole('button', { name: '下書きを編集' }))
    fireEvent.change(within(card).getByRole('textbox', { name: 'AI下書き本文' }), {
      target: { value: '11時から営業します' },
    })
    fireEvent.click(within(card).getByRole('button', { name: '編集を保存' }))

    await waitFor(() => expect(m.reviewUpdate).toHaveBeenCalledWith('draft-1', {
      accountId: 'acc-1',
      draftAnswer: '11時から営業します',
    }))
    expect(await within(card).findByText('11時から営業します')).toBeTruthy()
  })

  it('中央で承認送信すると1回だけAPIを呼び、pending一覧から即時に消す', async () => {
    renderCentralInbox()
    const card = await screen.findByTestId('central-ai-draft-draft-1')
    fireEvent.click(within(card).getByRole('button', { name: '承認して送信' }))

    await waitFor(() => expect(m.reviewApprove).toHaveBeenCalledWith('draft-1', { accountId: 'acc-1' }))
    await waitFor(() => expect(screen.queryByTestId('central-ai-draft-draft-1')).toBeNull())
  })

  it('中央の承認結果が曖昧な失敗なら再送ボタンを再有効化しない', async () => {
    m.reviewApprove.mockRejectedValueOnce(new Error('ambiguous delivery'))
    renderCentralInbox()
    const card = await screen.findByTestId('central-ai-draft-draft-1')
    const approveButton = within(card).getByRole('button', { name: '承認して送信' }) as HTMLButtonElement
    fireEvent.click(approveButton)

    expect(await within(card).findByText(/再送せず/)).toBeTruthy()
    expect(approveButton.disabled).toBe(true)
    fireEvent.click(approveButton)
    expect(m.reviewApprove).toHaveBeenCalledTimes(1)
  })

  it('中央の破棄は行内確認を必須にし、成功後に即時に消す', async () => {
    renderCentralInbox()
    const card = await screen.findByTestId('central-ai-draft-draft-1')
    fireEvent.click(within(card).getByRole('button', { name: '下書きを破棄' }))
    expect(m.reviewDiscard).not.toHaveBeenCalled()
    fireEvent.click(within(card).getByRole('button', { name: '破棄する' }))

    await waitFor(() => expect(m.reviewDiscard).toHaveBeenCalledWith('draft-1', { accountId: 'acc-1' }))
    await waitFor(() => expect(screen.queryByTestId('central-ai-draft-draft-1')).toBeNull())
  })

  it('アカウント未選択では中央pending APIを呼ばず、選択を案内する', async () => {
    m.account.selectedAccountId = null
    renderCentralInbox()

    expect(await screen.findByText(/下書き受信箱を使うには.*LINEアカウントを選択/)).toBeTruthy()
    expect(m.reviewList).not.toHaveBeenCalled()
  })

  it('通常のAI草案ログは従来どおり全状態を残し、状態名を見分けられる', async () => {
    m.aiDrafts.mockResolvedValueOnce({
      success: true,
      data: [
        { ...reviewDraft, id: 'log-pending', status: 'pending' },
        { ...reviewDraft, id: 'log-approved', question: '送信済み質問', status: 'approved' },
        { ...reviewDraft, id: 'log-discarded', question: '破棄した質問', status: 'discarded' },
      ],
    })
    render(<KnowledgePage />)
    await screen.findByText('料金表')
    fireEvent.click(screen.getByText('AI ログ・コスト'))

    expect(await screen.findByText(/送信済み質問/)).toBeTruthy()
    expect(screen.getByText(/破棄した質問/)).toBeTruthy()
    expect(screen.getByText('下書き')).toBeTruthy()
    expect(screen.getByText('送信済み')).toBeTruthy()
    expect(screen.getByText('破棄済み')).toBeTruthy()
  })

  it('別タブ通知とwindow復帰で中央pending一覧を再取得する', async () => {
    const channels: Array<{ emit: (data: unknown) => void }> = []
    class BroadcastChannelMock {
      private listener: ((event: MessageEvent) => void) | null = null
      constructor(_name: string) {
        channels.push({ emit: (data) => this.listener?.({ data } as MessageEvent) })
      }
      addEventListener(_type: string, listener: (event: MessageEvent) => void) { this.listener = listener }
      removeEventListener() { this.listener = null }
      postMessage() {}
      close() {}
    }
    vi.stubGlobal('BroadcastChannel', BroadcastChannelMock)
    renderCentralInbox()
    await waitFor(() => expect(m.reviewList).toHaveBeenCalledTimes(1))

    channels[0].emit({ type: 'faq-draft-review-changed', accountId: 'acc-1', draftId: 'draft-1' })
    await waitFor(() => expect(m.reviewList).toHaveBeenCalledTimes(2))
    fireEvent.focus(window)
    await waitFor(() => expect(m.reviewList).toHaveBeenCalledTimes(3))
  })
})
