'use client'

import { createContext, useContext, type ReactNode } from 'react'

export type EmbeddedFaqTab = 'faqs' | 'unmatched' | 'settings'
export type EmbeddedKnowledgeTab = 'documents' | 'ai'

interface AutoReplyCenterEmbedOptions {
  hideHeader?: boolean
  faqInitialTab?: EmbeddedFaqTab
  faqTabs?: readonly EmbeddedFaqTab[]
  knowledgeInitialTab?: EmbeddedKnowledgeTab
  knowledgeTabs?: readonly EmbeddedKnowledgeTab[]
  onOpenFaq?: () => void
}

const AutoReplyCenterEmbedContext = createContext<AutoReplyCenterEmbedOptions | null>(null)

export function AutoReplyCenterEmbed({
  children,
  ...options
}: AutoReplyCenterEmbedOptions & { children: ReactNode }) {
  return (
    <AutoReplyCenterEmbedContext.Provider value={options}>
      {children}
    </AutoReplyCenterEmbedContext.Provider>
  )
}

export function useAutoReplyCenterEmbed(): AutoReplyCenterEmbedOptions | null {
  return useContext(AutoReplyCenterEmbedContext)
}
