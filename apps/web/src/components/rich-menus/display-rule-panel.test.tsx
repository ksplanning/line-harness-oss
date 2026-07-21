// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listRules: vi.fn(),
  createRule: vi.fn(),
  updateRule: vi.fn(),
  deleteRule: vi.fn(),
  latestJob: vi.fn(),
  startReapply: vi.fn(),
  options: vi.fn(),
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
      options: (...args: unknown[]) => mocks.options(...args),
    },
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
  activeFrom: null,
  activeUntil: null,
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
  mocks.options.mockResolvedValue({ success: true, data: {
    tags: [
      { id: 'tag-vip', name: 'VIP' },
      { id: 'tag-paid', name: '購入済み' },
    ],
    fields: [
      { id: 'field-rank', name: '会員ランク', defaultValue: '', displayOrder: 0, isActive: true },
    ],
  } })
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
    expect(within(screen.getByText('停止中ルール').closest('article')!).getByText('期間内（停止中）')).toBeTruthy()
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
      activeFrom: null,
      activeUntil: null,
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
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-21T10:02:00+09:00'))
    mocks.latestJob.mockResolvedValue({
      success: true,
      data: {
        id: 'job-1', accountId: 'acc-1', status: 'running', totalCount: 30, processedCount: 12,
        appliedCount: 6, foreignUnlinkedCount: 2, skippedCount: 3, failedCount: 1, lastFriendId: 'f12',
        createdAt: '2026-07-21T10:00:00.000', updatedAt: '2026-07-21T10:02:00.000', completedAt: null,
      },
    })
    render(<DisplayRulePanel accountId="acc-1" menus={[]} />)

    expect(await screen.findByText('12 / 30人')).toBeTruthy()
    expect(screen.getByText('LINE受付 6・個別固定を解除 2・変更なし 3・失敗 1')).toBeTruthy()
    expect(screen.getByText('一括処理の残り 18人')).toBeTruthy()
    expect(screen.getByText(/実測ペースによる概算完了.*7月21日.*10:05ごろ/)).toBeTruthy()
    expect(screen.getByText(/個別再試行後に確定したエラー/)).toBeTruthy()
    expect(screen.queryByText(/5分ごとに最大20人ずつ/)).toBeNull()
    expect(screen.getByText(/最大500人ずつ/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '既存の友だちへ再適用中' }).hasAttribute('disabled')).toBe(true)
    now.mockRestore()
  })

  test('shows the remaining count but no invented ETA before any friend is processed', async () => {
    mocks.latestJob.mockResolvedValue({
      success: true,
      data: {
        id: 'job-1', accountId: 'acc-1', status: 'running', totalCount: 1450, processedCount: 0,
        appliedCount: 0, skippedCount: 0, failedCount: 0, lastFriendId: null,
        createdAt: '2026-07-21T10:00:00.000', updatedAt: '2026-07-21T10:00:00.000', completedAt: null,
      },
    })

    render(<DisplayRulePanel accountId="acc-1" menus={[]} />)

    expect(await screen.findByText('一括処理の残り 1,450人')).toBeTruthy()
    expect(screen.getByText('LINE受付 0・個別固定を解除 0・変更なし 0・失敗 0')).toBeTruthy()
    expect(screen.getByText('概算完了は、処理実績ができ次第表示します。')).toBeTruthy()
    expect(screen.queryByText(/ごろ/)).toBeNull()
  })

  test('does not invent an ETA while completed rows still have queued reevaluation work', async () => {
    mocks.latestJob.mockResolvedValue({
      success: true,
      data: {
        id: 'job-1', accountId: 'acc-1', status: 'running', totalCount: 30, processedCount: 30,
        appliedCount: 29, skippedCount: 0, failedCount: 1, lastFriendId: 'f30',
        createdAt: '2026-07-21T10:00:00.000', updatedAt: '2026-07-21T10:02:00.000', completedAt: null,
      },
    })

    render(<DisplayRulePanel accountId="acc-1" menus={[]} />)

    expect(await screen.findByText('一括処理の残り 0人')).toBeTruthy()
    expect(screen.getByText('追加の再評価を処理中です。概算完了はまだ確定できません。')).toBeTruthy()
    expect(screen.queryByText(/ごろ/)).toBeNull()
  })

  test('creates an optional period as explicit JST and sends null for an empty bound', async () => {
    render(<DisplayRulePanel accountId="acc-1" menus={[{ richMenuId: 'menu-vip', name: 'VIPメニュー' }]} />)
    await screen.findByText('表示条件ルール')
    fireEvent.click(screen.getByRole('button', { name: 'ルールを追加' }))

    fireEvent.change(screen.getByLabelText('ルール名'), { target: { value: '夏キャンペーン' } })
    fireEvent.change(screen.getByLabelText('いつから（任意）'), { target: { value: '2026-07-20T10:00' } })
    fireEvent.change(screen.getByLabelText('いつまで（任意）'), { target: { value: '2026-07-31T18:00' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.createRule).toHaveBeenCalledWith('acc-1', expect.objectContaining({
      activeFrom: '2026-07-20T10:00:00+09:00',
      activeUntil: '2026-07-31T18:00:00+09:00',
    })))
  })

  test('rejects an end before the start in Japanese without calling the API', async () => {
    render(<DisplayRulePanel accountId="acc-1" menus={[{ richMenuId: 'menu-vip', name: 'VIPメニュー' }]} />)
    await screen.findByText('表示条件ルール')
    fireEvent.click(screen.getByRole('button', { name: 'ルールを追加' }))

    fireEvent.change(screen.getByLabelText('ルール名'), { target: { value: '逆転期間' } })
    fireEvent.change(screen.getByLabelText('いつから（任意）'), { target: { value: '2026-07-20T18:00' } })
    fireEvent.change(screen.getByLabelText('いつまで（任意）'), { target: { value: '2026-07-20T10:00' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    expect(await screen.findByText('終了日時は開始日時以降にしてください。')).toBeTruthy()
    expect(mocks.createRule).not.toHaveBeenCalled()
  })

  test('round-trips stored UTC bounds through Japanese datetime inputs while editing', async () => {
    mocks.listRules.mockResolvedValue({ success: true, data: [rule({
      activeFrom: '2026-07-20T01:00:00.000Z',
      activeUntil: '2026-07-20T09:00:00.000Z',
    })] })
    render(<DisplayRulePanel accountId="acc-1" menus={[{ richMenuId: 'menu-vip', name: 'VIPメニュー' }]} />)
    await screen.findByText('表示条件ルール')
    fireEvent.click(screen.getByRole('button', { name: '編集' }))

    expect((screen.getByLabelText('いつから（任意）') as HTMLInputElement).value).toBe('2026-07-20T10:00')
    expect((screen.getByLabelText('いつまで（任意）') as HTMLInputElement).value).toBe('2026-07-20T18:00')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(mocks.updateRule).toHaveBeenCalledWith(
      'acc-1',
      'rule-high',
      expect.objectContaining({
        activeFrom: '2026-07-20T10:00:00+09:00',
        activeUntil: '2026-07-20T18:00:00+09:00',
      }),
    ))
  })

  test('shows current, upcoming, ended, and unlimited periods and ranks only current rules', async () => {
    const now = Date.now()
    mocks.listRules.mockResolvedValue({ success: true, data: [
      rule({ id: 'future', name: '開始前ルール', priority: 500, activeFrom: new Date(now + 3_600_000).toISOString() }),
      rule({ id: 'ended', name: '終了済みルール', priority: 400, activeUntil: new Date(now - 3_600_000).toISOString() }),
      rule({
        id: 'current', name: '期間内ルール', priority: 100,
        activeFrom: new Date(now - 3_600_000).toISOString(),
        activeUntil: new Date(now + 3_600_000).toISOString(),
      }),
      rule({ id: 'unlimited', name: '無期限ルール', priority: 50 }),
    ] })
    render(<DisplayRulePanel accountId="acc-1" menus={[{ richMenuId: 'menu-vip', name: 'VIPメニュー' }]} />)
    await screen.findByText('表示条件ルール')

    expect(screen.getByText('開始前')).toBeTruthy()
    expect(screen.getByText('終了済み')).toBeTruthy()
    expect(screen.getAllByText('今有効')).toHaveLength(2)
    expect(screen.getByText('期間: 無期限')).toBeTruthy()
    expect(screen.getAllByText('期間外（勝敗対象外）')).toHaveLength(2)
    expect(within(screen.getByText('期間内ルール').closest('article')!).getByText('候補1位')).toBeTruthy()
    expect(within(screen.getByText('無期限ルール').closest('article')!).getByText('候補2位')).toBeTruthy()
  })
})
