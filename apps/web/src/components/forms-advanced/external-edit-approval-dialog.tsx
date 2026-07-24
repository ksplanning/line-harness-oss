'use client'

import { useEffect, useRef, useState } from 'react'
import { fetchApi } from '@/lib/api'
import type { ExternalEditChange } from '@/lib/formaloo-advanced-api'
import { formatJstMinute } from '@/lib/datetime'
import { fileAnswerSummary, isFileAnswer } from '@/lib/file-answer'

const LINE_GREEN = '#06C755'
const CONFLICT_FALLBACK = '他の操作で回答の状態が変わりました。再読み込みして、差分を確認し直してください。'
const APPROVAL_FALLBACK = '承認できませんでした。再読み込みして、もう一度お試しください。'

export type LabeledExternalEditChange = ExternalEditChange & { label: string }

interface ExternalEditApprovalDialogProps {
  formId: string
  rowId: string
  source: 'edit_link' | 'sheet'
  editedAt: string | null
  changes?: LabeledExternalEditChange[]
  onClose: () => void
  onApproved: () => void | Promise<void>
}

function changeValueText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (isFileAnswer(value)) return fileAnswerSummary(value)
  if (typeof value === 'boolean') return value ? 'はい' : 'いいえ'
  if (Array.isArray(value)) return value.length > 0
    ? value.map(changeValueText).join('、')
    : '—'
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

function approvalError(error: unknown): string {
  const apiError = error && typeof error === 'object'
    ? error as { status?: unknown; body?: unknown }
    : null
  const body = apiError?.body && typeof apiError.body === 'object'
    ? apiError.body as { error?: unknown }
    : null
  const serverError = typeof body?.error === 'string' ? body.error : ''
  if (apiError?.status === 409) return serverError || CONFLICT_FALLBACK
  return APPROVAL_FALLBACK
}

export default function ExternalEditApprovalDialog({
  formId,
  rowId,
  source,
  editedAt,
  changes,
  onClose,
  onApproved,
}: ExternalEditApprovalDialogProps) {
  const [approving, setApproving] = useState(false)
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLDivElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const approvingRef = useRef(false)
  const changesAvailable = changes !== undefined
  const changeCount = changes?.length ?? 0

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    const previousBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    confirmRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !approvingRef.current) {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [])
      if (focusable.length === 0) {
        event.preventDefault()
        dialogRef.current?.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault()
        const target = event.shiftKey ? last : first
        target.focus()
        return
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousBodyOverflow
      queueMicrotask(() => {
        if (previouslyFocused?.isConnected) previouslyFocused.focus()
      })
    }
  }, [onClose])

  const approve = async () => {
    if (approvingRef.current) return
    approvingRef.current = true
    setApproving(true)
    setError('')
    try {
      await fetchApi(
        `/api/forms-advanced/${encodeURIComponent(formId)}/rows/${encodeURIComponent(rowId)}/approve-external-edit`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
          },
          body: JSON.stringify({
            expectedExternalEditSource: source,
            expectedExternalEditedAt: editedAt,
          }),
        },
      )
      await onApproved()
    } catch (error) {
      setError(approvalError(error))
    } finally {
      approvingRef.current = false
      setApproving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={() => { if (!approvingRef.current) onClose() }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="external-edit-approval-title"
        data-testid="external-edit-approval-dialog"
        tabIndex={-1}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl sm:p-6"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="external-edit-approval-title" className="text-lg font-bold text-gray-900">
          外部編集の差分を確認
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-gray-600">
          編集内容はすでに回答へ反映されています。確認済みにすると、外部編集の絞り込みから外れます。
        </p>

        <dl className="mt-4 grid grid-cols-[5rem_1fr] gap-x-3 gap-y-2 rounded-xl bg-gray-50 p-4 text-sm">
          <dt className="font-medium text-gray-500">編集経路</dt>
          <dd className="font-semibold text-gray-900">{source === 'edit_link' ? '編集URL' : 'シート'}</dd>
          <dt className="font-medium text-gray-500">編集日時</dt>
          <dd className="text-gray-900">{editedAt ? formatJstMinute(editedAt) : '日時不明'}</dd>
        </dl>

        <section className="mt-5" aria-labelledby="external-edit-change-list-title">
          <h3 id="external-edit-change-list-title" className="text-sm font-semibold text-gray-900">
            変更された項目{changesAvailable ? `（${changeCount}件）` : ''}
          </h3>
          {!changesAvailable ? (
            <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              変更項目を取得できませんでした。再読み込みしてから確認してください。
            </p>
          ) : changeCount > 0 ? (
            <ul className="mt-2 space-y-3">
              {changes.map((change, index) => (
                <li key={`${change.fieldId}-${index}`} className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                  <div className="text-sm font-semibold text-amber-900">{change.label}</div>
                  <div className="mt-2 grid gap-2 text-sm sm:grid-cols-[1fr_auto_1fr] sm:items-stretch">
                    <div className="min-w-0 rounded-lg border border-gray-200 bg-white p-3">
                      <div className="text-xs font-medium text-gray-500">変更前</div>
                      <div className="mt-1 whitespace-pre-wrap break-words text-gray-900 [overflow-wrap:anywhere]">
                        {changeValueText(change.before)}
                      </div>
                    </div>
                    <div aria-hidden="true" className="self-center text-center text-gray-400">→</div>
                    <div className="min-w-0 rounded-lg border border-emerald-200 bg-white p-3">
                      <div className="text-xs font-medium text-gray-500">変更後</div>
                      <div className="mt-1 whitespace-pre-wrap break-words text-gray-900 [overflow-wrap:anywhere]">
                        {changeValueText(change.after)}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              変更された項目はありません
            </p>
          )}
        </section>

        {error && (
          <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={onClose}
            disabled={approving}
            className="min-h-12 rounded-lg border border-gray-300 px-5 text-sm text-gray-700 disabled:opacity-50"
          >
            閉じる
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={() => void approve()}
            disabled={approving || !changesAvailable}
            className="min-h-12 rounded-lg px-5 text-sm font-bold text-white disabled:opacity-50"
            style={{ backgroundColor: LINE_GREEN }}
          >
            {approving ? '処理中…' : '確認済みにする'}
          </button>
        </div>
      </div>
    </div>
  )
}
