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
  it('各workflowタブは、それぞれ異なるsectionを1つだけ表示する', () => {
    render(<AutoReplyCenterPage />)

    const workflow = screen.getByRole('navigation', { name: '自動応答の受付順' })
    const tabs = [
      {
        name: /1 受付と返信方法/,
        view: 'settings',
        step: '1',
        sectionTestId: 'center-settings-view',
        heading: '1. 受付と返信方法',
      },
      {
        name: /2 答えの材料（ナレッジ）/,
        view: 'knowledge',
        step: '2',
        sectionTestId: 'center-knowledge-view',
        heading: '2. 答えの材料（ナレッジ）',
      },
      {
        name: /3 AIより先に動く例外ルール/,
        view: 'rules',
        step: '3',
        sectionTestId: 'center-rules-view',
        heading: '3. AIより先に動く例外ルール',
      },
      {
        name: /4 下書き受信箱/,
        view: 'drafts',
        step: '4',
        sectionTestId: 'center-drafts-view',
        heading: '4. 下書き受信箱',
      },
    ]
    const sectionTestIds = [
      'center-settings-view',
      'center-knowledge-view',
      'center-rules-view',
      'center-drafts-view',
    ]
    const displayedSections = tabs.map((tab) => {
      const button = within(workflow).getByRole('button', { name: tab.name })
      fireEvent.click(button)
      const visibleSections = sectionTestIds.filter((testId) => {
        const section = screen.queryByTestId(testId)
        return section !== null && !section.hidden
      })
      expect(visibleSections).toHaveLength(1)
      expect(visibleSections[0]).toBe(tab.sectionTestId)
      expect(within(screen.getByTestId(tab.sectionTestId)).getByRole('heading', { name: tab.heading })).toBeTruthy()
      expect(within(workflow).getAllByRole('button')
        .filter((candidate) => candidate.getAttribute('aria-current') === 'step')).toEqual([button])
      const params = new URLSearchParams(window.location.search)
      expect(params.get('view')).toBe(tab.view)
      expect(params.get('step')).toBe(tab.step)
      return visibleSections[0]
    })

    expect(within(workflow).getAllByRole('button')).toHaveLength(4)
    expect(new Set(displayedSections).size).toBe(tabs.length)
  })

  it('受付と返信方法→ナレッジ→例外ルール→下書き受信箱の順に案内する', () => {
    render(<AutoReplyCenterPage />)

    expect(screen.getByRole('heading', { name: '自動応答センター' })).toBeTruthy()
    const workflow = screen.getByRole('navigation', { name: '自動応答の受付順' })
    const labels = within(workflow).getAllByRole('button').map((button) => button.textContent?.replace(/\s+/g, ' ').trim())
    expect(labels).toEqual([
      '1 受付と返信方法 自動応答を使うか・すぐ送るか下書きか',
      '2 答えの材料（ナレッジ） FAQ・資料を答えの材料にする',
      '3 AIより先に動く例外ルール AIより先にキーワードで返す',
      '4 下書き受信箱 送る前の回答案を確認する',
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

    fireEvent.click(screen.getByRole('button', { name: /2 答えの材料（ナレッジ）/ }))
    expect(screen.getByRole('button', { name: /よくある質問を管理/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /資料を管理/ })).toBeTruthy()
    expect(screen.getByText(/本人情報/)).toBeTruthy()
    expect(screen.getByTestId('center-knowledge-view').hidden).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /資料を管理/ }))
    const knowledgeView = screen.getByTestId('center-knowledge-view')
    expect(within(knowledgeView).getByTestId('knowledge-panel')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /3 AIより先に動く例外ルール/ }))
    expect(screen.getByText(/AI（文章を考える機能）より先/)).toBeTruthy()
    expect(screen.getByTestId('center-rules-view').hidden).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: /4 下書き受信箱/ }))
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
    expect(new URLSearchParams(window.location.search).get('view')).toBe('knowledge')
    expect(new URLSearchParams(window.location.search).get('source')).toBe('faq')
    expect(new URLSearchParams(window.location.search).get('step')).toBe('2')

    fireEvent.click(screen.getByRole('button', { name: /1 受付と返信方法/ }))
    expect(screen.getByTestId('center-settings-view').hidden).toBe(false)
    expect(screen.getAllByTestId('knowledge-panel')).toHaveLength(2)
  })

  it('旧URLから付く view クエリに応じた場所を最初に開く', async () => {
    window.history.replaceState({}, '', '/auto-reply-center?view=rules')
    render(<AutoReplyCenterPage />)

    await waitFor(() => expect(screen.getByTestId('center-rules-view').hidden).toBe(false))
    expect(new URLSearchParams(window.location.search).get('step')).toBe('3')
  })

  it.each([
    {
      query: '?view=knowledge&source=faq',
      viewTestId: 'center-knowledge-view',
      embedAttribute: 'data-faq-initial-tab',
      embedValue: 'faqs',
      expectedStep: '2',
    },
    {
      query: '?view=knowledge&source=documents',
      viewTestId: 'center-knowledge-view',
      embedAttribute: 'data-knowledge-initial-tab',
      embedValue: 'documents',
      expectedStep: '2',
    },
    {
      query: '?view=drafts',
      viewTestId: 'center-drafts-view',
      embedAttribute: 'data-knowledge-initial-tab',
      embedValue: 'ai',
      expectedStep: '4',
    },
  ])('旧URLの行き先 $query をセンター内の目的の機能へつなぐ', async ({
    query,
    viewTestId,
    embedAttribute,
    embedValue,
    expectedStep,
  }) => {
    window.history.replaceState({}, '', `/auto-reply-center${query}`)
    render(<AutoReplyCenterPage />)

    const targetView = await screen.findByTestId(viewTestId)
    await waitFor(() => expect(targetView.hidden).toBe(false))
    expect(within(targetView).getByTestId('center-embed').getAttribute(embedAttribute)).toBe(embedValue)
    expect(new URLSearchParams(window.location.search).get('step')).toBe(expectedStep)
  })

  it.each([
    {
      query: '?view=settings&step=1',
      expectedView: 'settings',
      expectedStep: '1',
      buttonName: /1 受付と返信方法/,
      viewTestId: 'center-settings-view',
    },
    {
      query: '?view=settings&step=2',
      expectedView: 'settings',
      expectedStep: '1',
      buttonName: /1 受付と返信方法/,
      viewTestId: 'center-settings-view',
    },
    {
      query: '?view=knowledge&step=3',
      expectedView: 'knowledge',
      expectedStep: '2',
      buttonName: /2 答えの材料（ナレッジ）/,
      viewTestId: 'center-knowledge-view',
    },
    {
      query: '?view=rules&step=4',
      expectedView: 'rules',
      expectedStep: '3',
      buttonName: /3 AIより先に動く例外ルール/,
      viewTestId: 'center-rules-view',
    },
    {
      query: '?view=drafts&step=5',
      expectedView: 'drafts',
      expectedStep: '4',
      buttonName: /4 下書き受信箱/,
      viewTestId: 'center-drafts-view',
    },
    {
      query: '?step=1',
      expectedView: 'settings',
      expectedStep: '1',
      buttonName: /1 受付と返信方法/,
      viewTestId: 'center-settings-view',
    },
    {
      query: '?step=2',
      expectedView: 'settings',
      expectedStep: '1',
      buttonName: /1 受付と返信方法/,
      viewTestId: 'center-settings-view',
    },
    {
      query: '?step=3',
      expectedView: 'knowledge',
      expectedStep: '2',
      buttonName: /2 答えの材料（ナレッジ）/,
      viewTestId: 'center-knowledge-view',
    },
    {
      query: '?step=4',
      expectedView: 'rules',
      expectedStep: '3',
      buttonName: /3 AIより先に動く例外ルール/,
      viewTestId: 'center-rules-view',
    },
    {
      query: '?step=5',
      expectedView: 'drafts',
      expectedStep: '4',
      buttonName: /4 下書き受信箱/,
      viewTestId: 'center-drafts-view',
    },
  ])('旧stepを新しい番号へ丸める: $query', async ({
    query,
    expectedView,
    expectedStep,
    buttonName,
    viewTestId,
  }) => {
    window.history.replaceState({}, '', `/auto-reply-center${query}`)
    render(<AutoReplyCenterPage />)

    const workflow = screen.getByRole('navigation', { name: '自動応答の受付順' })
    await waitFor(() => {
      expect(screen.getByTestId(viewTestId).hidden).toBe(false)
      expect(within(workflow).getByRole('button', { name: buttonName }).getAttribute('aria-current')).toBe('step')
    })
    expect(within(workflow).getAllByRole('button')
      .filter((button) => button.getAttribute('aria-current') === 'step')).toHaveLength(1)
    const params = new URLSearchParams(window.location.search)
    expect(params.get('view')).toBe(expectedView)
    expect(params.get('step')).toBe(expectedStep)
  })

  it('FAQ権限だけなら、開けない例外ルールURLを受付設定へ戻す', async () => {
    nav.isVisible.mockImplementation((href) => href === '/faqs')
    window.history.replaceState({}, '', '/auto-reply-center?view=rules')
    render(<AutoReplyCenterPage />)

    await waitFor(() => expect(screen.getByTestId('center-settings-view').hidden).toBe(false))
    const workflow = screen.getByRole('navigation', { name: '自動応答の受付順' })
    expect(within(workflow).getAllByRole('button').map((button) => button.hasAttribute('disabled')))
      .toEqual([false, false, true, false])
    expect(window.location.search).toBe('?view=settings&step=1')
  })

  it('例外ルール権限だけなら、最初から開ける3番へ案内する', async () => {
    nav.isVisible.mockImplementation((href) => href === '/auto-replies')
    render(<AutoReplyCenterPage />)

    await waitFor(() => expect(screen.getByTestId('center-rules-view').hidden).toBe(false))
    const workflow = screen.getByRole('navigation', { name: '自動応答の受付順' })
    expect(within(workflow).getAllByRole('button').map((button) => button.hasAttribute('disabled')))
      .toEqual([true, true, false, true])
    expect(window.location.search).toBe('?view=rules&step=3')
  })

  it('どちらの権限もなければ、設定を描画せず管理者への確認を案内する', () => {
    nav.isVisible.mockReturnValue(false)
    render(<AutoReplyCenterPage />)

    expect(screen.getByText('自動応答の設定を見る権限がありません。管理者に権限を確認してください。')).toBeTruthy()
    expect(screen.getAllByRole('button')).toHaveLength(4)
    expect(screen.getAllByRole('button').every((button) => button.hasAttribute('disabled'))).toBe(true)
    expect(screen.queryByTestId('center-settings-view')).toBeNull()
    expect(screen.queryByTestId('center-rules-view')).toBeNull()
  })
})
