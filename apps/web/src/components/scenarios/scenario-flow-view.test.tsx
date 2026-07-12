// @vitest-environment jsdom
/**
 * T-A3/T-A4/T-A5/T-A7 — scenario-flow-view の jsdom component test（chrome wedge 代替: DOM 層）。
 * 検証: node 数=steps+2 / trigger・goal ノード presence / SVG path（順次・分岐）presence /
 *       種別・内容要約・待機・タグ付与・条件 バッジ / 分岐 edge のラベル + 対象到達 /
 *       ランタイム乖離の凡例注記 / 空・1ステップ端。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, within } from '@testing-library/react'
import type { Scenario } from '@line-crm/shared'
import type { BranchedScenarioStep, ScenarioWithBranchSteps } from '@/lib/scenario-graph'
import ScenarioFlowView from './scenario-flow-view'

function mkStep(partial: Partial<BranchedScenarioStep>): BranchedScenarioStep {
  return {
    id: `step-${partial.stepOrder ?? 1}`,
    scenarioId: 'sc1',
    stepOrder: 1,
    delayMinutes: 0,
    offsetDays: null,
    offsetMinutes: null,
    deliveryTime: null,
    templateId: null,
    onReachTagId: null,
    messageType: 'text',
    messageContent: 'こんにちは',
    conditionType: null,
    conditionValue: null,
    nextStepOnFalse: null,
    createdAt: '2026-07-12T00:00:00.000',
    ...partial,
  }
}

function mkScenario(steps: BranchedScenarioStep[], overrides: Partial<Scenario> = {}): ScenarioWithBranchSteps {
  return {
    id: 'sc1',
    name: 'ようこそシナリオ',
    description: null,
    triggerType: 'friend_add',
    triggerTagId: null,
    lineAccountId: null,
    isActive: true,
    deliveryMode: 'relative',
    createdAt: '2026-07-12T00:00:00.000',
    updatedAt: '2026-07-12T00:00:00.000',
    ...overrides,
    steps,
  }
}

afterEach(() => cleanup())

describe('ScenarioFlowView — 骨格（T-A3）', () => {
  it('trigger 起点 / goal 終端ノードがあり node 数 = steps+2', () => {
    const { container } = render(
      <ScenarioFlowView scenario={mkScenario([mkStep({ stepOrder: 1 }), mkStep({ stepOrder: 2, delayMinutes: 30 })])} />,
    )
    const nodes = container.querySelectorAll('[data-node-kind]')
    expect(nodes).toHaveLength(4) // trigger + 2 step + goal
    expect(container.querySelector('[data-node-kind="trigger"]')).not.toBeNull()
    expect(container.querySelector('[data-node-kind="goal"]')).not.toBeNull()
    // 順次エッジは SVG path（trigger→s1→s2→goal = 3 本）
    const seq = container.querySelectorAll('path[data-edge-kind="sequential"]')
    expect(seq).toHaveLength(3)
  })

  it('native scroll（Lenis 慣性を持ち込まない = data-native-scroll コンテナ）', () => {
    const { container } = render(<ScenarioFlowView scenario={mkScenario([mkStep({ stepOrder: 1 })])} />)
    expect(container.querySelector('[data-native-scroll]')).not.toBeNull()
  })
})

describe('ScenarioFlowView — ノードのバッジ（T-A4）', () => {
  it('種別 / 内容要約 / 待機 / タグ付与 / 条件 バッジが出る', () => {
    const { container } = render(
      <ScenarioFlowView
        scenario={mkScenario([
          mkStep({
            stepOrder: 1,
            delayMinutes: 60,
            messageType: 'text',
            messageContent: 'キャンペーンのお知らせ',
            onReachTagId: 'tag-vip',
            conditionType: 'tag_exists',
            conditionValue: 'tag-friend',
          }),
        ])}
      />,
    )
    const stepNode = container.querySelector('[data-node-kind="step"]') as HTMLElement
    const node = within(stepNode)
    expect(node.getByText('テキスト')).toBeTruthy() // 種別バッジ
    expect(node.getByText('キャンペーンのお知らせ')).toBeTruthy() // 内容要約
    expect(node.getByText(/タグ付与/)).toBeTruthy() // 到達時タグ付与バッジ
    expect(node.getByText('指定タグを持つ場合のみ')).toBeTruthy() // 条件バッジ
    // 待機ラベルは trigger→step のエッジ pill に載る（1時間後）
    expect(screen.getByText('1時間後')).toBeTruthy()
  })

  it('flex / image は種別に応じた要約', () => {
    const { container } = render(
      <ScenarioFlowView scenario={mkScenario([mkStep({ stepOrder: 1, messageType: 'flex', messageContent: '{}' })])} />,
    )
    const stepNode = container.querySelector('[data-node-kind="step"]') as HTMLElement
    expect(within(stepNode).getByText('Flex メッセージ')).toBeTruthy()
  })
})

describe('ScenarioFlowView — 分岐エッジ（T-A5）', () => {
  it('next_step_on_false から対象ノードへ「条件不成立時」ラベル付き分岐 path が描かれる', () => {
    const { container } = render(
      <ScenarioFlowView
        scenario={mkScenario([
          mkStep({ stepOrder: 1, conditionType: 'tag_exists', conditionValue: 'tag-x', nextStepOnFalse: 3 }),
          mkStep({ stepOrder: 2 }),
          mkStep({ stepOrder: 3 }),
        ])}
      />,
    )
    const branch = container.querySelector('path[data-edge-kind="branch"]') as SVGPathElement
    expect(branch).not.toBeNull()
    // 対象 step_order=3 のノード id を指す
    expect(branch.getAttribute('data-to')).toBe('step-3')
    expect(screen.getByText('条件不成立時')).toBeTruthy()
  })

  it('ランタイム乖離（L3）の凡例注記が表示される', () => {
    render(
      <ScenarioFlowView
        scenario={mkScenario([mkStep({ stepOrder: 1, conditionType: 'tag_exists', nextStepOnFalse: 1 })])}
      />,
    )
    expect(screen.getByText(/実配信.*ステップ順|Phase|要修正/)).toBeTruthy()
  })
})

describe('ScenarioFlowView — 端条件（T-A7）', () => {
  it('0 step: trigger + goal のみ（2 node）+ trigger→goal 順次 path', () => {
    const { container } = render(<ScenarioFlowView scenario={mkScenario([])} />)
    expect(container.querySelectorAll('[data-node-kind]')).toHaveLength(2)
    const seq = container.querySelectorAll('path[data-edge-kind="sequential"]')
    expect(seq).toHaveLength(1)
    expect(seq[0].getAttribute('data-from')).toBe('trigger')
    expect(seq[0].getAttribute('data-to')).toBe('goal')
  })

  it('1 step: node=3, 分岐なし', () => {
    const { container } = render(<ScenarioFlowView scenario={mkScenario([mkStep({ stepOrder: 1 })])} />)
    expect(container.querySelectorAll('[data-node-kind]')).toHaveLength(3)
    expect(container.querySelectorAll('path[data-edge-kind="branch"]')).toHaveLength(0)
  })
})
