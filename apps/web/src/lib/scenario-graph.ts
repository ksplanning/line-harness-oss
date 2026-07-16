import type { Scenario, ScenarioStep, ScenarioTriggerType } from '@line-crm/shared'
import { formatScheduleLabel } from './scenario-schedule'

/**
 * scenario-graph — シナリオ（ステップ配信）を「線で繋いだ図」の nodes / edges に正規化する純関数。
 *
 * 背景（重要 / plan §2, spec §2）:
 *  - worker `serializeStep`（routes/scenarios.ts:52-70）は runtime で
 *    conditionType / conditionValue / nextStepOnFalse を返すが、共有型 `ScenarioStep`
 *    はこれら分岐列を「まだ宣言していない」。packages/shared は本 Phase では触らないため、
 *    ここでローカルに拡張型 `BranchedScenarioStep` を定義して分岐列を読む。
 *  - 本モジュールは副作用ゼロ・step_order / next_step_on_false を改変しない（読み取り専用）。
 *    Phase2 の逆変換（node→step CRUD）でも再採番せず既存値を尊重する土台になる。
 *  - 分岐の「データ宣言」に忠実に描く。配信ランタイムのジャンプ挙動疑い（spec §2.4 / L3）に
 *    silently 寄せない（乖離注記は描画側の凡例が担う）。
 */

/** 分岐条件種別（migration 005_step_branching.sql）。null = 常時実行。 */
export type ConditionType =
  | 'tag_exists'
  | 'tag_not_exists'
  | 'metadata_equals'
  | 'metadata_not_equals'
  | 'metadata_contains'
  | 'metadata_not_contains'
  | 'tag_name_contains'
  | 'tag_name_not_contains'

/**
 * shared `ScenarioStep` に serializeStep が返す分岐 3 列を additive 拡張したローカル型。
 * （packages/shared は本 Phase 不変 = D-2。runtime JSON は既にこれらを含む。）
 */
export type BranchedScenarioStep = ScenarioStep & {
  conditionType?: ConditionType | string | null
  conditionValue?: string | null
  nextStepOnFalse?: number | null
}

export type ScenarioWithBranchSteps = Scenario & { steps: BranchedScenarioStep[] }

export type FlowNodeKind = 'trigger' | 'step' | 'goal'

export interface FlowNode {
  /** 'trigger' | step.id | 'goal' */
  id: string
  kind: FlowNodeKind
  /** step ノードのみ: 元ステップ（分岐列込み） */
  step?: BranchedScenarioStep
  /** step ノードのみ: step_order（描画順・分岐ターゲット解決に使用） */
  stepOrder?: number
  /** trigger ノードのみ: 起点の種別 */
  triggerType?: ScenarioTriggerType
  /** trigger ノードのみ: トリガーとなるタグ ID（tag_added 時） */
  triggerTagId?: string | null
}

export type FlowEdgeKind = 'sequential' | 'branch'

export interface FlowEdge {
  id: string
  /** 起点ノード id */
  from: string
  /** 終点ノード id */
  to: string
  kind: FlowEdgeKind
  /** 順次 = 待機ラベル / 分岐 = '条件不成立時' */
  label?: string
  /** 分岐 edge のみ: データが宣言した next_step_on_false の step_order。
   *  実在しない step_order を指す場合でも宣言値を保持（解決先は goal にフォールバック）。 */
  targetStepOrder?: number | null
}

export interface ScenarioGraph {
  nodes: FlowNode[]
  edges: FlowEdge[]
}

const TRIGGER_ID = 'trigger'
const GOAL_ID = 'goal'
const BRANCH_LABEL = '条件不成立時'

/**
 * シナリオを nodes / edges に正規化する（読み取り専用・純関数）。
 * node 数は常に steps.length + 2（trigger 1 + step N + goal 1）。
 */
