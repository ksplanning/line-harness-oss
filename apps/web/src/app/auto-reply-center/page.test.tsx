// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const nav = vi.hoisted(() => ({ isVisible: vi.fn<(href: string) => boolean>() }))

vi.mock('@/components/layout/header', () => ({
  default: ({ title, description }: { title: string; description?: string }) => (
    <header><h1>{title}</h1>{description && <p>{description}</p>}</header>
  ),
}))
vi.mock('@/app/faqs/page', () => ({ default: () => <div data-testid="faq-panel">FAQ機能</div> }))
vi.mock('@/app/knowledge/page', () => ({ default: () => <div data-testid="knowledge-panel">資料・AIログ機能</div> }))
vi.mock('@/app/auto-replies/page', () => ({ default: () => <div data-testid="rules-panel">キーワードルール機能</div> }))
vi.mock('@/components/auto-reply-center/embed-context', () => ({
  AutoReplyCenterEmbed: ({
    children,
    hideHeader,
    faqInitialTab,
    faqTabs,
    knowledgeInitialTab,
    knowledgeTabs,
    onOpenFaq,
  }: {
    children: React.ReactNode
    hideHeader?: boolean
    faqInitialTab?: string
    faqTabs?: readonly string[]
    knowledgeInitialTab?: string
    knowledgeTabs?: readonly string[]
    onOpenFaq?: () => void
  }) => (
    <div
      data-testid="center-embed"
      data-hide-header={String(Boolean(hideHeader))}
      data-faq-initial-tab={faqInitialTab}
      data-faq-tabs={faqTabs?.join(',')}
      data-knowledge-initial-tab={knowledgeInitialTab}
      data-knowledge-tabs={knowledgeTabs?.join(',')}
    >
      {children}
      {onOpenFaq && <button type="button" onClick={onOpenFaq}>埋め込みからFAQへ</button>}
    </div>
  ),
}))
vi.mock('@/lib/nav-permissions', () => ({
  useNavPermissions: () => ({ isVisible: nav.isVisible }),
}))

import AutoReplyCenterPage from './page'

