// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const m = vi.hoisted(() => ({
  list: vi.fn(),
  unmatched: vi.fn(),
  settingsGet: vi.fn(),
  settingsPut: vi.fn(),
  personalContextFields: vi.fn(),
  fieldDefinitionsList: vi.fn(),
  accountId: 'account-a',
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: m.accountId, accounts: [] }),
}))
vi.mock('@/components/layout/header', () => ({ default: () => null }))
vi.mock('@/components/faqs/edit-dialog', () => ({ default: () => null }))
vi.mock('@/components/faqs/bulk-import-dialog', () => ({ default: () => null }))
vi.mock('@/lib/api', () => ({ api: {
  friendFieldDefinitions: {
    list: (...args: unknown[]) => m.fieldDefinitionsList(...args),
  },
  faqs: {
    list: (...args: unknown[]) => m.list(...args),
    unmatched: (...args: unknown[]) => m.unmatched(...args),
    personalContextFields: (...args: unknown[]) => m.personalContextFields(...args),
    settings: {
      get: (...args: unknown[]) => m.settingsGet(...args),
      put: (...args: unknown[]) => m.settingsPut(...args),
    },
  },
} }))

import FaqsPage from './page'

const baseSettings = {
  enabled: true,
  threshold: 0.72,
  handoffMessage: '担当者より順次ご返信します',
  autoReplyNotice: '※この返信は自動応答です',
  maxRepliesPerDay: 7,
  answerMode: 'draft' as const,
  replyStyle: {
    instructions: '',
    greeting: '',
  },
  personalContext: {
    enabled: true,
    selectedCustomFieldIds: null,
    includeFormAnswers: true,
    maxTokens: 1_200,
  },
}

const definitions = [
  { id: 'field-payment', name: '入金状態', defaultValue: '', displayOrder: 1, isActive: true, createdAt: '', updatedAt: '' },
  { id: 'field-note', name: '担当メモ', defaultValue: '', displayOrder: 2, isActive: true, createdAt: '', updatedAt: '' },
  { id: 'field-inactive', name: '無効項目', defaultValue: '', displayOrder: 3, isActive: false, createdAt: '', updatedAt: '' },
]

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

function primeBaseRequests() {
  m.list.mockResolvedValue({ success: true, data: [] })
  m.unmatched.mockResolvedValue({ success: true, data: [] })
  m.settingsPut.mockResolvedValue({ success: true, data: baseSettings })
  m.personalContextFields.mockResolvedValue({
    success: true,
    data: definitions
      .filter((definition) => definition.isActive)
      .map(({ id, name }) => ({ id, name })),
  })
}

async function openSettings() {
  primeBaseRequests()
  m.settingsGet.mockResolvedValue({ success: true, data: baseSettings })
  m.fieldDefinitionsList.mockResolvedValue({ success: true, data: definitions })
  render(<FaqsPage />)
  await waitFor(() => expect(m.settingsGet).toHaveBeenCalled())
  fireEvent.click(screen.getByText('設定'))
}

beforeEach(() => {
  vi.clearAllMocks()
  m.accountId = 'account-a'
})
afterEach(() => cleanup())

