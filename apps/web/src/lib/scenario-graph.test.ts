/**
 * T-A1 — scenario-graph 純関数 normalization の単体テスト。
 * 入力 = Scenario & { steps: BranchedScenarioStep[] }（serializeStep が返す分岐列込みの実データ形）。
 * 出力 = { nodes, edges }。描画に依存しない論理検証（chrome wedge 代替: 論理層）。
 * 不変条件: node 数 = steps + 2（trigger + goal）/ 分岐 edge が対象 step_order を指す / step_order を改変しない。
 */
import { describe, it, expect } from 'vitest'
import type { Scenario } from '@line-crm/shared'
import {
  scenarioToGraph,
  conditionBadgeLabel,
  stepContentSummary,
  type BranchedScenarioStep,
  type ScenarioWithBranchSteps,
} from './scenario-graph'

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
    name: 'テストシナリオ',
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

describe('scenarioToGraph — node 数 = steps + 2', () => {
  it('0 step: trigger + goal のみ（2 node）, trigger→goal の順次 edge', () => {
    const { nodes, edges } = scenarioToGraph(mkScenario([]))
    expect(nodes).toHaveLength(2)
    expect(nodes[0].kind).toBe('trigger')
    expect(nodes[1].kind).toBe('goal')
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ from: 'trigger', to: 'goal', kind: 'sequential' })
  })

  it('1 step: trigger + step + goal（3 node）', () => {
    const { nodes, edges } = scenarioToGraph(mkScenario([mkStep({ stepOrder: 1, delayMinutes: 30 })]))
    expect(nodes).toHaveLength(3)
    expect(nodes.map((n) => n.kind)).toEqual(['trigger', 'step', 'goal'])
    // trigger→step の待機ラベル + step→goal
    const seq = edges.filter((e) => e.kind === 'sequential')
    expect(seq).toHaveLength(2)
    expect(seq[0]).toMatchObject({ from: 'trigger', to: 'step-1', label: '30分後' })
    expect(seq[1]).toMatchObject({ from: 'step-1', to: 'goal' })
  })

  it('3 step 直列: node=5, 順次 edge=4（trigger→s1→s2→s3→goal）', () => {
    const s = scenarioToGraph(
      mkScenario([
        mkStep({ stepOrder: 1 }),
        mkStep({ stepOrder: 2, delayMinutes: 1440 }),
        mkStep({ stepOrder: 3, delayMinutes: 60 }),
      ]),
    )
    expect(s.nodes).toHaveLength(5)
    const seq = s.edges.filter((e) => e.kind === 'sequential')
    expect(seq).toHaveLength(4)
    expect(seq.map((e) => `${e.from}->${e.to}`)).toEqual([
      'trigger->step-1',
      'step-1->step-2',
      'step-2->step-3',
      'step-3->goal',
    ])
    // 待機ラベルは「到着ステップ」の配信タイミング（step-2 は 1440分=1日後）
    expect(seq[1].label).toBe('1日後')
  })
})

describe('scenarioToGraph — 分岐 edge', () => {
  it('next_step_on_false が対象 step_order ノードを指し、条件不成立時ラベルが載る', () => {
    const { edges, nodes } = scenarioToGraph(
      mkScenario([
        mkStep({ stepOrder: 1, conditionType: 'tag_exists', conditionValue: 'tag-x', nextStepOnFalse: 3 }),
        mkStep({ stepOrder: 2 }),
        mkStep({ stepOrder: 3 }),
      ]),
    )
    const branch = edges.filter((e) => e.kind === 'branch')
    expect(branch).toHaveLength(1)
    // 対象 step_order=3 のノード id へ向く
    const target = nodes.find((n) => n.kind === 'step' && n.stepOrder === 3)!
    expect(branch[0]).toMatchObject({ from: 'step-1', to: target.id, label: '条件不成立時', targetStepOrder: 3 })
  })

  it('next_step_on_false が存在しない step_order を指す場合は goal へフォールバックしつつ宣言値を保持', () => {
    const { edges } = scenarioToGraph(
      mkScenario([mkStep({ stepOrder: 1, conditionType: 'tag_exists', nextStepOnFalse: 99 })]),
    )
    const branch = edges.filter((e) => e.kind === 'branch')
    expect(branch).toHaveLength(1)
    expect(branch[0]).toMatchObject({ to: 'goal', targetStepOrder: 99 })
  })
})

describe('scenarioToGraph — 不変条件', () => {
  it('入力 steps 配列も step_order も改変しない（純関数）', () => {
    const steps = [mkStep({ stepOrder: 3 }), mkStep({ stepOrder: 1 }), mkStep({ stepOrder: 2 })]
    const snapshot = steps.map((s) => ({ id: s.id, stepOrder: s.stepOrder }))
    scenarioToGraph(mkScenario(steps))
    expect(steps.map((s) => ({ id: s.id, stepOrder: s.stepOrder }))).toEqual(snapshot)
  })

  it('未ソート入力でも step_order 昇順で並ぶ', () => {
    const { nodes } = scenarioToGraph(
      mkScenario([mkStep({ stepOrder: 3 }), mkStep({ stepOrder: 1 }), mkStep({ stepOrder: 2 })]),
    )
    const stepOrders = nodes.filter((n) => n.kind === 'step').map((n) => n.stepOrder)
    expect(stepOrders).toEqual([1, 2, 3])
  })

  it('trigger ノードに triggerType / triggerTagId を保持', () => {
    const { nodes } = scenarioToGraph(mkScenario([], { triggerType: 'tag_added', triggerTagId: 'tag-abc' }))
    expect(nodes[0]).toMatchObject({ kind: 'trigger', triggerType: 'tag_added', triggerTagId: 'tag-abc' })
  })
})

describe('conditionBadgeLabel', () => {
  it('4 種の条件を日本語ラベルに、null/未知は null', () => {
    expect(conditionBadgeLabel('tag_exists')).toBe('指定タグを持つ場合のみ')
    expect(conditionBadgeLabel('tag_not_exists')).toBe('指定タグを持たない場合のみ')
    expect(conditionBadgeLabel('metadata_equals')).toBe('属性が一致する場合のみ')
    expect(conditionBadgeLabel('metadata_not_equals')).toBe('属性が一致しない場合のみ')
    expect(conditionBadgeLabel(null)).toBeNull()
    expect(conditionBadgeLabel('unknown_type')).toBeNull()
  })
})

describe('stepContentSummary', () => {
  it('text は本文、flex/image は種別ラベル、空は（内容なし）、長文は省略', () => {
    expect(stepContentSummary(mkStep({ messageType: 'text', messageContent: 'やあ' }))).toBe('やあ')
    expect(stepContentSummary(mkStep({ messageType: 'flex', messageContent: '{}' }))).toBe('Flex メッセージ')
    expect(stepContentSummary(mkStep({ messageType: 'image', messageContent: '{}' }))).toBe('画像メッセージ')
    expect(stepContentSummary(mkStep({ messageType: 'text', messageContent: '   ' }))).toBe('（内容なし）')
    const long = 'あ'.repeat(60)
    expect(stepContentSummary(mkStep({ messageType: 'text', messageContent: long }), 40)).toBe('あ'.repeat(40) + '…')
  })
})