beforeEach(() => {
  nav.isVisible.mockReturnValue(true)
  window.history.replaceState({}, '', '/auto-reply-center')
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('/auto-reply-center — 受付順で既存機能をまとめる', () => {
  it('主スイッチ→モード→ナレッジ→例外ルール→下書き受信箱の順に案内する', () => {
    render(<AutoReplyCenterPage />)

    expect(screen.getByRole('heading', { name: '自動応答センター' })).toBeTruthy()
    const workflow = screen.getByRole('navigation', { name: '自動応答の受付順' })
    const labels = within(workflow).getAllByRole('button').map((button) => button.textContent?.replace(/\s+/g, ' ').trim())
    expect(labels).toEqual([
      '1 受付をON/OFF 自動応答を使うか決める',
      '2 返信方法 すぐ送る／下書きにする',
      '3 ナレッジ FAQ・資料を答えの材料にする',
      '4 例外ルール AIより先にキーワードで返す',
      '5 下書き受信箱 送る前の回答案を確認する',
    ])

    const selectedSteps = within(workflow).getAllByRole('button')
      .filter((button) => button.getAttribute('aria-current') === 'step')
    expect(selectedSteps).toHaveLength(1)

    // 最初の受付設定は既存 FAQ 画面をそのまま参照し、設定ロジックを複製しない。
    const settingsView = screen.getByTestId('center-settings-view')
    expect(settingsView.hidden).toBe(false)
    expect(within(settingsView).getByTestId('faq-panel')).toBeTruthy()
    const embed = within(settingsView).getByTestId('center-embed')
    expect(embed.getAttribute('data-faq-initial-tab')).toBe('settings')
    expect(embed.getAttribute('data-faq-tabs')).toBe('settings')
    expect(embed.getAttribute('data-hide-header')).toBe('true')
  })

  it('同じURLの中で FAQ・資料・例外ルール・下書きへ到達できる', () => {
    render(<AutoReplyCenterPage />)

    fireEvent.click(screen.getByRole('button', { name: /3 ナレッジ/ }))
    expect(screen.getByRole('button', { name: /よくある質問を管理/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /資料を管理/ })).toBeTruthy()
    expect(screen.getByText(/本人情報/)).toBeTruthy()
    expect(screen.getByTestId('center-knowledge-view').hidden).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /資料を管理/ }))
    const knowledgeView = screen.getByTestId('center-knowledge-view')
    expect(within(knowledgeView).getByTestId('knowledge-panel')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /4 例外ルール/ }))
    expect(screen.getByText(/AI（文章を考える機能）より先/)).toBeTruthy()
    expect(screen.getByTestId('center-rules-view').hidden).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /5 下書き受信箱/ }))
    const draftsView = screen.getByTestId('center-drafts-view')
    expect(draftsView.hidden).toBe(false)
    const draftsEmbed = within(draftsView).getByTestId('center-embed')
    expect(draftsEmbed.getAttribute('data-knowledge-initial-tab')).toBe('ai')
    expect(draftsEmbed.getAttribute('data-knowledge-tabs')).toBe('ai')

    // 一度開いた既存pageは、別stepへ移ってもmountされたまま残る。
    expect(screen.getAllByTestId('faq-panel')).toHaveLength(2)
    expect(screen.getAllByTestId('knowledge-panel')).toHaveLength(2)
    expect(screen.getAllByTestId('rules-panel')).toHaveLength(1)

    fireEvent.click(within(draftsView).getByRole('button', { name: '埋め込みからFAQへ' }))
    expect(screen.getByTestId('center-knowledge-view').hidden).toBe(false)
    expect(window.location.search).toBe('?view=knowledge&source=faq')

    fireEvent.click(screen.getByRole('button', { name: /1 受付をON\/OFF/ }))
    expect(screen.getByTestId('center-settings-view').hidden).toBe(false)
    expect(screen.getAllByTestId('knowledge-panel')).toHaveLength(2)
  })

  it('旧URLから付く view クエリに応じた場所を最初に開く', async () => {
    window.history.replaceState({}, '', '/auto-reply-center?view=rules')
    render(<AutoReplyCenterPage />)

    await waitFor(() => expect(screen.getByTestId('center-rules-view').hidden).toBe(false))
  })

  it.each([
    {
      query: '?view=knowledge&source=faq',
      viewTestId: 'center-knowledge-view',
      embedAttribute: 'data-faq-initial-tab',
      embedValue: 'faqs',
    },
    {
      query: '?view=knowledge&source=documents',
      viewTestId: 'center-knowledge-view',
      embedAttribute: 'data-knowledge-initial-tab',
      embedValue: 'documents',
    },
    {
      query: '?view=drafts',
      viewTestId: 'center-drafts-view',
      embedAttribute: 'data-knowledge-initial-tab',
      embedValue: 'ai',
    },
  ])('旧URLの行き先 $query をセンター内の目的の機能へつなぐ', async ({
    query,
    viewTestId,
    embedAttribute,
    embedValue,
  }) => {
    window.history.replaceState({}, '', `/auto-reply-center${query}`)
    render(<AutoReplyCenterPage />)

    const targetView = await screen.findByTestId(viewTestId)
    await waitFor(() => expect(targetView.hidden).toBe(false))
    expect(within(targetView).getByTestId('center-embed').getAttribute(embedAttribute)).toBe(embedValue)
  })

  it('返信方法への直リンクは2番だけを現在位置として示す', async () => {
    window.history.replaceState({}, '', '/auto-reply-center?view=settings&step=2')
    render(<AutoReplyCenterPage />)

    const workflow = screen.getByRole('navigation', { name: '自動応答の受付順' })
    await waitFor(() => {
      expect(within(workflow).getByRole('button', { name: /2 返信方法/ }).getAttribute('aria-current')).toBe('step')
    })
    expect(within(workflow).getByRole('button', { name: /1 受付をON\/OFF/ }).getAttribute('aria-current')).toBeNull()
  })

  it('FAQ権限だけなら、開けない例外ルールURLを受付設定へ戻す', async () => {
    nav.isVisible.mockImplementation((href) => href === '/faqs')
    window.history.replaceState({}, '', '/auto-reply-center?view=rules')
    render(<AutoReplyCenterPage />)

    await waitFor(() => expect(screen.getByTestId('center-settings-view').hidden).toBe(false))
    expect(screen.getByRole('button', { name: /4 例外ルール/ }).hasAttribute('disabled')).toBe(true)
    expect(window.location.search).toBe('?view=settings')
  })

  it('例外ルール権限だけなら、最初から開ける4番へ案内する', async () => {
    nav.isVisible.mockImplementation((href) => href === '/auto-replies')
    render(<AutoReplyCenterPage />)

    await waitFor(() => expect(screen.getByTestId('center-rules-view').hidden).toBe(false))
    expect(screen.getByRole('button', { name: /1 受付をON\/OFF/ }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: /4 例外ルール/ }).hasAttribute('disabled')).toBe(false)
    expect(window.location.search).toBe('?view=rules')
  })

  it('どちらの権限もなければ、設定を描画せず管理者への確認を案内する', () => {
    nav.isVisible.mockReturnValue(false)
    render(<AutoReplyCenterPage />)

    expect(screen.getByText('自動応答の設定を見る権限がありません。管理者に権限を確認してください。')).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(5)
    expect(screen.getAllByRole('button').every((button) => button.hasAttribute('disabled'))).toBe(true)
    expect(screen.queryByTestId('center-settings-view')).toBeNull()
    expect(screen.queryByTestId('center-rules-view')).toBeNull()
  })
})
