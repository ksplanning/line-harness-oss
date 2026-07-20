// @vitest-environment jsdom
/**
 * flex-builder-silent-fail-fix — scenario の Flex 起動回帰。
 * 旧テキストを保持したまま Flex へ切り替えた時の無音 return と、空/有効 Flex の正常経路を固定する。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { buildModelToFlex } from '@/lib/flex-builder/to-flex'

const { getScenarioMock } = vi.hoisted(() => ({ getScenarioMock: vi.fn() }))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-selected' }) }))
vi.mock('@/components/layout/header', () => ({ default: () => null }))
vi.mock('@/components/shared/image-uploader', () => ({ default: () => null }))
vi.mock('@/components/flex-preview', () => ({ default: () => <div data-testid="flex-preview" /> }))
vi.mock('@/components/flex-builder/flex-builder-modal', () => ({
  default: ({ initialModel, onClose }: { initialModel?: unknown; onClose: () => void }) => (
    <div
      role="dialog"
      aria-label="Flexビジュアルビルダー"
      data-initial-model={initialModel ? 'existing' : 'empty'}
    >
      <button type="button" onClick={onClose}>ビルダーを閉じる</button>
    </div>
  ),
}))
vi.mock('@/components/shared/test-send-dialog', () => ({
  default: ({ accountIds, source, messages }: {
    accountIds: string[]
    source: string
    messages: Array<{ type: string; content: string }>
  }) => (
    <button
      type="button"
      data-testid="scenario-test-send"
      data-account-ids={accountIds.join(',')}
      data-source={source}
      data-messages={JSON.stringify(messages)}
    >
      テスト送信
    </button>
  ),
}))
vi.mock('@/lib/api', () => ({
  api: {
    scenarios: {
      get: (...args: unknown[]) => getScenarioMock(...args),
      stats: vi.fn(async () => ({ success: true, data: null })),
    },
    templates: { list: vi.fn(async () => ({ success: true, data: [] })) },
    tags: { list: vi.fn(async () => ({ success: true, data: [] })) },
  },
}))

import ScenarioDetailClient from './scenario-detail-client'

const oldText = '切替前のテキスト本文'
const rebuildPrompt = '今の本文はそのままではビジュアル編集できません。新しくビジュアルで作り直しますか？（今のテキストは破棄されます）'
const rebuildGuidance = '今の本文はそのままではビジュアル編集できません。本文を残す場合は、下の「上級者向け」で編集してください。'

function scenarioWith(messageType: 'text' | 'flex', messageContent: string) {
  return {
    id: 's1',
    name: 'Flex起動テスト',
    description: '',
    triggerType: 'manual',
    isActive: true,
    lineAccountId: 'acc-scenario',
    deliveryMode: 'relative',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    steps: [{
      id: 'st1',
      scenarioId: 's1',
      stepOrder: 1,
      delayMinutes: 0,
      offsetDays: null,
      offsetMinutes: null,
      deliveryTime: null,
      messageType,
      messageContent,
      templateId: null,
      onReachTagId: null,
      conditionType: null,
      conditionValue: null,
      nextStepOnFalse: null,
      createdAt: '2026-07-20T00:00:00.000Z',
    }],
  }
}

async function openStepEditor(textMarker?: string) {
  render(<ScenarioDetailClient scenarioId="s1" />)
  const marker = textMarker
    ? await screen.findByText(textMarker)
    : await screen.findByTestId('flex-preview')
  const stepCard = marker.closest('div.border') as HTMLElement
  fireEvent.click(within(stepCard).getByRole('button', { name: '編集' }))
  await screen.findByText('メッセージタイプ')
}

function selectFlex() {
  const label = screen.getByText('メッセージタイプ')
  const select = label.parentElement?.querySelector('select')
  if (!select) throw new Error('message type select not found')
  fireEvent.change(select, { target: { value: 'flex' } })
}

function closeStepForm() {
  const form = screen.getByText('ステップを編集').closest('div.mb-6') as HTMLElement
  const cancelButtons = within(form).getAllByRole('button', { name: 'キャンセル' })
  fireEvent.click(cancelButtons[cancelButtons.length - 1])
}

beforeEach(() => {
  getScenarioMock.mockReset()
})

afterEach(() => cleanup())

describe('scenario Flex ビルダーの作り直し導線', () => {
  it('旧テキストでは確認を表示し、キャンセル後も本文を保持して赤字ガイダンスを出す', async () => {
    getScenarioMock.mockResolvedValue({ success: true, data: scenarioWith('text', oldText) })
    await openStepEditor(oldText)
    selectFlex()

    fireEvent.click(screen.getByRole('button', { name: /ビジュアルでカードを作る/ }))

    const confirmation = await screen.findByRole('alertdialog', { name: 'Flexを新しく作り直す確認' })
    expect(confirmation.textContent).toContain(rebuildPrompt)
    expect(document.activeElement).toBe(within(confirmation).getByRole('button', { name: '新しく作り直す' }))
    expect(screen.queryByRole('dialog', { name: 'Flexビジュアルビルダー' })).toBeNull()

    fireEvent.click(within(confirmation).getByRole('button', { name: 'キャンセル' }))

    expect((await screen.findByRole('alert')).textContent).toBe(rebuildGuidance)
    const advanced = screen.getByPlaceholderText('{"type":"bubble","body":{...}}') as HTMLTextAreaElement
    expect(advanced.value).toBe(oldText)
    expect(screen.queryByRole('dialog', { name: 'Flexビジュアルビルダー' })).toBeNull()
  })

  it('明示的に作り直す時だけ、旧本文を初期値に使わず空のビルダーを開く', async () => {
    getScenarioMock.mockResolvedValue({ success: true, data: scenarioWith('text', oldText) })
    await openStepEditor(oldText)
    selectFlex()
    fireEvent.click(screen.getByRole('button', { name: /ビジュアルでカードを作る/ }))

    const confirmation = await screen.findByRole('alertdialog', { name: 'Flexを新しく作り直す確認' })
    fireEvent.click(within(confirmation).getByRole('button', { name: '新しく作り直す' }))

    const modal = await screen.findByRole('dialog', { name: 'Flexビジュアルビルダー' })
    expect(modal.getAttribute('data-initial-model')).toBe('empty')
  })

  it('未処理の確認を残してフォームを閉じても、新しいステップへ確認状態を持ち越さない', async () => {
    getScenarioMock.mockResolvedValue({ success: true, data: scenarioWith('text', oldText) })
    await openStepEditor(oldText)
    selectFlex()
    fireEvent.click(screen.getByRole('button', { name: /ビジュアルでカードを作る/ }))
    await screen.findByRole('alertdialog', { name: 'Flexを新しく作り直す確認' })

    closeStepForm()
    fireEvent.click(screen.getByRole('button', { name: /ステップ追加/ }))
    selectFlex()

    expect(screen.queryByRole('alertdialog', { name: 'Flexを新しく作り直す確認' })).toBeNull()
  })

  it('キャンセル後の赤字案内と上級者欄を、新しいステップへ持ち越さない', async () => {
    getScenarioMock.mockResolvedValue({ success: true, data: scenarioWith('text', oldText) })
    await openStepEditor(oldText)
    selectFlex()
    fireEvent.click(screen.getByRole('button', { name: /ビジュアルでカードを作る/ }))
    const confirmation = await screen.findByRole('alertdialog', { name: 'Flexを新しく作り直す確認' })
    fireEvent.click(within(confirmation).getByRole('button', { name: 'キャンセル' }))
    await screen.findByRole('alert')

    closeStepForm()
    fireEvent.click(screen.getByRole('button', { name: /ステップ追加/ }))
    selectFlex()

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByPlaceholderText('{"type":"bubble","body":{...}}')).toBeNull()
  })
})

describe('scenario Flex ビルダーの正常経路', () => {
  it('新規の空ステップは確認なしで空のビルダーを開く', async () => {
    getScenarioMock.mockResolvedValue({ success: true, data: scenarioWith('text', oldText) })
    render(<ScenarioDetailClient scenarioId="s1" />)
    await screen.findByText('Flex起動テスト')
    fireEvent.click(screen.getByRole('button', { name: /ステップ追加/ }))
    selectFlex()

    fireEvent.click(screen.getByRole('button', { name: /ビジュアルでカードを作る/ }))

    expect(screen.queryByRole('alertdialog', { name: 'Flexを新しく作り直す確認' })).toBeNull()
    expect((await screen.findByRole('dialog', { name: 'Flexビジュアルビルダー' })).getAttribute('data-initial-model')).toBe('empty')
  })

  it('有効な Flex JSON は確認なしで復元モデルを渡して開く', async () => {
    const validFlex = JSON.stringify(buildModelToFlex({
      cards: [{ id: 'card-1', parts: [{ kind: 'body', id: 'body-1', text: '有効なカード' }] }],
    }))
    getScenarioMock.mockResolvedValue({ success: true, data: scenarioWith('flex', validFlex) })
    await openStepEditor()

    fireEvent.click(screen.getByRole('button', { name: /カードを編集/ }))

    expect(screen.queryByRole('alertdialog', { name: 'Flexを新しく作り直す確認' })).toBeNull()
    expect((await screen.findByRole('dialog', { name: 'Flexビジュアルビルダー' })).getAttribute('data-initial-model')).toBe('existing')
  })
})

describe('scenario ステップのテスト送信', () => {
  it('友だち追加シナリオの特定ステップを greeting としてそのアカウントへ渡す', async () => {
    getScenarioMock.mockResolvedValue({
      success: true,
      data: { ...scenarioWith('text', '登録ありがとうございます'), triggerType: 'friend_add' },
    })

    render(<ScenarioDetailClient scenarioId="s1" />)

    const button = await screen.findByTestId('scenario-test-send')
    expect(button.getAttribute('data-account-ids')).toBe('acc-scenario')
    expect(button.getAttribute('data-source')).toBe('greeting')
    expect(JSON.parse(button.getAttribute('data-messages') ?? '[]')).toEqual([
      { type: 'text', content: '登録ありがとうございます' },
    ])
  })

  it('通常シナリオの特定ステップは scenario として渡す', async () => {
    getScenarioMock.mockResolvedValue({ success: true, data: scenarioWith('text', '通常ステップ') })
    render(<ScenarioDetailClient scenarioId="s1" />)

    const button = await screen.findByTestId('scenario-test-send')
    expect(button.getAttribute('data-source')).toBe('scenario')
    expect(JSON.parse(button.getAttribute('data-messages') ?? '[]')).toEqual([
      { type: 'text', content: '通常ステップ' },
    ])
  })
})
