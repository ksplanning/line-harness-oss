// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listRules: vi.fn(),
  createRule: vi.fn(),
  updateRule: vi.fn(),
  deleteRule: vi.fn(),
  latestJob: vi.fn(),
  startReapply: vi.fn(),
  listTags: vi.fn(),
  listFields: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    richMenuDisplayRules: {
      list: (...args: unknown[]) => mocks.listRules(...args),
      create: (...args: unknown[]) => mocks.createRule(...args),
      update: (...args: unknown[]) => mocks.updateRule(...args),
      delete: (...args: unknown[]) => mocks.deleteRule(...args),
      latestJob: (...args: unknown[]) => mocks.latestJob(...args),
      startReapply: (...args: unknown[]) => mocks.startReapply(...args),
    },
    tags: { list: (...args: unknown[]) => mocks.listTags(...args) },
    friendFieldDefinitions: { list: (...args: unknown[]) => mocks.listFields(...args) },
  },
}))

import { DisplayRulePanel } from './display-rule-panel'

const rule = (over: Record<string, unknown> = {}) => ({
  id: 'rule-high',
  accountId: 'acc-1',
  name: 'VIP向け',
  conditionType: 'tag_exists',
  conditionValue: 'tag-vip',
  richMenuId: 'menu-vip',
  priority: 100,
  isActive: true,
  createdAt: '2026-07-19T10:00:00.000',
  updatedAt: '2026-07-19T10:00:00.000',
  ...over,
})

beforeEach(() => {
  mocks.listRules.mockResolvedValue({ success: true, data: [
    rule(),
    rule({ id: 'rule-low', name: '購入済み向け', priority: 10, conditionValue: 'tag-paid' }),
    rule({ id: 'rule-off', name: '停止中ルール', priority: 999, isActive: false }),
  ] })
  mocks.listTags.mockResolvedValue({ success: true, data: [
    { id: 'tag-vip', name: 'VIP' },
    { id: 'tag-paid', name: '購入済み' },
  ] })
  mocks.listFields.mockResolvedValue({ success: true, data: [
    { id: 'field-rank', name: '会員ランク', defaultValue: '', displayOrder: 0, isActive: true },
  ] })
  mocks.latestJob.mockResolvedValue({ success: true, data: null })
  mocks.createRule.mockResolvedValue({ success: true, data: rule({ id: 'created' }) })
  mocks.updateRule.mockResolvedValue({ success: true, data: rule() })
  mocks.deleteRule.mockResolvedValue({ success: true, data: null })
  mocks.startReapply.mockResolvedValue({ success: true, data: null })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('DisplayRulePanel', () => {
  test('makes winner order, tie-break, default fallback, and all eight condition words visible', async () => {
    render(<DisplayRulePanel accountId="acc-1" menus={[{ richMenuId: 'menu-vip', name: 'VIPメニュー' }]} />)

    expect(await screen.findByText('表示条件ルール')).toBeTruthy()
    expect(screen.getByText('候補1位')).toBeTruthy()
    expect(screen.getByText('候補2位')).toBeTruthy()
    expect(screen.getByText('停止中（勝敗対象外）')).toBeTruthy()
    expect(screen.getByText(/優先度の数字が大きいルールが勝ちます/)).toBeTruthy()
    expect(screen.getByText(/同じ数字なら、先に作ったルール、その後はID順/)).toBeTruthy()
    expect(screen.getByText(/どれにも合わない友だちは「全員のデフォルト」/)).toBeTruthy()
    expect(screen.getByText(/ルールはいくつでも追加できます/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'ルールを追加' }))
    for (const label of [
      'タグを持っている', 'タグを持っていない', 'カスタム項目が一致', 'カスタム項目が不一致',
      'カスタム項目に含む', 'カスタム項目に含まない', 'タグ名に含む', 'タグ名に含まない',
    ]) {
      expect(screen.getByRole('option', { name: label })).toBeTruthy()
    }
  })

  test('creates a metadata rule with a numeric priority and explicit active state', async () => {
    render(<DisplayRulePanel accountId="acc-1" menus={[{ richMenuId: 'menu-vip', name: 'VIPメニュー' }]} />)
    await screen.findByText('表示条件ルール')
    fireEvent.click(screen.getByRole('button', { name: 'ルールを追加' }))

    fireEvent.change(screen.getByLabelText('ルール名'), { target: { value: '会員ランクVIP' } })
    fireEvent.change(screen.getByLabelText('条件の種類'), { target: { value: 'metadata_equals' } })
    fireEvent.change(screen.getByLabelText('カスタム項目'), { target: { value: '会員ランク' } })
    fireEvent.change(screen.getByLabelText('比較する値'), { target: { value: 'VIP' } })
    fireEvent.change(screen.getByLabelText('表示するリッチメニュー'), { target: { value: 'menu-vip' } })
    fireEvent.change(screen.getByLabelText('優先度'), { target: { value: '250' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.createRule).toHaveBeenCalledWith('acc-1', {
      name: '会員ランクVIP',
      conditionType: 'metadata_equals',
      conditionValue: JSON.stringify({ key: '会員ランク', value: 'VIP' }),
      richMenuId: 'menu-vip',
      priority: 250,
      isActive: true,
    }))
    expect(screen.getByText(/ルールを変えたため、既存の友だちへ再適用してください/)).toBeTruthy()
  })

  test('edits numeric priority, toggles active state, and deletes a rule', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    render(<DisplayRulePanel accountId="acc-1" menus={[{ richMenuId: 'menu-vip', name: 'VIPメニュー' }]} />)
    await screen.findByText('表示条件ルール')

    fireEvent.click(screen.getAllByRole('button', { name: '編集' })[0])
    fireEvent.change(screen.getByLabelText('優先度'), { target: { value: '300' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(mocks.updateRule).toHaveBeenCalledWith(
      'acc-1',
      'rule-high',
      expect.objectContaining({ priority: 300 }),
    ))

    fireEvent.click(screen.getByRole('button', { name: 'VIP向けを停止' }))
    await waitFor(() => expect(mocks.updateRule).toHaveBeenCalledWith('acc-1', 'rule-high', { isActive: false }))

    fireEvent.click(screen.getAllByRole('button', { name: '削除' })[0])
    await waitFor(() => expect(mocks.deleteRule).toHaveBeenCalledWith('acc-1', 'rule-high'))
  })

  test('shows bounded reapply progress and prevents repeated starts while running', async () => {
    mocks.latestJob.mockResolvedValue({
      success: true,
      data: {
        id: 'job-1', accountId: 'acc-1', status: 'running', totalCount: 30, processedCount: 12,
        appliedCount: 8, skippedCount: 3, failedCount: 1, lastFriendId: 'f12',
        createdAt: '', updatedAt: '', completedAt: null,
      },
    })
    render(<DisplayRulePanel accountId="acc-1" menus={[]} />)

    expect(await screen.findByText('12 / 30人')).toBeTruthy()
    expect(screen.getByText('適用 8・変更なし 3・失敗 1')).toBeTruthy()
    expect(screen.getByText(/5分ごとに最大20人ずつ/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '既存の友だちへ再適用中' }).hasAttribute('disabled')).toBe(true)
  })
})
