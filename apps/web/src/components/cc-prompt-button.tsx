'use client'

import { useState } from 'react'
import PromptModal, { type PromptTemplate } from '@/components/prompt-modal'

interface CcPromptButtonProps {
  prompts: PromptTemplate[]
  isChatComposerVisible?: boolean
}

export default function CcPromptButton({
  prompts,
  isChatComposerVisible = false,
}: CcPromptButtonProps) {
  const [isOpen, setIsOpen] = useState(false)

  const mobilePositionClass = isChatComposerVisible
    ? 'bottom-2 right-2 h-11 w-11 min-h-[44px] justify-center p-0 sm:bottom-6 sm:right-6 sm:h-auto sm:w-auto sm:min-h-[48px] sm:gap-2 sm:px-4 sm:py-3'
    : 'bottom-6 right-6 min-h-[48px] gap-2 px-4 py-3'

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className={`fixed z-50 flex items-center bg-gray-900 text-white text-sm font-medium rounded-full shadow-lg hover:bg-gray-800 transition-all ${mobilePositionClass}`}
        aria-label="CCに依頼"
      >
        <span className="text-base leading-none">📋</span>
        <span className="hidden sm:inline">CCに依頼</span>
      </button>

      <PromptModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        prompts={prompts}
      />
    </>
  )
}
