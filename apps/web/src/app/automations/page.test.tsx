// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'acc-1', loading: false }),
}))

vi.mock('@/components/layout/header', () => ({
  default: ({ title, action }: { title: string; action: React.ReactNode }) => (
    <header><h1>{title}</h1>{action}</header>
  ),
}))

vi.mock('@/components/cc-prompt-button', () => ({ default: () => null }))

vi.mock('@/lib/api', () => ({
  api: {
    automations: {
      list: (...args: unknown[]) => mocks.list(...args),
      create: (...args: unknown[]) => mocks.create(...args),
      update: (...args: unknown[]) => mocks.update(...args),
      delete: (...args: unknown[]) => mocks.delete(...args),
    },
  },
}))

import AutomationsPage from './page'

const validRule = {
  id: 'rule-1',
  name: '資料請求ルール',
  description: '資料請求を受け付ける',
  eventType: 'message_received',
  conditions: { keyword: '資料' },
  actions: [{ type: 'add_tag', params: { tagId: 'tag-doc' } }],
  conditionsJson: '{\n  "keyword": "資料"\n}',
  actionsJson: '[\n  {"type":"add_tag","params":{"tagId":"tag-doc"}}\n]',
  jsonIssues: [],
  lineAccountId: 'acc-1',
  isActive: true,
  priority: 10,
  createdAt: '2026-07-21T00:00:00.000Z',
  updatedAt: '2026-07-21T00:00:00.000Z',
}

beforeEach(() => {
  mocks.list.mockResolvedValue({ success: true, data: [validRule] })
  mocks.create.mockResolvedValue({ success: true, data: validRule })
  mocks.update.mockResolvedValue({ success: true, data: validRule })
  mocks.delete.mockResolvedValue({ success: true, data: null })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('AutomationsPage GUI builder', () => {
  it('does not PUT an untouched rule, then sends only changed metadata', async () => {
    render(<AutomationsPage />)
    const card = (await screen.findByText('資料請求ルール')).closest('article')!

    fireEvent.click(within(card).getByRole('button', { name: '編集' }))
    fireEvent.click(screen.getByRole('button', { name: '変更を保存' }))
    expect(mocks.update).not.toHaveBeenCalled()

    fireEvent.click(within(card).getByRole('button', { name: '編集' }))
    fireEvent.change(screen.getByLabelText('ルール名'), { target: { value: '資料請求ルール改' } })
    fireEvent.click(screen.getByRole('button', { name: '変更を保存' }))

    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('rule-1', { name: '資料請求ルール改' }))
    const payload = mocks.update.mock.calls[0][1]
    expect(payload).not.toHaveProperty('conditions')
    expect(payload).not.toHaveProperty('actions')
  })

  it('creates an account-scoped rule with multiple GUI actions', async () => {
    render(<AutomationsPage />)
    await screen.findByText('資料請求ルール')
    fireEvent.click(screen.getByRole('button', { name: '+ 新規ルール' }))

    fireEvent.change(screen.getByLabelText('ルール名'), { target: { value: 'Webhook受付' } })
    fireEvent.change(screen.getByLabelText('アクション 1: タグID'), { target: { value: 'tag-vip' } })
    fireEvent.click(screen.getByRole('button', { name: 'アクションを追加' }))
    fireEvent.change(screen.getByLabelText('アクション 2の種類'), { target: { value: 'send_webhook' } })
    fireEvent.change(screen.getByLabelText('アクション 2: 送信先URL'), { target: { value: 'https://example.test/hook' } })
    fireEvent.click(screen.getByRole('button', { name: '作成' }))

    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith({
      name: 'Webhook受付',
      description: null,
      eventType: 'friend_add',
      conditions: {},
      actions: [
        { type: 'add_tag', params: { tagId: 'tag-vip' } },
        { type: 'send_webhook', params: { url: 'https://example.test/hook' } },
      ],
      priority: 0,
      lineAccountId: 'acc-1',
    }))
  })

  it('deletes a rule and keeps an unknown rule in read-only JSON mode', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    mocks.list.mockResolvedValue({
      success: true,
      data: [{
        ...validRule,
        id: 'future-rule',
        name: '将来形式',
        eventType: 'future_event',
        actions: [],
        actionsJson: '[{"type":"future","params":{}}]',
      }],
    })
    render(<AutomationsPage />)
    const card = (await screen.findByText('将来形式')).closest('article')!

    fireEvent.click(within(card).getByRole('button', { name: '編集' }))
    expect(screen.getByText(/GUI 非対応・JSON のまま保持/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '変更を保存' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }))

    fireEvent.click(within(card).getByRole('button', { name: '削除' }))
    await waitFor(() => expect(mocks.delete).toHaveBeenCalledWith('future-rule'))
  })

  it('keeps a structurally invalid action array visible in fail-safe mode', async () => {
    mocks.list.mockResolvedValue({
      success: true,
      data: [{
        ...validRule,
        id: 'malformed-rule',
        name: '壊れたアクション形式',
        actions: [null],
        actionsJson: '[null]',
        jsonIssues: ['actions_unsupported_shape'],
      }],
    })

    render(<AutomationsPage />)

    const card = (await screen.findByText('壊れたアクション形式')).closest('article')!
    expect(within(card).getByText('GUI非対応')).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: '編集' }))
    expect(screen.getByText(/GUI 非対応・JSON のまま保持/)).toBeTruthy()
    expect((screen.getByLabelText('保持中のアクションJSON') as HTMLTextAreaElement).value).toBe('[null]')
  })
})
