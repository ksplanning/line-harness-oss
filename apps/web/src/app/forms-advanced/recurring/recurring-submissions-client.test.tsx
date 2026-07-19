// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'

const account = { selectedAccountId: 'acc_a' as string | null, loading: false }
const getFormMock = vi.hoisted(() => vi.fn())
const listMock = vi.hoisted(() => vi.fn())
const createMock = vi.hoisted(() => vi.fn())
const setStatusMock = vi.hoisted(() => vi.fn())
const cancelMock = vi.hoisted(() => vi.fn())

vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }))
vi.mock('@/components/layout/header', () => ({ default: ({ title }: { title: string }) => <h1>{title}</h1> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => account }))
vi.mock('@/lib/formaloo-advanced-api', () => ({ formsAdvancedApi: { get: (...args: unknown[]) => getFormMock(...args) } }))
vi.mock('@/lib/formaloo-recurring-submissions-api', () => ({
  formalooRecurringSubmissionsApi: {
    list: (...args: unknown[]) => listMock(...args),
    create: (...args: unknown[]) => createMock(...args),
    setStatus: (...args: unknown[]) => setStatusMock(...args),
    cancel: (...args: unknown[]) => cancelMock(...args),
  },
}))

import RecurringSubmissionsClient from './recurring-submissions-client'

const resumed = {
  id: 'frs_1', formId: 'fa_1', idempotencyKey: 'attempt-1', remoteSlug: 'rs_1',
  schedule: { interval: { providerKey: 'providerValue' }, start_time: '2026-07-20T00:00:00Z', end_time: null },
  submissionData: { stock: 8 }, status: 'resumed' as const, syncState: 'synced' as const,
  lastError: null, createdAt: '2026-07-19', updatedAt: '2026-07-19',
}

beforeEach(() => {
  getFormMock.mockReset(); listMock.mockReset(); createMock.mockReset(); setStatusMock.mockReset(); cancelMock.mockReset()
  account.selectedAccountId = 'acc_a'; account.loading = false
  getFormMock.mockResolvedValue({ id: 'fa_1', title: '在庫報告', lineAccountId: 'acc_a' })
  listMock.mockResolvedValue({ items: [resumed], available: true })
})
afterEach(() => cleanup())

describe('定期自動回答 admin client', () => {
  test('lists a form schedule and exposes pause plus inline cancel confirmation', async () => {
    render(<RecurringSubmissionsClient formId="fa_1" />)
    await waitFor(() => expect(screen.getByTestId('recurring-row-rs_1')).toBeTruthy())
    expect(screen.getByText('在庫報告')).toBeTruthy()
    expect(screen.getByTestId('recurring-status-rs_1').textContent).toBe('稼働中')
    expect(screen.getByRole('button', { name: '一時停止' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.getByRole('button', { name: '本当に取消' })).toBeTruthy()
    expect(cancelMock).not.toHaveBeenCalled()
  })

  test('creates only after both JSON inputs parse, then renders server read-back truth', async () => {
    const created = { ...resumed, id: 'frs_2', remoteSlug: 'rs_2', submissionData: { stock: 12 } }
    createMock.mockResolvedValue(created)
    render(<RecurringSubmissionsClient formId="fa_1" />)
    await waitFor(() => expect(screen.getByTestId('recurring-create')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('開始時刻'), { target: { value: '2026-07-20T09:00' } })
    fireEvent.change(screen.getByLabelText('間隔 JSON'), { target: { value: '{"providerKey":"providerValue"}' } })
    fireEvent.change(screen.getByLabelText('回答内容 JSON'), { target: { value: '{"stock":12}' } })
    await act(async () => { fireEvent.submit(screen.getByTestId('recurring-create')) })

    expect(createMock).toHaveBeenCalledWith('fa_1', expect.objectContaining({
      idempotencyKey: expect.any(String),
      schedule: {
        interval: { providerKey: 'providerValue' },
        startTime: new Date('2026-07-20T09:00').toISOString(),
        endTime: null,
      },
      submissionData: { stock: 12 },
    }))
    expect(screen.getByTestId('recurring-row-rs_2')).toBeTruthy()
  })

  test('invalid interval JSON stays local and never calls create', async () => {
    render(<RecurringSubmissionsClient formId="fa_1" />)
    await waitFor(() => expect(screen.getByTestId('recurring-create')).toBeTruthy())
    fireEvent.change(screen.getByLabelText('開始時刻'), { target: { value: '2026-07-20T09:00' } })
    fireEvent.change(screen.getByLabelText('間隔 JSON'), { target: { value: '{bad' } })
    fireEvent.submit(screen.getByTestId('recurring-create'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('間隔 JSON'))
    expect(createMock).not.toHaveBeenCalled()
  })

  test('pause/resume/cancel update the row only with the returned read-back value', async () => {
    let resolvePause!: (value: unknown) => void
    setStatusMock.mockReturnValue(new Promise((resolve) => { resolvePause = resolve }))
    render(<RecurringSubmissionsClient formId="fa_1" />)
    await waitFor(() => expect(screen.getByTestId('recurring-status-rs_1').textContent).toBe('稼働中'))
    fireEvent.click(screen.getByRole('button', { name: '一時停止' }))
    expect(screen.getByTestId('recurring-status-rs_1').textContent).toBe('稼働中')
    await act(async () => { resolvePause({ ...resumed, status: 'paused' }) })
    expect(screen.getByTestId('recurring-status-rs_1').textContent).toBe('一時停止')
    expect(screen.getByRole('button', { name: '再開' })).toBeTruthy()

    cancelMock.mockResolvedValue({ ...resumed, status: 'cancelled' })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '本当に取消' })) })
    expect(screen.getByTestId('recurring-status-rs_1').textContent).toBe('取消済み')
    expect(screen.queryByRole('button', { name: '再開' })).toBeNull()
  })

  test('account mismatch is fail-closed and never loads recurring data', async () => {
    getFormMock.mockResolvedValue({ id: 'fa_1', title: '別アカウント', lineAccountId: 'acc_b' })
    render(<RecurringSubmissionsClient formId="fa_1" />)
    await waitFor(() => expect(screen.getByTestId('scope-blocked')).toBeTruthy())
    expect(listMock).not.toHaveBeenCalled()
  })

  test('a common form remains compatible across tenants and loads without a selected account', async () => {
    account.selectedAccountId = null
    getFormMock.mockResolvedValue({ id: 'fa_1', title: '共通フォーム', lineAccountId: null })
    render(<RecurringSubmissionsClient formId="fa_1" />)
    await waitFor(() => expect(listMock).toHaveBeenCalledWith('fa_1'))
    expect(screen.getByTestId('recurring-row-rs_1')).toBeTruthy()
  })
})
