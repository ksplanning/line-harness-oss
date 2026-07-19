// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const m = vi.hoisted(() => ({
  account: { selectedAccountId: 'line-a' as string | null, loading: false },
  listForms: vi.fn(),
  history: vi.fn(),
  analyze: vi.fn(),
  errorMessage: vi.fn((error: unknown) => {
    const status = (error as { status?: number })?.status
    if (status === 402) return 'Formaloo のAI利用枠が足りません。利用状況を確認してください'
    if (status === 429) return '本日のAI分析上限に達しました。明日以降にもう一度お試しください'
    if (status === 504) return '回答に時間がかかりました。少し待ってからもう一度お試しください'
    return 'AI分析に失敗しました。少し待ってからもう一度お試しください'
  }),
}))

vi.mock('@/components/layout/header', () => ({ default: ({ title }: { title: string }) => <h1>{title}</h1> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => m.account }))
vi.mock('@/lib/formaloo-advanced-api', () => ({
  formsAdvancedApi: { list: (...args: unknown[]) => m.listForms(...args) },
}))
vi.mock('@/lib/formaloo-ai-chat-api', () => ({
  formalooAiChatApi: {
    history: (...args: unknown[]) => m.history(...args),
    analyze: (...args: unknown[]) => m.analyze(...args),
  },
  formalooAiChatErrorMessage: (error: unknown) => m.errorMessage(error),
}))

import Page from './page'

const form = { id: 'fa_1', title: 'お客様アンケート', formalooSlug: 'remote-1' }
const formB = { id: 'fa_2', title: 'B社アンケート', formalooSlug: 'remote-2' }
const completed = {
  id: 'fac_1', tenantScope: 'tenant-a', lineAccountId: 'line-a', formId: 'fa_1',
  question: '今週の傾向は？', answer: { summary: '回答が増えています' },
  answerText: '回答が増えています', analysisSlug: 'analysis_1', status: 'completed',
  providerStatus: 'completed', errorCode: null, errorMessage: null,
  creditsConsumed: true, creditReserved: true,
  createdAt: '2026-07-20T10:00:00.000+09:00', updatedAt: '2026-07-20T10:00:01.000+09:00',
}
const failed = {
  ...completed,
  id: 'fac_failed',
  question: '失敗した質問',
  answer: null,
  answerText: null,
  status: 'failed',
  errorMessage: 'Formaloo から回答を受け取れませんでした。連続実行せず、管理者に確認してください',
  errorCode: 'provider_unknown_failure',
}

beforeEach(() => {
  m.account.selectedAccountId = 'line-a'
  m.account.loading = false
  m.listForms.mockReset().mockResolvedValue([form])
  m.history.mockReset().mockResolvedValue([])
  m.analyze.mockReset().mockResolvedValue(completed)
  m.errorMessage.mockClear()
})
afterEach(() => cleanup())

