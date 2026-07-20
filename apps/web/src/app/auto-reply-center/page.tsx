'use client'

import { useEffect, useState } from 'react'
import Header from '@/components/layout/header'
import FaqsPage from '@/app/faqs/page'
import KnowledgePage from '@/app/knowledge/page'
import AutoRepliesPage from '@/app/auto-replies/page'
import { useNavPermissions } from '@/lib/nav-permissions'
import { AutoReplyCenterEmbed } from '@/components/auto-reply-center/embed-context'

type CenterView = 'settings' | 'knowledge' | 'rules' | 'drafts'
type KnowledgeSource = 'faq' | 'documents'
type WorkflowStep = 1 | 2 | 3 | 4 | 5

const CENTER_VIEWS: CenterView[] = ['settings', 'knowledge', 'rules', 'drafts']
const KNOWLEDGE_SOURCES: KnowledgeSource[] = ['faq', 'documents']

const workflow: Array<{
  step: WorkflowStep
  title: string
  description: string
  view: CenterView
  permission: 'faq' | 'auto_reply'
}> = [
  { step: 1, title: '受付をON/OFF', description: '自動応答を使うか決める', view: 'settings', permission: 'faq' },
  { step: 2, title: '返信方法', description: 'すぐ送る／下書きにする', view: 'settings', permission: 'faq' },
  { step: 3, title: 'ナレッジ', description: 'FAQ・資料を答えの材料にする', view: 'knowledge', permission: 'faq' },
  { step: 4, title: '例外ルール', description: 'AIより先にキーワードで返す', view: 'rules', permission: 'auto_reply' },
  { step: 5, title: '下書き受信箱', description: '送る前の回答案を確認する', view: 'drafts', permission: 'faq' },
]

function isCenterView(value: string | null): value is CenterView {
  return value !== null && CENTER_VIEWS.includes(value as CenterView)
}

function isKnowledgeSource(value: string | null): value is KnowledgeSource {
  return value !== null && KNOWLEDGE_SOURCES.includes(value as KnowledgeSource)
}

function stepForView(view: CenterView, requestedStep?: string | null): WorkflowStep {
  if (view === 'settings') return requestedStep === '2' ? 2 : 1
  if (view === 'knowledge') return 3
  if (view === 'rules') return 4
  return 5
}

