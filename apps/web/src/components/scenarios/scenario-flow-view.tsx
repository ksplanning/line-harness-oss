'use client'

/**
 * scenario-flow-view — シナリオ（ステップ配信）を「線で繋いだ縦型の図」で読み取り表示する。
 *
 * 設計方針（plan §1, §7 / owner 美学 feedback_owner_anti_generic_aesthetic / native-scroll）:
 *  - 依存ゼロの自作 SVG + div。既定フローライブラリの chrome（minimap / attribution /
 *    dotted grid / 既定の丸ハンドル）は一切出さない = 没個性テンプレ回避。
 *  - LINE ブランド緑（#06C755）を基調に、順次線=緑の実線、条件分岐線=琥珀の破線で意味を描き分ける。
 *  - 座標は node の並び順から決定的に算出（DOM 計測に依存しない）→ jsdom でも実ブラウザでも同一描画。
 *  - pan/zoom を持たない native scroll（Lenis 慣性を入れない）。縦に素直に伸びる。
 *  - 読み取り専用。編集・drag-connect は Phase2。分岐は「データ宣言」に忠実に描き、
 *    配信ランタイムのジャンプ挙動疑い（spec §2.4 / L3）は凡例注記で明示（silently 寄せない）。
 */

import { useMemo } from 'react'
import type { MessageType, ScenarioTriggerType } from '@line-crm/shared'
import {
  scenarioToGraph,
  conditionBadgeLabel,
  stepContentSummary,
  type ScenarioWithBranchSteps,
  type FlowNode,
} from '@/lib/scenario-graph'

// --- 決定的レイアウト定数（px） -------------------------------------------------
const TOP = 20
const NODE_X = 24
const NODE_W = 300
const NODE_H = 116
const GAP_Y = 64
const SVG_W = 470
const CENTER_X = NODE_X + NODE_W / 2 // 174
const RIGHT_X = NODE_X + NODE_W // 324（分岐線が出入りする右端）
const LANE_X = 408 // 分岐線が右に膨らむレーン

const LINE_GREEN = '#06C755'
const BRANCH_AMBER = '#d97706'

const triggerLabels: Record<ScenarioTriggerType, string> = {
  friend_add: '友だち追加時',
  tag_added: 'タグ付与時（指定タグ）',
  manual: '手動登録',
}

const messageTypeBadge: Record<MessageType, { label: string; cls: string }> = {
  text: { label: 'テキスト', cls: 'bg-blue-50 text-blue-600' },
  image: { label: '画像', cls: 'bg-purple-50 text-purple-600' },
  flex: { label: 'Flex', cls: 'bg-orange-50 text-orange-600' },
}

function nodeTop(i: number): number {
  return TOP + i * (NODE_H + GAP_Y)
}
function nodeCenterY(i: number): number {
  return nodeTop(i) + NODE_H / 2
}
function nodeBottom(i: number): number {
  return nodeTop(i) + NODE_H
}