describe('AI chat grandma UX and history', () => {
  test('loads account-scoped forms, shows example questions, and restores saved chat bubbles', async () => {
    m.history.mockResolvedValue([completed])
    render(<Page />)
    expect(await screen.findByRole('heading', { name: 'AIチャット' })).toBeTruthy()
    expect(m.listForms).toHaveBeenCalledWith('line-a')
    expect(await screen.findByRole('option', { name: 'お客様アンケート' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '今週の回答の傾向は？' })).toBeTruthy()
    expect(await screen.findByText('回答が増えています')).toBeTruthy()
    expect(screen.getAllByText('今週の傾向は？')).toHaveLength(2)
  })

  test('example button fills the question box', async () => {
    render(<Page />)
    const example = await screen.findByRole('button', { name: '今週の回答の傾向は？' })
    fireEvent.click(example)
    expect((screen.getByRole('textbox', { name: 'AIへの質問' }) as HTMLTextAreaElement).value)
      .toBe('今週の回答の傾向は？')
  })

  test('prevents double-send while running and appends the completed answer', async () => {
    let resolve!: (value: unknown) => void
    m.analyze.mockImplementation(() => new Promise((done) => { resolve = done }))
    render(<Page />)
    const textbox = await screen.findByRole('textbox', { name: 'AIへの質問' })
    fireEvent.change(textbox, { target: { value: '今週の傾向は？' } })
    const send = screen.getByRole('button', { name: 'AIに聞く' })
    fireEvent.click(send)
    fireEvent.click(send)
    expect(m.analyze).toHaveBeenCalledTimes(1)
    expect((send as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('分析しています…')).toBeTruthy()
    await act(async () => { resolve(completed) })
    expect(await screen.findByText('回答が増えています')).toBeTruthy()
  })

  test('surfaces a credit error in everyday language and allows retry', async () => {
    m.analyze.mockRejectedValue(Object.assign(new Error('API error'), { status: 402 }))
    render(<Page />)
    const textbox = await screen.findByRole('textbox', { name: 'AIへの質問' })
    fireEvent.change(textbox, { target: { value: '分析して' } })
    fireEvent.click(screen.getByRole('button', { name: 'AIに聞く' }))
    expect(await screen.findByText('Formaloo のAI利用枠が足りません。利用状況を確認してください')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'AIに聞く' }) as HTMLButtonElement).disabled).toBe(false)
  })

  test('keeps the global send lock until the old account request settles', async () => {
    let resolve!: (value: unknown) => void
    m.listForms.mockImplementation((accountId: string) => Promise.resolve(accountId === 'line-b' ? [formB] : [form]))
    m.analyze.mockImplementation(() => new Promise((done) => { resolve = done }))
    const { rerender } = render(<Page />)
    const textbox = await screen.findByRole('textbox', { name: 'AIへの質問' })
    fireEvent.change(textbox, { target: { value: 'A社を分析して' } })
    fireEvent.click(screen.getByRole('button', { name: 'AIに聞く' }))

    m.account.selectedAccountId = 'line-b'
    rerender(<Page />)
    expect(await screen.findByRole('option', { name: 'B社アンケート' })).toBeTruthy()
    expect(screen.getByText('分析しています…')).toBeTruthy()
    expect((screen.getByRole('textbox', { name: 'AIへの質問' }) as HTMLTextAreaElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '分析中…' }))
    expect(m.analyze).toHaveBeenCalledTimes(1)

    await act(async () => { resolve(completed) })
    await waitFor(() => expect((screen.getByRole('button', { name: 'AIに聞く' }) as HTMLButtonElement).disabled).toBe(true))
    // The button remains disabled only because the new account question is empty, not because a request is running.
    expect(screen.queryByText('分析しています…')).toBeNull()
  })

  test('never requests the old form under a newly selected account', async () => {
    m.listForms.mockImplementation((accountId: string) => Promise.resolve(accountId === 'line-b' ? [formB] : [form]))
    const { rerender } = render(<Page />)
    await waitFor(() => expect(m.history).toHaveBeenCalledWith({
      formId: 'fa_1', lineAccountId: 'line-a', limit: 50,
    }))

    m.account.selectedAccountId = 'line-b'
    rerender(<Page />)
    expect(await screen.findByRole('option', { name: 'B社アンケート' })).toBeTruthy()
    await waitFor(() => expect(m.history).toHaveBeenCalledWith({
      formId: 'fa_2', lineAccountId: 'line-b', limit: 50,
    }))
    expect(m.history).not.toHaveBeenCalledWith({
      formId: 'fa_1', lineAccountId: 'line-b', limit: 50,
    })
  })

  test('reloads and displays the saved failed history after an analysis error', async () => {
    m.history.mockResolvedValueOnce([]).mockResolvedValueOnce([failed])
    m.analyze.mockRejectedValue(Object.assign(new Error('hidden provider detail'), { status: 502 }))
    render(<Page />)
    const textbox = await screen.findByRole('textbox', { name: 'AIへの質問' })
    fireEvent.change(textbox, { target: { value: '失敗した質問' } })
    fireEvent.click(screen.getByRole('button', { name: 'AIに聞く' }))

    expect(await screen.findByText(failed.errorMessage)).toBeTruthy()
    expect(screen.getByText('AIクレジットを使用')).toBeTruthy()
    expect(m.history).toHaveBeenCalledTimes(2)
  })

  test('does not call APIs before an account is selected', async () => {
    m.account.selectedAccountId = null
    render(<Page />)
    await waitFor(() => expect(screen.getByText('先に左のメニューでLINEアカウントを選んでください')).toBeTruthy())
    expect(m.listForms).not.toHaveBeenCalled()
    expect(m.history).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'AIに聞く' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