function replaceCenterLocation(view: CenterView, source: KnowledgeSource, step: WorkflowStep) {
  const params = new URLSearchParams(window.location.search)
  params.set('view', view)
  if (view === 'knowledge') params.set('source', source)
  else params.delete('source')
  if (view === 'settings' && step === 2) params.set('step', '2')
  else params.delete('step')
  window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`)
}

export default function AutoReplyCenterPage() {
  const [view, setView] = useState<CenterView>('settings')
  const [activeStep, setActiveStep] = useState<WorkflowStep>(1)
  const [knowledgeSource, setKnowledgeSource] = useState<KnowledgeSource>('faq')
  const [visitedViews, setVisitedViews] = useState<CenterView[]>(['settings'])
  const [visitedKnowledgeSources, setVisitedKnowledgeSources] = useState<KnowledgeSource[]>([])
  const { isVisible } = useNavPermissions()
  const canUseFaq = isVisible('/faqs')
  const canUseRules = isVisible('/auto-replies')

  const rememberView = (nextView: CenterView) => {
    setVisitedViews((current) => current.includes(nextView) ? current : [...current, nextView])
  }

  const rememberKnowledgeSource = (source: KnowledgeSource) => {
    setVisitedKnowledgeSources((current) => current.includes(source) ? current : [...current, source])
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const requestedView = params.get('view')
    const requestedSource = params.get('source')
    if (isCenterView(requestedView)) {
      setView(requestedView)
      setActiveStep(stepForView(requestedView, params.get('step')))
      setVisitedViews((current) => current.includes(requestedView) ? current : [...current, requestedView])
    }
    if (isKnowledgeSource(requestedSource)) {
      setKnowledgeSource(requestedSource)
      setVisitedKnowledgeSources((current) => current.includes(requestedSource) ? current : [...current, requestedSource])
    } else if (requestedView === 'knowledge') {
      setVisitedKnowledgeSources((current) => current.includes('faq') ? current : [...current, 'faq'])
    }
  }, [])

  useEffect(() => {
    if (view === 'rules' && !canUseRules && canUseFaq) {
      setView('settings')
      setActiveStep(1)
      rememberView('settings')
      replaceCenterLocation('settings', knowledgeSource, 1)
    } else if (view !== 'rules' && !canUseFaq && canUseRules) {
      setView('rules')
      setActiveStep(4)
      rememberView('rules')
      replaceCenterLocation('rules', knowledgeSource, 4)
    }
  }, [canUseFaq, canUseRules, knowledgeSource, view])

  const openWorkflowStep = (item: (typeof workflow)[number]) => {
    setView(item.view)
    setActiveStep(item.step)
    rememberView(item.view)
    if (item.view === 'knowledge') rememberKnowledgeSource(knowledgeSource)
    replaceCenterLocation(item.view, knowledgeSource, item.step)
  }

  const openKnowledgeSource = (source: KnowledgeSource) => {
    setKnowledgeSource(source)
    setView('knowledge')
    setActiveStep(3)
    rememberView('knowledge')
    rememberKnowledgeSource(source)
    replaceCenterLocation('knowledge', source, 3)
  }

  const hasPermission = (permission: 'faq' | 'auto_reply') => (
    permission === 'faq' ? canUseFaq : canUseRules
  )

  return (
    <div>
      <Header
        title="自動応答センター"
        description="LINEに質問が届いたときの答え方を、受付の順番どおりに設定する場所です。"
      />

      <div className="mb-6 rounded-xl border border-green-200 bg-green-50 p-4">
        <p className="text-sm font-semibold text-green-900">はじめに、この順番で確認します</p>
        <p className="mt-1 text-xs leading-relaxed text-green-800">
          AI（文章を考える機能）に任せる範囲と、人が先に決める例外をひとつの画面で整理できます。
        </p>
      </div>

      <nav aria-label="自動応答の受付順" className="mb-8 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        {workflow.map((item) => {
          const selected = activeStep === item.step
          const allowed = hasPermission(item.permission)
          return (
            <button
              key={item.step}
              type="button"
              disabled={!allowed}
              onClick={() => openWorkflowStep(item)}
              aria-current={selected ? 'step' : undefined}
              title={allowed ? undefined : 'この設定を見る権限がありません'}
              className={`min-h-[88px] rounded-xl border p-3 text-left transition-colors ${
                selected
                  ? 'border-green-500 bg-green-50 text-green-900 shadow-sm'
                  : 'border-gray-200 bg-white text-gray-700 hover:border-green-300 hover:bg-green-50/40'
              } disabled:cursor-not-allowed disabled:opacity-45`}
            >
              <span className="block text-sm font-semibold">{item.step} {item.title}</span>
              <span className="mt-1 block text-xs leading-relaxed"> {item.description}</span>
            </button>
          )
        })}
      </nav>

      {!canUseFaq && !canUseRules && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          自動応答の設定を見る権限がありません。管理者に権限を確認してください。
        </div>
      )}

      {canUseFaq && visitedViews.includes('settings') && (
        <section
          data-testid="center-settings-view"
          aria-labelledby="center-settings-heading"
          hidden={view !== 'settings'}
        >
          <div className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-4">
            <h2 id="center-settings-heading" className="text-base font-semibold text-blue-950">1–2. 受付と返信方法</h2>
            <p className="mt-1 text-sm leading-relaxed text-blue-800">
              主スイッチと「自動で送信する／下書きにする」を、上から順に設定できます。
            </p>
          </div>
          {/* FAQ設定は並走laneの変更を取り込めるよう、既存pageを移動・複製せず参照する。 */}
          <AutoReplyCenterEmbed hideHeader faqInitialTab="settings" faqTabs={['settings']}>
            <FaqsPage />
          </AutoReplyCenterEmbed>
        </section>
      )}

      {canUseFaq && visitedViews.includes('knowledge') && (
        <section
          data-testid="center-knowledge-view"
          aria-labelledby="center-knowledge-heading"
          hidden={view !== 'knowledge'}
        >
          <div className="mb-4">
            <h2 id="center-knowledge-heading" className="text-lg font-semibold text-gray-900">3. 答えの材料（ナレッジ）</h2>
            <p className="mt-1 text-sm text-gray-600">AIが答えるときに参照する情報を選んで整えます。</p>
          </div>

          <div className="mb-6 grid gap-3 md:grid-cols-3">
            <button
              type="button"
              onClick={() => openKnowledgeSource('faq')}
              className={`rounded-xl border p-4 text-left ${knowledgeSource === 'faq' ? 'border-green-500 bg-green-50' : 'border-gray-200 bg-white hover:border-green-300'}`}
            >
              <span className="block text-sm font-semibold text-gray-900">よくある質問を管理</span>
              <span className="mt-1 block text-xs leading-relaxed text-gray-600">質問と答えを1組ずつ登録します。</span>
            </button>
            <button
              type="button"
              onClick={() => openKnowledgeSource('documents')}
              className={`rounded-xl border p-4 text-left ${knowledgeSource === 'documents' ? 'border-green-500 bg-green-50' : 'border-gray-200 bg-white hover:border-green-300'}`}
            >
              <span className="block text-sm font-semibold text-gray-900">資料を管理</span>
              <span className="mt-1 block text-xs leading-relaxed text-gray-600">PDF・Word・文章・URLを取り込みます。</span>
            </button>
            <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-4" aria-disabled="true">
              <span className="block text-sm font-semibold text-gray-700">本人情報（順次対応）</span>
              <span className="mt-1 block text-xs leading-relaxed text-gray-500">使える場合は、受付設定の中に選択肢が表示されます。</span>
            </div>
          </div>

          {visitedKnowledgeSources.includes('faq') && (
            <div hidden={knowledgeSource !== 'faq'}>
              <AutoReplyCenterEmbed hideHeader faqInitialTab="faqs" faqTabs={['faqs', 'unmatched']}>
                <FaqsPage />
              </AutoReplyCenterEmbed>
            </div>
          )}
          {visitedKnowledgeSources.includes('documents') && (
            <div hidden={knowledgeSource !== 'documents'}>
              <AutoReplyCenterEmbed hideHeader knowledgeInitialTab="documents" knowledgeTabs={['documents']}>
                <KnowledgePage />
              </AutoReplyCenterEmbed>
            </div>
          )}
        </section>
      )}

      {canUseRules && visitedViews.includes('rules') && (
        <section
          data-testid="center-rules-view"
          aria-labelledby="center-rules-heading"
          hidden={view !== 'rules'}
        >
          <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <h2 id="center-rules-heading" className="text-base font-semibold text-amber-950">4. AIより先に動く例外ルール</h2>
            <p className="mt-1 text-sm leading-relaxed text-amber-800">
              キーワードが一致したときは、AI（文章を考える機能）より先に、ここで決めた内容を返します。
            </p>
          </div>
          <AutoReplyCenterEmbed hideHeader>
            <AutoRepliesPage />
          </AutoReplyCenterEmbed>
        </section>
      )}

      {canUseFaq && visitedViews.includes('drafts') && (
        <section
          data-testid="center-drafts-view"
          aria-labelledby="center-drafts-heading"
          hidden={view !== 'drafts'}
        >
          <div className="mb-4 rounded-lg border border-purple-200 bg-purple-50 p-4">
            <h2 id="center-drafts-heading" className="text-base font-semibold text-purple-950">5. 下書き受信箱</h2>
            <p className="mt-1 text-sm leading-relaxed text-purple-800">
              AIが作った、お客さまへ送る前の回答案をここで確認できます。
            </p>
          </div>
          <AutoReplyCenterEmbed
            hideHeader
            knowledgeInitialTab="ai"
            knowledgeTabs={['ai']}
            onOpenFaq={() => openKnowledgeSource('faq')}
          >
            <KnowledgePage />
          </AutoReplyCenterEmbed>
        </section>
      )}
    </div>
  )
}
