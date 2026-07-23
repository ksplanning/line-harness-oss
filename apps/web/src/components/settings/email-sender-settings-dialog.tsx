'use client'

import { useEffect, useRef } from 'react'
import EmailSenderSettingsPanel from './email-sender-settings-panel'

interface EmailSenderSettingsDialogProps {
  accountId: string
  accountName: string
  onClose: () => void
}

const FOCUSABLE = [
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  'a[href]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export default function EmailSenderSettingsDialog({
  accountId,
  accountName,
  onClose,
}: EmailSenderSettingsDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [],
      )
      if (focusable.length === 0) {
        event.preventDefault()
        dialogRef.current?.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      previouslyFocused?.focus()
    }
  }, [onClose])

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="email-sender-settings-title"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
    >
      <div className="w-full max-w-3xl rounded-xl bg-gray-50 p-4 shadow-xl sm:p-6">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2
              id="email-sender-settings-title"
              className="text-lg font-bold text-gray-900"
            >
              メール差出人設定
            </h2>
            <p className="mt-1 text-sm text-gray-600">
              対象 LINE アカウント: {accountName}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="メール差出人設定を閉じる"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            閉じる
          </button>
        </div>
        <EmailSenderSettingsPanel accountId={accountId} />
      </div>
    </div>
  )
}
