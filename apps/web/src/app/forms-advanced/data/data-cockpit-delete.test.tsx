// @vitest-environment jsdom
/**
 * form-response-delete (D-2) — 内部フォーム回答詳細の inline 削除確認。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'

const mockAccount: { selectedAccountId: string | null } = { selectedAccountId: null }
const getMock = vi.fn()
const rowsMock = vi.fn()
const rowMock = vi.fn()
const deleteRowMock = vi.fn()
const statsMock = vi.fn()
const listFiltersMock = vi.fn()
const fetchApiMock = vi.fn()

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a>,
}))
vi.mock('@/components/layout/header', () => ({ default: () => null }))
vi.mock('@/components/forms-advanced/data-cockpit', () => ({
  default: ({ onOpenRow }: { onOpenRow: (id: string) => void }) => (
    <button type="button" data-testid="open-row" onClick={() => onOpenRow('row-1')}>回答を開く</button>
  ),
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => mockAccount }))
vi.mock('@/lib/download', () => ({
  csvDateStamp: () => '20260722',
  safeFilenamePart: (value: string) => value,
}))
vi.mock('@/lib/formaloo-advanced-api', () => ({
  formsAdvancedApi: {
    get: (...args: unknown[]) => getMock(...args),
  },
  formalooDataApi: {
    rows: (...args: unknown[]) => rowsMock(...args),
    row: (...args: unknown[]) => rowMock(...args),
    deleteRow: (...args: unknown[]) => deleteRowMock(...args),
    stats: (...args: unknown[]) => statsMock(...args),
    listFilters: (...args: unknown[]) => listFiltersMock(...args),
  },
}))
vi.mock('@/lib/api', () => ({ fetchApi: (...args: unknown[]) => fetchApiMock(...args) }))

import DataCockpitClient from './data-cockpit-client'

beforeEach(() => {
  mockAccount.selectedAccountId = null
  getMock.mockReset()
  rowsMock.mockReset()
  rowMock.mockReset()
  deleteRowMock.mockReset()
  statsMock.mockReset()
  listFiltersMock.mockReset()
  fetchApiMock.mockReset()

  getMock.mockResolvedValue({
    id: 'form-1',
    title: '内部フォーム',
    lineAccountId: null,
    renderBackend: 'internal',
  })
  rowsMock.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 25 })
  statsMock.mockResolvedValue({ total: 1, verified: 0, daily: [], formaloo: null })
  listFiltersMock.mockResolvedValue([])
  fetchApiMock.mockResolvedValue({ data: { role: 'admin' } })
  rowMock.mockResolvedValue({
    id: 'row-1',
    source: 'internal',
    submittedAt: '2026-07-22T00:00:00+09:00',
    answers: { name: '既存回答' },
    allowPostEdit: 0,
    fields: [],
    lastEdit: null,
  })
  deleteRowMock.mockResolvedValue(undefined)
})

afterEach(() => cleanup())

async function openDetail(): Promise<void> {
  render(<DataCockpitClient id="form-1" />)
  fireEvent.click(await screen.findByTestId('open-row'))
  await screen.findByText('回答の詳細')
}

async function openDeleteConfirmation(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: '回答を削除' }))
  return screen.findByTestId('delete-answer-confirm')
}

describe('内部フォーム回答の削除', () => {
  it('最初のクリックで inline 確認を表示し、キャンセルでは API を呼ばない', async () => {
    await openDetail()

    const confirmation = await openDeleteConfirmation()
    fireEvent.click(within(confirmation).getByRole('button', { name: 'キャンセル' }))

    expect(deleteRowMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('delete-answer-confirm')).toBeNull()
    expect(screen.getByText('回答の詳細')).toBeTruthy()
  })

  it('確認後に削除し、詳細を閉じて通知・一覧・統計を更新する', async () => {
    await openDetail()
    const confirmation = await openDeleteConfirmation()

    fireEvent.click(within(confirmation).getByRole('button', { name: '削除する' }))

    await waitFor(() => expect(deleteRowMock).toHaveBeenCalledWith('form-1', 'row-1'))
    await waitFor(() => expect(screen.queryByText('回答の詳細')).toBeNull())
    expect(await screen.findByText(/削除しました/)).toBeTruthy()
    await waitFor(() => {
      expect(rowsMock).toHaveBeenCalledTimes(2)
      expect(statsMock).toHaveBeenCalledTimes(2)
    })
  })

  it('API が拒否したら詳細を閉じず、server の error を表示して再読込しない', async () => {
    deleteRowMock.mockRejectedValue({ body: { error: 'この回答を削除する権限がありません' } })
    await openDetail()
    const confirmation = await openDeleteConfirmation()

    fireEvent.click(within(confirmation).getByRole('button', { name: '削除する' }))

    expect(await screen.findByText('この回答を削除する権限がありません')).toBeTruthy()
    expect(screen.getByText('回答の詳細')).toBeTruthy()
    expect(rowsMock).toHaveBeenCalledTimes(1)
    expect(statsMock).toHaveBeenCalledTimes(1)
  })

  it('Formaloo 回答の詳細には単体削除ボタンを表示しない', async () => {
    getMock.mockResolvedValue({
      id: 'form-1',
      title: 'Formaloo フォーム',
      lineAccountId: null,
      renderBackend: 'formaloo',
    })
    rowMock.mockResolvedValue({
      id: 'row-1',
      source: 'formaloo',
      submittedAt: '2026-07-22T00:00:00+09:00',
      answers: { name: 'Formaloo 回答' },
      allowPostEdit: 0,
      fields: [],
      lastEdit: null,
    })

    await openDetail()

    expect(screen.queryByRole('button', { name: '回答を削除' })).toBeNull()
    expect(screen.queryByTestId('delete-answer-confirm')).toBeNull()
  })
})