export default function ScenarioFlowView({ scenario }: { scenario: ScenarioWithBranchSteps }) {
  const graph = useMemo(() => scenarioToGraph(scenario), [scenario])
  const { nodes, edges } = graph

  const idToIndex = useMemo(() => {
    const m = new Map<string, number>()
    nodes.forEach((n, i) => m.set(n.id, i))
    return m
  }, [nodes])

  const totalH = TOP + nodes.length * NODE_H + Math.max(0, nodes.length - 1) * GAP_Y + TOP

  return (
    <div className="space-y-4">
      <FlowLegend />

      {/* native scroll のみ（Lenis 慣性なし）。狭幅では横スクロール（Phase1 は縦フロー既定）。 */}
      <div
        data-native-scroll
        className="overflow-x-auto overflow-y-visible rounded-xl border border-gray-200 bg-[#fafbfc] p-2"
      >
        <div className="relative mx-auto" style={{ width: SVG_W, height: totalH }}>
          {/* --- エッジ層（SVG・最背面・クリック透過） --- */}
          <svg
            width={SVG_W}
            height={totalH}
            className="absolute left-0 top-0"
            style={{ pointerEvents: 'none' }}
            aria-hidden="true"
          >
            <defs>
              <marker id="flow-arrow-seq" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
                <path d="M0,0 L6,4 L0,8 Z" fill={LINE_GREEN} />
              </marker>
              <marker id="flow-arrow-branch" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
                <path d="M0,0 L6,4 L0,8 Z" fill={BRANCH_AMBER} />
              </marker>
            </defs>

            {edges.map((edge) => {
              const fromIdx = idToIndex.get(edge.from)
              const toIdx = idToIndex.get(edge.to)
              if (fromIdx == null || toIdx == null) return null

              if (edge.kind === 'branch') {
                const cyFrom = nodeCenterY(fromIdx)
                const cyTo = nodeCenterY(toIdx)
                const d = `M ${RIGHT_X} ${cyFrom} C ${LANE_X} ${cyFrom} ${LANE_X} ${cyTo} ${RIGHT_X} ${cyTo}`
                return (
                  <path
                    key={edge.id}
                    d={d}
                    data-edge-kind="branch"
                    data-from={edge.from}
                    data-to={edge.to}
                    fill="none"
                    stroke={BRANCH_AMBER}
                    strokeWidth={1.5}
                    strokeDasharray="5 4"
                    markerEnd="url(#flow-arrow-branch)"
                  />
                )
              }

              // sequential（隣接ノード間の縦連結）
              const y1 = nodeBottom(fromIdx)
              const y2 = nodeTop(toIdx)
              const d = `M ${CENTER_X} ${y1} L ${CENTER_X} ${y2 - 2}`
              return (
                <path
                  key={edge.id}
                  d={d}
                  data-edge-kind="sequential"
                  data-from={edge.from}
                  data-to={edge.to}
                  fill="none"
                  stroke={LINE_GREEN}
                  strokeWidth={2}
                  markerEnd="url(#flow-arrow-seq)"
                />
              )
            })}
          </svg>

          {/* --- ノード層 --- */}
          {nodes.map((node) => {
            const i = idToIndex.get(node.id)!
            return (
              <div
                key={node.id}
                data-node-kind={node.kind}
                data-node-id={node.id}
                className="absolute"
                style={{ left: NODE_X, top: nodeTop(i), width: NODE_W, height: NODE_H }}
              >
                <FlowNodeCard node={node} scenario={scenario} />
              </div>
            )
          })}

          {/* --- 順次エッジの待機ラベル pill（ギャップ中央） --- */}
          {edges.map((edge) => {
            if (edge.kind !== 'sequential' || !edge.label) return null
            const fromIdx = idToIndex.get(edge.from)
            const toIdx = idToIndex.get(edge.to)
            if (fromIdx == null || toIdx == null) return null
            const midY = (nodeBottom(fromIdx) + nodeTop(toIdx)) / 2
            return (
              <div
                key={`lbl-${edge.id}`}
                className="absolute whitespace-nowrap rounded-full border border-green-200 bg-white px-2.5 py-0.5 text-[11px] font-medium text-green-700 shadow-sm"
                style={{ left: CENTER_X, top: midY, transform: 'translate(-50%, -50%)' }}
              >
                {edge.label}
              </div>
            )
          })}

          {/* --- 分岐エッジのラベル pill（レーン中央） --- */}
          {edges.map((edge) => {
            if (edge.kind !== 'branch' || !edge.label) return null
            const fromIdx = idToIndex.get(edge.from)
            const toIdx = idToIndex.get(edge.to)
            if (fromIdx == null || toIdx == null) return null
            const midY = (nodeCenterY(fromIdx) + nodeCenterY(toIdx)) / 2
            return (
              <div
                key={`lbl-${edge.id}`}
                className="absolute whitespace-nowrap rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700"
                style={{ left: LANE_X, top: midY, transform: 'translate(-50%, -50%)' }}
              >
                {edge.label}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------

function FlowNodeCard({ node, scenario }: { node: FlowNode; scenario: ScenarioWithBranchSteps }) {
  if (node.kind === 'trigger') {
    return (
      <div
        className="flex h-full flex-col justify-center rounded-2xl px-4 text-white shadow-sm"
        style={{ backgroundColor: LINE_GREEN }}
      >
        <span className="text-[11px] font-semibold uppercase tracking-wide text-white/80">スタート</span>
        <span className="mt-0.5 text-sm font-bold leading-snug">
          ▶ {triggerLabels[node.triggerType ?? 'friend_add'] ?? node.triggerType}
        </span>
        <span className="mt-0.5 truncate text-[11px] text-white/80">「{scenario.name}」開始</span>
      </div>
    )
  }

  if (node.kind === 'goal') {
    return (
      <div className="flex h-full flex-col justify-center rounded-2xl bg-slate-700 px-4 text-white shadow-sm">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-white/70">ゴール</span>
        <span className="mt-0.5 text-sm font-bold leading-snug">🏁 配信完了</span>
        <span className="mt-0.5 text-[11px] text-white/70">これ以降の配信はありません</span>
      </div>
    )
  }

  // step ノード（左に LINE 緑のアクセントバー・フラットな枠線・drop-shadow 過多を避ける）
  const step = node.step!
  const mt = messageTypeBadge[step.messageType] ?? { label: step.messageType, cls: 'bg-gray-100 text-gray-600' }
  const condLabel = conditionBadgeLabel(step.conditionType)
  const summary = stepContentSummary(step)

  return (
    <div className="flex h-full overflow-hidden rounded-xl border border-gray-200 bg-white">
      <div className="w-1.5 shrink-0" style={{ backgroundColor: LINE_GREEN }} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 px-3 py-2">
        <div className="flex items-center gap-2">
          <span
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold text-white"
            style={{ backgroundColor: LINE_GREEN }}
          >
            {step.stepOrder}
          </span>
          <span className={`inline-flex items-center rounded px-2 py-0.5 text-[11px] font-medium ${mt.cls}`}>
            {mt.label}
          </span>
          {condLabel && (
            <span className="inline-flex items-center rounded bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700">
              {condLabel}
            </span>
          )}
        </div>

        <p className="line-clamp-2 break-words text-[13px] leading-snug text-gray-700">{summary}</p>

        {step.onReachTagId && (
          <span className="mt-auto inline-flex w-fit items-center rounded bg-green-50 px-2 py-0.5 text-[11px] font-medium text-green-700">
            🏷 到達でタグ付与
          </span>
        )}
      </div>
    </div>
  )
}

function FlowLegend() {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3 text-xs text-gray-600">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <span className="font-semibold text-gray-700">凡例</span>
        <LegendDot color={LINE_GREEN} label="スタート／ステップ（緑の実線＝順番に配信）" />
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0 w-5 border-t-2 border-dashed" style={{ borderColor: BRANCH_AMBER }} />
          <span>条件分岐（琥珀の破線）</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-3 rounded-sm bg-slate-700" />
          <span>ゴール（完了）</span>
        </span>
      </div>
      <p className="leading-relaxed text-[11px] text-amber-700">
        ※ 条件分岐の線はデータ上の設定（不成立時の飛び先）をそのまま描いています。実際の配信挙動は現在ステップ順を優先するため、
        分岐の飛び先が設定どおりに動かない既知の要修正があります（後続フェーズで対応予定）。
      </p>
    </div>
  )
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block h-3 w-3 rounded-full" style={{ backgroundColor: color }} />
      <span>{label}</span>
    </span>
  )
}
