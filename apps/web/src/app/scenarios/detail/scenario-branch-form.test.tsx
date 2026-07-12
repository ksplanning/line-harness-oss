// @vitest-environment jsdom
/**
 * T-A5 (scenario-visual-p2-branch slice-1) — ステップ編集フォームの分岐欄。
 *
 * scenario-condition-help.test.tsx の stub パターンを踏襲し、重い子/依存を stub 化して配置と保存契約を検証する:
 *  1. 分岐欄（条件の種類 select）がステップフォームに描画される。
 *  2. 回答条件（metadata_equals）+ 飛び先（前方 step_order）を選んで保存すると、updateStep が
 *     conditionType / conditionValue(JSON) / nextStepOnFalse 付きの引数で呼ばれる。
 *  3. 飛び先の候補は「現ステップより後ろの step_order」だけ（後方ループ/ dangling を構造排除）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'

const scenario = {
  id: 's1', name: 'テスト', description: '', triggerType: 'manual', isActive: true, deliveryMode: 'relative',
  createdAt: '2026-07-12T00:00:00.000', updatedAt: '2026-07-12T00:00:00.000',
  steps: [
    { id: 'st1', scenarioId: 's1', stepOrder: 1, delayMinutes: 0, offsetDays: null, offsetMinutes: null, deliveryTime: null, messageType: 'text', messageContent: 'ステップ1', templateId: null, onReachTagId: null, conditionType: null, conditionValue: null, nextStepOnFalse: null, createdAt: '2026-07-12T00:00:00.000' },
    { id: 'st2', scenarioId: 's1', stepOrder: 2, delayMinutes: 0, offsetDays: null, offsetMinutes: null, deliveryTime: null, messageType: 'text', messageContent: 'ステップ2(Aルート)', templateId: null, onReachTagId: null, conditionType: null, conditionValue: null, nextStepOnFalse: null, createdAt: '2026-07-12T00:00:00.000' },
    { id: 'st3', scenarioId: 's1', stepOrder: 3, delayMinutes: 0, offsetDays: null, offsetMinutes: null, deliveryTime: null, messageType: 'text', messageContent: 'ステップ3(Bルート)', templateId: null, onReachTagId: null, conditionType: null, conditionValue: null, nextStepOnFalse: null, createdAt: '2026-07-12T00:00:00.000' },
  ],
}

// vi.mock factory は先頭へ hoist されるため、mock 関数は vi.hoisted で先に用意する。
const { updateStep } = vi.hoisted(() => ({ updateStep: vi.fn(async () => ({ success: true, data: {} })) }))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }))
vi.mock('@/components/layout/header', () => ({ default: () => null }))
vi.mock('@/components/flex-builder/flex-builder-modal', () => ({ default: () => null }))
vi.mock('@/components/shared/image-uploader', () => ({ default: () => null }))
vi.mock('@/components/flex-preview', () => ({ default: () => null }))
vi.mock('@/lib/api', () => ({
  api: {
    scenarios: {
      get: vi.fn(async () => ({ success: true, data: scenario })),
      stats: vi.fn(async () => ({ success: true, data: null })),
      updateStep,
    },
    templates: { list: vi.fn(async () => ({ success: true, data: [] })) },
    tags: { list: vi.fn(async () => ({ success: true, data: [{ id: 'tag_1', name: 'VIP' }] })) },
  },
}))

import ScenarioDetailClient from './scenario-detail-client'

afterEach(() => { cleanup(); updateStep.mockClear() })

async function openFirstStepEditor() {
  render(<ScenarioDetailClient scenarioId="s1" />)
  // ステップ1のカードを特定し、その中の「編集」ボタンを押す（シナリオ本体の編集と混同しない）。
  const stepCard = (await screen.findByText('ステップ1')).closest('div.border') as HTMLElement
  fireEvent.click(within(stepCard).getByRole('button', { name: '編集' }))
}

describe('T-A5 ステップ編集フォームの分岐欄', () => {
  it('分岐欄（条件の種類）がステップフォームに描画される', async () => {
    await openFirstStepEditor()
    expect(await screen.findByLabelText('分岐条件の種類')).toBeTruthy()
  })

  it('回答条件 + 前方の飛び先を保存すると updateStep が分岐 3 列付きで呼ばれる', async () => {
    await openFirstStepEditor()

    const typeSelect = await screen.findByLabelText('分岐条件の種類')
    fireEvent.change(typeSelect, { target: { value: 'metadata_equals' } })

    fireEvent.change(await screen.findByLabelText('回答の項目名'), { target: { value: 'answer' } })
    fireEvent.change(await screen.findByLabelText('回答の値'), { target: { value: 'A' } })

    // 飛び先候補は step_order 2,3 のみ（現ステップ 1 より後ろ）。step_order 1 は候補に出ない。
    const jumpSelect = (await screen.findByLabelText('不成立のときの飛び先')) as HTMLSelectElement
    const optionValues = Array.from(jumpSelect.options).map((o) => o.value)
    expect(optionValues).toContain('3')
    expect(optionValues).toContain('2')
    expect(optionValues).not.toContain('1')
    fireEvent.change(jumpSelect, { target: { value: '3' } })

    fireEvent.click(screen.getByRole('button', { name: '更新' }))

    await waitFor(() => expect(updateStep).toHaveBeenCalled())
    expect(updateStep).toHaveBeenCalledWith(
      's1',
      'st1',
      expect.objectContaining({
        conditionType: 'metadata_equals',
        conditionValue: JSON.stringify({ key: 'answer', value: 'A' }),
        nextStepOnFalse: 3,
      }),
    )
  })
})
