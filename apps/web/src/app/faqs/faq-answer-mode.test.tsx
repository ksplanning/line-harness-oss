// @vitest-environment jsdom
/**
 * faq-answermode-toggle — /faqs 設定タブに「下書き ⇄ 自動送信」切替 UI を追加した際の
 * 配線 component test (visual-qa 封印の代替 / M-15・M-16)。
 *  - draft 選択 → 確認なし → 保存で PUT answerMode='draft' + 他フィールド保持
 *  - auto 選択 → 行内確認 (M-16 / window.confirm 不使用) → 「自動送信にする」→ 保存で PUT answerMode='auto'
 *  - auto 選択 → 「やめる」→ PUT 未発火 (誤クリックで自動送信化しない = 安全方向)
 *  - GET 応答の answerMode が UI に反映される (draft / auto)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'

const m = vi.hoisted(() => ({
  list: vi.fn(), unmatched: vi.fn(), settingsGet: vi.fn(), settingsPut: vi.fn(), accountId: 'acc-1',
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: m.accountId, accounts: [] }) }))
vi.mock('@/components/layout/header', () => ({ default: () => <div data-testid="legacy-page-header" /> }))
vi.mock('@/components/faqs/edit-dialog', () => ({ default: () => <div data-testid="faq-edit-dialog" /> }))
vi.mock('@/components/faqs/bulk-import-dialog', () => ({ default: () => <div data-testid="faq-bulk-dialog" /> }))
vi.mock('@/lib/api', () => ({ api: {
  faqs: {
    list: (...a: unknown[]) => m.list(...a),
    unmatched: (...a: unknown[]) => m.unmatched(...a),
    settings: {
      get: (...a: unknown[]) => m.settingsGet(...a),
      put: (...a: unknown[]) => m.settingsPut(...a),
    },
  },
} }))

import FaqsPage from './page'
import { AutoReplyCenterEmbed } from '@/components/auto-reply-center/embed-context'

// GET が返す既存設定 (answerMode 以外の全フィールドが埋まっている状態)。
const baseSettings = (answerMode: 'auto' | 'draft') => ({
  enabled: true,
  threshold: 0.72,
  handoffMessage: '担当者より順次ご返信します',
  autoReplyNotice: '※この返信は自動応答です',
  maxRepliesPerDay: 7,
  answerMode,
  personalContext: {
    enabled: true,
    selectedCustomFieldIds: null,
    includeFormAnswers: true,
    maxTokens: 1200,
  },
})

const openSettingsTab = async (answerMode: 'auto' | 'draft') => {
  m.list.mockResolvedValue({ success: true, data: [] })
  m.unmatched.mockResolvedValue({ success: true, data: [] })
  m.settingsGet.mockResolvedValue({ success: true, data: baseSettings(answerMode) })
  m.settingsPut.mockResolvedValue({ success: true, data: baseSettings(answerMode) })
  render(<FaqsPage />)
  // 設定は非同期 load 後に反映される。タブ切替。
  await waitFor(() => expect(m.settingsGet).toHaveBeenCalled())
  fireEvent.click(screen.getByText('設定'))
}

beforeEach(() => { vi.clearAllMocks(); m.accountId = 'acc-1' })
afterEach(() => { cleanup() })

describe('/faqs 設定タブ — 回答モード切替 (下書き / 自動送信)', () => {
  it('center埋め込み時は設定tabへ直着地し、旧page headerを重ねない', async () => {
    m.list.mockResolvedValue({ success: true, data: [] })
    m.unmatched.mockResolvedValue({ success: true, data: [] })
    m.settingsGet.mockResolvedValue({ success: true, data: baseSettings('draft') })
    m.settingsPut.mockResolvedValue({ success: true, data: baseSettings('draft') })

    render(
      <AutoReplyCenterEmbed hideHeader faqInitialTab="settings">
        <FaqsPage />
      </AutoReplyCenterEmbed>,
    )

    await waitFor(() => expect(screen.getByText('この LINE アカウントで自動応答を使う')).toBeTruthy())
    expect(screen.queryByTestId('legacy-page-header')).toBeNull()
    expect(screen.queryByText('まだ「よくある質問」がありません')).toBeNull()
    expect(screen.queryByText('いまのところ、答えられなかった質問はありません。')).toBeNull()
  })

  it('centerのナレッジ埋め込みでもFAQの追加・まとめて登録へ到達できる', async () => {
    m.list.mockResolvedValue({ success: true, data: [] })
    m.unmatched.mockResolvedValue({ success: true, data: [] })
    m.settingsGet.mockResolvedValue({ success: true, data: baseSettings('draft') })

    render(
      <AutoReplyCenterEmbed hideHeader faqInitialTab="faqs" faqTabs={['faqs', 'unmatched']}>
        <FaqsPage />
      </AutoReplyCenterEmbed>,
    )

    await waitFor(() => expect(screen.getByText('まだ「よくある質問」がありません')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '+ 質問を追加' }))
    expect(screen.getByTestId('faq-edit-dialog')).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'まとめて登録' })[0])
    expect(screen.getByTestId('faq-bulk-dialog')).toBeTruthy()
    expect(screen.queryByTestId('legacy-page-header')).toBeNull()
  })

  it('GET が draft のとき「下書き」が見た目とARIAでも選択中になる', async () => {
    await openSettingsTab('draft')
    await waitFor(() => expect(screen.getByText(/草案を作るだけ/)).toBeTruthy())
    const selected = screen.getByRole('button', { name: '下書きにする' })
    const other = screen.getByRole('button', { name: '自動で送信する' })
    expect(selected.getAttribute('aria-pressed')).toBe('true')
    expect(other.getAttribute('aria-pressed')).toBe('false')
    expect(selected.classList.contains('border-green-500')).toBe(true)
    expect(selected.classList.contains('bg-green-50')).toBe(true)
    expect(other.classList.contains('border-green-500')).toBe(false)
  })

  it('GET が auto のとき「自動送信」が見た目とARIAでも選択中になる', async () => {
    await openSettingsTab('auto')
    await waitFor(() => expect(screen.getByText(/自動で返信します/)).toBeTruthy())
    const selected = screen.getByRole('button', { name: '自動で送信する' })
    const other = screen.getByRole('button', { name: '下書きにする' })
    expect(selected.getAttribute('aria-pressed')).toBe('true')
    expect(other.getAttribute('aria-pressed')).toBe('false')
    expect(selected.classList.contains('border-green-500')).toBe(true)
    expect(selected.classList.contains('bg-green-50')).toBe(true)
    expect(other.classList.contains('border-green-500')).toBe(false)
  })

  it('下書き選択 → 確認なし → 保存で PUT answerMode=draft + 他フィールド保持', async () => {
    await openSettingsTab('auto')
    fireEvent.click(await screen.findByText('下書きにする'))
    const draftButton = screen.getByRole('button', { name: '下書きにする' })
    expect(draftButton.getAttribute('aria-pressed')).toBe('true')
    expect(draftButton.classList.contains('border-green-500')).toBe(true)
    // 下書きは安全方向 → 行内確認は出ない。
    expect(screen.queryByText('自動送信にする')).toBeNull()
    fireEvent.click(screen.getByText('設定を保存'))
    await waitFor(() => expect(m.settingsPut).toHaveBeenCalledTimes(1))
    expect(m.settingsPut).toHaveBeenCalledWith({
      accountId: 'acc-1',
      enabled: true,
      threshold: 0.72,
      handoffMessage: '担当者より順次ご返信します',
      autoReplyNotice: '※この返信は自動応答です',
      maxRepliesPerDay: 7,
      answerMode: 'draft',
      personalContext: {
        enabled: true,
        selectedCustomFieldIds: null,
        includeFormAnswers: true,
        maxTokens: 1200,
      },
    })
  })

  it('自動送信選択 → 行内確認 → 「自動送信にする」→ 保存で PUT answerMode=auto', async () => {
    await openSettingsTab('draft')
    fireEvent.click(await screen.findByText('自動で送信する'))
    // 行内確認 (M-16) が出る。確認前は state 未変更。
    const confirmBtn = await screen.findByText('自動送信にする')
    fireEvent.click(confirmBtn)
    const autoButton = screen.getByRole('button', { name: '自動で送信する' })
    expect(autoButton.getAttribute('aria-pressed')).toBe('true')
    expect(autoButton.classList.contains('border-green-500')).toBe(true)
    fireEvent.click(screen.getByText('設定を保存'))
    await waitFor(() => expect(m.settingsPut).toHaveBeenCalledTimes(1))
    expect(m.settingsPut).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acc-1', answerMode: 'auto', threshold: 0.72, maxRepliesPerDay: 7 }),
    )
  })

  it('自動送信選択 → 「やめる」→ PUT 未発火 (誤クリックで自動送信化しない)', async () => {
    await openSettingsTab('draft')
    fireEvent.click(await screen.findByText('自動で送信する'))
    fireEvent.click(await screen.findByText('やめる'))
    // 確認をキャンセルしただけでは PUT は飛ばない。
    expect(m.settingsPut).not.toHaveBeenCalled()
    // キャンセル後に保存すると draft のまま (auto へ切り替わっていない)。
    fireEvent.click(screen.getByText('設定を保存'))
    await waitFor(() => expect(m.settingsPut).toHaveBeenCalledTimes(1))
    expect(m.settingsPut).toHaveBeenCalledWith(expect.objectContaining({ answerMode: 'draft' }))
  })

  it('回答モードを触らず保存すると GET の answerMode がそのまま保持される (勝手に auto 化しない)', async () => {
    await openSettingsTab('draft')
    fireEvent.click(await screen.findByText('設定を保存'))
    await waitFor(() => expect(m.settingsPut).toHaveBeenCalledTimes(1))
    expect(m.settingsPut).toHaveBeenCalledWith(expect.objectContaining({ answerMode: 'draft' }))
  })

  it('確認パネルを開いたまま account を切り替えるとパネルが reset される (cross-account 誤 auto 化防止 / F-STALE-1)', async () => {
    m.list.mockResolvedValue({ success: true, data: [] })
    m.unmatched.mockResolvedValue({ success: true, data: [] })
    m.settingsGet.mockResolvedValue({ success: true, data: baseSettings('draft') })
    m.settingsPut.mockResolvedValue({ success: true, data: baseSettings('draft') })
    const { rerender } = render(<FaqsPage />)
    await waitFor(() => expect(m.settingsGet).toHaveBeenCalled())
    fireEvent.click(screen.getByText('設定'))
    // account A で確認パネルを開く。
    fireEvent.click(await screen.findByText('自動で送信する'))
    expect(screen.getByText('自動送信にする')).toBeTruthy()
    // sidebar で account B へ切替 (load() 再実行)。
    m.accountId = 'acc-2'
    rerender(<FaqsPage />)
    // 確認パネルが消え、B が誤って auto 化する PUT は飛ばない。
    await waitFor(() => expect(screen.queryByText('自動送信にする')).toBeNull())
    expect(m.settingsPut).not.toHaveBeenCalled()
  })
})