describe('/faqs 設定タブ — 質問者本人の登録情報', () => {
  it('GETの既定ON・全custom項目・フォーム回答・token上限を表示する', async () => {
    await openSettings()

    expect((screen.getByLabelText('本人情報を回答に使う') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('すべてのカスタム項目') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('入金状態') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('担当メモ') as HTMLInputElement).checked).toBe(true)
    expect(screen.queryByLabelText('無効項目')).toBeNull()
    expect((screen.getByLabelText('過去のフォーム回答を含める') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByLabelText('本人情報の最大トークン数') as HTMLInputElement).value).toBe('1200')
    expect(m.personalContextFields).toHaveBeenCalledTimes(1)
    expect(m.fieldDefinitionsList).not.toHaveBeenCalled()
  })

  it('custom対象・フォーム回答・token上限を変更し、既存設定と一緒に保存する', async () => {
    await openSettings()

    fireEvent.click(screen.getByLabelText('担当メモ'))
    fireEvent.click(screen.getByLabelText('過去のフォーム回答を含める'))
    fireEvent.change(screen.getByLabelText('本人情報の最大トークン数'), { target: { value: '700' } })
    fireEvent.click(screen.getByText('設定を保存'))

    await waitFor(() => expect(m.settingsPut).toHaveBeenCalledTimes(1))
    expect(m.settingsPut).toHaveBeenCalledWith({
      accountId: 'account-a',
      ...baseSettings,
      personalContext: {
        enabled: true,
        selectedCustomFieldIds: ['field-payment'],
        includeFormAnswers: false,
        maxTokens: 700,
      },
    })
  })

  it('本人情報をOFFにして保存できる', async () => {
    await openSettings()
    fireEvent.click(screen.getByLabelText('本人情報を回答に使う'))
    fireEvent.click(screen.getByText('設定を保存'))

    await waitFor(() => expect(m.settingsPut).toHaveBeenCalledTimes(1))
    expect(m.settingsPut).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'account-a',
      personalContext: expect.objectContaining({ enabled: false }),
    }))
  })

  it('設定GET完了前は初期ONを保存できず、取得したOFFを表示してから保存可能にする', async () => {
    primeBaseRequests()
    const pending = deferred<{ success: true; data: typeof baseSettings }>()
    m.settingsGet.mockReturnValue(pending.promise)

    render(<FaqsPage />)
    fireEvent.click(screen.getByText('設定'))
    const save = screen.getByText('設定を保存') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(m.settingsPut).not.toHaveBeenCalled()

    pending.resolve({
      success: true,
      data: {
        ...baseSettings,
        personalContext: { ...baseSettings.personalContext, enabled: false },
      },
    })
    await waitFor(() => {
      expect((screen.getByLabelText('本人情報を回答に使う') as HTMLInputElement).checked).toBe(false)
      expect(save.disabled).toBe(false)
    })
  })

  it('account切替後に届いた古い設定応答を捨て、現在accountの設定だけを保存する', async () => {
    primeBaseRequests()
    const accountA = deferred<{ success: true; data: typeof baseSettings }>()
    const accountBSettings = {
      ...baseSettings,
      threshold: 0.55,
      personalContext: { ...baseSettings.personalContext, enabled: false },
    }
    m.settingsGet.mockImplementation(({ accountId }: { accountId: string }) => (
      accountId === 'account-a'
        ? accountA.promise
        : Promise.resolve({ success: true, data: accountBSettings })
    ))

    const view = render(<FaqsPage />)
    await waitFor(() => expect(m.settingsGet).toHaveBeenCalledWith({ accountId: 'account-a' }))
    m.accountId = 'account-b'
    view.rerender(<FaqsPage />)
    await waitFor(() => expect(m.settingsGet).toHaveBeenCalledWith({ accountId: 'account-b' }))
    fireEvent.click(screen.getByText('設定'))
    await waitFor(() => expect(
      (screen.getByLabelText('本人情報を回答に使う') as HTMLInputElement).checked,
    ).toBe(false))

    await act(async () => {
      accountA.resolve({ success: true, data: baseSettings })
      await accountA.promise
    })
    expect((screen.getByLabelText('本人情報を回答に使う') as HTMLInputElement).checked).toBe(false)

    fireEvent.click(screen.getByText('設定を保存'))
    await waitFor(() => expect(m.settingsPut).toHaveBeenCalledWith(expect.objectContaining({
      accountId: 'account-b',
      threshold: 0.55,
      personalContext: expect.objectContaining({ enabled: false }),
    })))
  })

  it('項目名APIだけ失敗してもFAQ設定本体の読み込みと保存を止めない', async () => {
    primeBaseRequests()
    m.personalContextFields.mockRejectedValue(new Error('field options unavailable'))
    m.settingsGet.mockResolvedValue({ success: true, data: baseSettings })

    render(<FaqsPage />)
    await waitFor(() => expect(m.settingsGet).toHaveBeenCalled())
    fireEvent.click(screen.getByText('設定'))

    expect((screen.getByText('設定を保存') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByText('読み込みに失敗しました')).toBeNull()
  })
})