export function scenarioToGraph(scenario: ScenarioWithBranchSteps): ScenarioGraph {
  const mode = scenario.deliveryMode
  // 入力を破壊しないよう複製してから step_order 昇順に並べる。
  const steps = [...scenario.steps].sort((a, b) => a.stepOrder - b.stepOrder)

  const nodes: FlowNode[] = [
    {
      id: TRIGGER_ID,
      kind: 'trigger',
      triggerType: scenario.triggerType,
      triggerTagId: scenario.triggerTagId ?? null,
    },
    ...steps.map<FlowNode>((s) => ({ id: s.id, kind: 'step', step: s, stepOrder: s.stepOrder })),
    { id: GOAL_ID, kind: 'goal' },
  ]

  const edges: FlowEdge[] = []

  if (steps.length === 0) {
    edges.push({ id: 'seq-trigger-goal', from: TRIGGER_ID, to: GOAL_ID, kind: 'sequential' })
    return { nodes, edges }
  }

  // trigger → 最初のステップ（待機ラベル = 最初のステップの配信タイミング）
  edges.push({
    id: `seq-${TRIGGER_ID}-${steps[0].id}`,
    from: TRIGGER_ID,
    to: steps[0].id,
    kind: 'sequential',
    label: formatScheduleLabel(mode, steps[0]),
  })

  // 各ステップ間の順次エッジ（待機ラベル = 到着ステップの配信タイミング）
  for (let i = 0; i < steps.length - 1; i++) {
    const cur = steps[i]
    const next = steps[i + 1]
    edges.push({
      id: `seq-${cur.id}-${next.id}`,
      from: cur.id,
      to: next.id,
      kind: 'sequential',
      label: formatScheduleLabel(mode, next),
    })
  }

  // 最終ステップ → goal（待機ラベルなし = 完了）
  const last = steps[steps.length - 1]
  edges.push({ id: `seq-${last.id}-${GOAL_ID}`, from: last.id, to: GOAL_ID, kind: 'sequential' })

  // 分岐エッジ（next_step_on_false != null）: 対象 step_order のノードへ。無ければ goal にフォールバック。
  for (const s of steps) {
    const target = s.nextStepOnFalse
    if (target == null) continue
    const targetNode = nodes.find((n) => n.kind === 'step' && n.stepOrder === target)
    edges.push({
      id: `branch-${s.id}`,
      from: s.id,
      to: targetNode ? targetNode.id : GOAL_ID,
      kind: 'branch',
      label: BRANCH_LABEL,
      targetStepOrder: target,
    })
  }

  return { nodes, edges }
}

/** 条件種別を運用スタッフ向けの日本語ラベルに。null/未知は null（= 常時実行・バッジ非表示）。 */
export function conditionBadgeLabel(conditionType: string | null | undefined): string | null {
  switch (conditionType) {
    case 'tag_exists':
      return '指定タグを持つ場合のみ'
    case 'tag_not_exists':
      return '指定タグを持たない場合のみ'
    case 'metadata_equals':
      return '属性が一致する場合のみ'
    case 'metadata_not_equals':
      return '属性が一致しない場合のみ'
    case 'tag_name_contains':
      return 'タグ名に指定文字を含む場合のみ'
    case 'tag_name_not_contains':
      return 'タグ名に指定文字を含まない場合のみ'
    case 'metadata_contains':
      return '回答に指定文字を含む場合のみ'
    case 'metadata_not_contains':
      return '回答に指定文字を含まない場合のみ'
    default:
      return null
  }
}

/** ノードに載せる内容要約。flex/image は種別ラベル、text は本文（長文は省略）、空は「（内容なし）」。 */
export function stepContentSummary(step: BranchedScenarioStep, maxLen = 40): string {
  if (step.messageType === 'flex') return 'Flex メッセージ'
  if (step.messageType === 'image') return '画像メッセージ'
  const text = (step.messageContent ?? '').trim()
  if (!text) return '（内容なし）'
  return text.length > maxLen ? text.slice(0, maxLen) + '…' : text
}
