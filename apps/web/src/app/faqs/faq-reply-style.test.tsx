// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  list: vi.fn(),
  unmatched: vi.fn(),
  settingsGet: vi.fn(),
  settingsPut: vi.fn(),
  personalContextFields: vi.fn(),
  accountId: 'account-a',
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({
    selectedAccountId: m.accountId,
    accounts: [
      { id: 'account-a', name: '店舗A' },
      { id: 'account-b', name: '店舗B' },
    ],
  }),
}))
vi.mock('@/components/layout/header', () => ({ default: () => null }))
vi.mock('@/components/faqs/edit-dialog', () => ({ default: () => null }))
vi.mock('@/components/faqs/bulk-import-dialog', () => ({ default: () => null }))
vi.mock('@/lib/api', () => ({
  api: {
    faqs: {
      list: (...args: unknown[]) => m.list(...args),
      unmatched: (...args: unknown[]) => m.unmatched(...args),
      personalContextFields: (...args: unknown[]) => m.personalContextFields(...args),
      settings: {
        get: (...args: unknown[]) => m.settingsGet(...args),
        put: (...args: unknown[]) => m.settingsPut(...args),
      },
    },
  },
}))

import { AutoReplyCenterEmbed } from '@/components/auto-reply-center/embed-context'
import FaqsPage from './page'

const baseSettings = {
  enabled: true,
  threshold: 0.72,
  handoffMessage: '担当者より順次ご返信します',
  autoReplyNotice: '※この返信は自動応答です',
  maxRepliesPerDay: 7,
  answerMode: 'draft' as const,
  replyStyle: {
    instructions: 'です・ます調で、親しみやすく簡潔に。',
    greeting: '店舗Aの◯◎です。',
  },
  personalContext: {
    enabled: true,
    selectedCustomFieldIds: null,
    includeFormAnswers: true,
    maxTokens: 1_200,
  },
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

function primeBaseRequests() {
  m.list.mockResolvedValue({ success: true, data: [] })
  m.unmatched.mockResolvedValue({ success: true, data: [] })
  m.personalContextFields.mockResolvedValue({ success: true, data: [] })
  m.settingsPut.mockResolvedValue({ success: true, data: baseSettings })
}

function renderSettings() {
  return render(
    <AutoReplyCenterEmbed hideHeader faqInitialTab="settings">
      <FaqsPage />
    </AutoReplyCenterEmbed>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  m.accountId = 'account-a'
  primeBaseRequests()
})
afterEach(() => cleanup())

describe('自動応答センター — アカウント別の返信スタイル', () => {
  it('保存済みのスタイルと名乗り、例文、安全上の注意を表示する', async () => {
    m.settingsGet.mockResolvedValue({ success: true, data: baseSettings })
    renderSettings()

    await waitFor(() => expect(m.settingsGet).toHaveBeenCalledWith({ accountId: 'account-a' }))
    expect(screen.getByRole('heading', { name: '返信スタイル' })).toBeTruthy()
    expect((screen.getByLabelText('返信スタイルの指示（任意）') as HTMLTextAreaElement).value)
      .toBe(baseSettings.replyStyle.instructions)
    expect((screen.getByLabelText('名乗り（冒頭文・任意）') as HTMLInputElement).value)
      .toBe(baseSettings.replyStyle.greeting)
    expect(screen.getByPlaceholderText(/です・ます調で、親しみやすく簡潔に/)).toBeTruthy()
    expect(screen.getByText(/資料やFAQの事実を変える指示/)).toBeTruthy()
    expect(screen.getByText(/登録済みナレッジを優先/)).toBeTruthy()
  })

  it('編集した2項目を現在の LINE アカウントと既存設定のまま保存する', async () => {
    m.settingsGet.mockResolvedValue({ success: true, data: baseSettings })
    renderSettings()
    await waitFor(() => expect(m.settingsGet).toHaveBeenCalled())

    fireEvent.change(screen.getByLabelText('返信スタイルの指示（任意）'), {
      target: { value: 'やわらかい敬語で、絵文字は1個まで。' },
    })
    fireEvent.change(screen.getByLabelText('名乗り（冒頭文・任意）'), {
      target: { value: '店舗Aの担当です。' },
    })
    fireEvent.click(screen.getByRole('button', { name: '設定を保存' }))

    await waitFor(() => expect(m.settingsPut).toHaveBeenCalledTimes(1))
    expect(m.settingsPut).toHaveBeenCalledWith({
      accountId: 'account-a',
      ...baseSettings,
      replyStyle: {
        instructions: 'やわらかい敬語で、絵文字は1個まで。',
        greeting: '店舗Aの担当です。',
      },
    })
  })

  it('旧レスポンスに replyStyle がなくても空欄で開き、未設定のまま保存できる', async () => {
    const { replyStyle: _replyStyle, ...legacySettings } = baseSettings
    m.settingsGet.mockResolvedValue({ success: true, data: legacySettings })
    renderSettings()

    await waitFor(() => expect(m.settingsGet).toHaveBeenCalled())
    expect((screen.getByLabelText('返信スタイルの指示（任意）') as HTMLTextAreaElement).value).toBe('')
    expect((screen.getByLabelText('名乗り（冒頭文・任意）') as HTMLInputElement).value).toBe('')

    fireEvent.click(screen.getByRole('button', { name: '設定を保存' }))
    await waitFor(() => expect(m.settingsPut).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'account-a',
      replyStyle: { instructions: '', greeting: '' },
    })))
  })

  it('A の遅い取得結果を破棄し、切替後の B のスタイルだけを表示・保存する', async () => {
    const accountA = deferred<{ success: true; data: typeof baseSettings }>()
    const accountBSettings = {
      ...baseSettings,
      replyStyle: {
        instructions: '店舗Bだけの落ち着いた敬語。',
        greeting: '店舗Bでございます。',
      },
    }
    m.settingsGet.mockImplementation(({ accountId }: { accountId: string }) => (
      accountId === 'account-a'
        ? accountA.promise
        : Promise.resolve({ success: true, data: accountBSettings })
    ))

    const view = renderSettings()
    await waitFor(() => expect(m.settingsGet).toHaveBeenCalledWith({ accountId: 'account-a' }))
    m.accountId = 'account-b'
    view.rerender(
      <AutoReplyCenterEmbed hideHeader faqInitialTab="settings">
        <FaqsPage />
      </AutoReplyCenterEmbed>,
    )
    await waitFor(() => expect(m.settingsGet).toHaveBeenCalledWith({ accountId: 'account-b' }))
    await waitFor(() => expect(
      (screen.getByLabelText('返信スタイルの指示（任意）') as HTMLTextAreaElement).value,
    ).toBe('店舗Bだけの落ち着いた敬語。'))

    await act(async () => {
      accountA.resolve({ success: true, data: baseSettings })
      await accountA.promise
    })
    expect((screen.getByLabelText('返信スタイルの指示（任意）') as HTMLTextAreaElement).value)
      .toBe('店舗Bだけの落ち着いた敬語。')

    fireEvent.click(screen.getByRole('button', { name: '設定を保存' }))
    await waitFor(() => expect(m.settingsPut).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'account-b',
      replyStyle: accountBSettings.replyStyle,
    })))
  })
})
