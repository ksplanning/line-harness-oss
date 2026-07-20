'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import type { Scenario, ScenarioStep, ScenarioTriggerType, MessageType, DeliveryMode } from '@line-crm/shared'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'
import HelpPopover from '@/components/help/help-popover'
import FlexPreviewComponent from '@/components/flex-preview'
import ImageUploader from '@/components/shared/image-uploader'
import PersonalizedTextEditor from '@/components/shared/personalized-text-editor'
import FlexBuilderModal from '@/components/flex-builder/flex-builder-modal'
import { flexToModel } from '@/lib/flex-builder/from-flex'
import type { BuilderModel } from '@/lib/flex-builder/types'
import ScheduleInput, {
  emptySchedule,
  buildSchedulePayload,
  uiFromOffsetMinutes,
  type ScheduleValue,
} from '@/components/scenarios/schedule-input'
import { formatScheduleLabel } from '@/lib/scenario-schedule'
import BulkPreviewModal from '@/components/scenarios/bulk-preview-modal'
import EnrollFriendDialog from '@/components/scenarios/enroll-friend-dialog'
import TestSendDialog from '@/components/shared/test-send-dialog'
import { useAccount } from '@/contexts/account-context'

type ScenarioWithSteps = Scenario & { steps: ScenarioStep[] }

const triggerOptions: { value: ScenarioTriggerType; label: string }[] = [
  { value: 'friend_add', label: '友だち追加時' },
  { value: 'tag_added', label: 'タグ付与時' },
  { value: 'manual', label: '手動' },
]

const messageTypeOptions: { value: MessageType; label: string }[] = [
  { value: 'text', label: 'テキスト' },
  { value: 'image', label: '画像' },
  { value: 'flex', label: 'Flex' },
]

const modeBadgeStyle: Record<DeliveryMode, { bg: string; text: string; label: string }> = {
  relative: { bg: 'bg-gray-100', text: 'text-gray-600', label: 'Legacy' },
  elapsed: { bg: 'bg-blue-50', text: 'text-blue-700', label: '経過時間' },
  absolute_time: { bg: 'bg-amber-50', text: 'text-amber-700', label: '時刻指定' },
}

const flexRebuildPrompt = '今の本文はそのままではビジュアル編集できません。新しくビジュアルで作り直しますか？（今のテキストは破棄されます）'
const flexRebuildGuidance = '今の本文はそのままではビジュアル編集できません。本文を残す場合は、下の「上級者向け」で編集してください。'

// 分岐条件の種別。null = 条件なし（常に配信）。タグ ID の有無／タグ名の部分一致と、
// 回答値の完全一致／部分一致をそれぞれ正負ペアで表現する（spec §2.4）。
type BranchConditionType =
  | 'tag_exists'
  | 'tag_not_exists'
  | 'metadata_equals'
  | 'metadata_not_equals'
  | 'tag_name_contains'
  | 'tag_name_not_contains'
  | 'metadata_contains'
  | 'metadata_not_contains'

const branchConditionOptions: { value: BranchConditionType; label: string }[] = [
  { value: 'tag_exists', label: 'このタグを持っている' },
  { value: 'tag_not_exists', label: 'このタグを持っていない' },
  { value: 'metadata_equals', label: '回答が次の値と一致する' },
  { value: 'metadata_not_equals', label: '回答が次の値と一致しない' },
  { value: 'tag_name_contains', label: 'タグ名に次の文字を含む' },
  { value: 'tag_name_not_contains', label: 'タグ名に次の文字を含まない' },
  { value: 'metadata_contains', label: '回答・カスタム項目に次の文字を含む' },
  { value: 'metadata_not_contains', label: '回答・カスタム項目に次の文字を含まない' },
]

const isTagCondition = (t: BranchConditionType | null): boolean =>
  t === 'tag_exists' || t === 'tag_not_exists'
const isTagNameContainsCondition = (t: BranchConditionType | null): boolean =>
  t === 'tag_name_contains' || t === 'tag_name_not_contains'
const isMetaCondition = (t: BranchConditionType | null): boolean =>
  t === 'metadata_equals' || t === 'metadata_not_equals' ||
  t === 'metadata_contains' || t === 'metadata_not_contains'

interface StepFormState {
  stepOrder: number
  schedule: ScheduleValue
  messageType: MessageType
  messageContent: string
  templateId: string | null
  onReachTagId: string | null
  inputMode: 'direct' | 'template'
  // --- 分岐条件（slice-1）: 条件不成立時に「飛び先 step_order」へ分岐 ---
  conditionType: BranchConditionType | null
  conditionTagId: string | null        // tag 条件のとき condition_value = tag_id
  conditionTagNameQuery: string         // tag_name_* 条件のとき condition_value = 生 needle
  conditionMetaKey: string             // metadata 条件のとき {"key","value"} の key
  conditionMetaValue: string           // metadata 条件のとき {"key","value"} の value
  nextStepOnFalse: number | null       // 不成立時のジャンプ先 step_order（前方のみ・null=順次スキップ）
}

function emptyStepForm(stepOrder: number): StepFormState {
  return {
    stepOrder,
    schedule: { ...emptySchedule },
    messageType: 'text',
    messageContent: '',
    templateId: null,
    onReachTagId: null,
    inputMode: 'direct',
    conditionType: null,
    conditionTagId: null,
    conditionTagNameQuery: '',
    conditionMetaKey: '',
    conditionMetaValue: '',
    nextStepOnFalse: null,
  }
}

interface TemplateOpt {
  id: string
  name: string
  category: string
  messageType: string
  messageContent: string
}

interface TagOpt {
  id: string
  name: string
}

interface ScenarioStats {
  enrolledTotal: number
  activeNow: number
  completed: number
  paused: number
  steps: Array<{ stepOrder: number; reachedCount: number; reachRate: number }>
}

function FlexPreview({ content }: { content: string }) {
  return <FlexPreviewComponent content={content} maxWidth={300} />
}

function ImagePreview({ content }: { content: string }) {
  try {
    const parsed = JSON.parse(content)
    const url = parsed.previewImageUrl || parsed.originalContentUrl
    return (
      <div>
        <span className="text-xs font-medium text-purple-600 bg-purple-50 px-2 py-0.5 rounded mb-2 inline-block">画像</span>
        {url ? (
          <img src={url} alt="preview" className="max-w-[200px] rounded-lg border border-gray-200 mt-1" />
        ) : (
          <p className="text-xs text-gray-400">プレビューなし</p>
        )}
      </div>
    )
  } catch {
    return <p className="text-xs text-red-500">画像 JSON パースエラー</p>
  }
}

export default function ScenarioDetailClient({ scenarioId }: { scenarioId: string }) {
  const id = scenarioId
  const router = useRouter()
  const { selectedAccountId } = useAccount()

  const [scenario, setScenario] = useState<ScenarioWithSteps | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [editing, setEditing] = useState(false)
  const [editForm, setEditForm] = useState({ name: '', description: '', triggerType: 'friend_add' as ScenarioTriggerType, isActive: true })
  const [saving, setSaving] = useState(false)
  // 複製: 詳細では軽い行内確認を挟む (window.confirm 禁止 = headless E2E 非互換)。
  const [confirmDup, setConfirmDup] = useState(false)
  const [duplicating, setDuplicating] = useState(false)

  const [showStepForm, setShowStepForm] = useState(false)
  const [editingStepId, setEditingStepId] = useState<string | null>(null)
  const [stepForm, setStepForm] = useState<StepFormState>(() => emptyStepForm(1))
  const [stepSaving, setStepSaving] = useState(false)
  // Flex ビジュアルビルダー: step の flex 生 JSON textarea をビルダー起動に置換 (broadcast/templates と同一流儀)
  const [stepBuilderOpen, setStepBuilderOpen] = useState(false)
  const [stepBuilderInitial, setStepBuilderInitial] = useState<BuilderModel | undefined>(undefined)
  const [stepAdvancedJsonOpen, setStepAdvancedJsonOpen] = useState(false)
  const [stepRebuildConfirmOpen, setStepRebuildConfirmOpen] = useState(false)
  const [stepBuilderError, setStepBuilderError] = useState('')
  const stepBuilderTriggerRef = useRef<HTMLButtonElement>(null)
  const stepRebuildConfirmButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (stepRebuildConfirmOpen) stepRebuildConfirmButtonRef.current?.focus()
  }, [stepRebuildConfirmOpen])

  const resetStepBuilderFeedback = () => {
    setStepRebuildConfirmOpen(false)
    setStepBuilderError('')
    setStepAdvancedJsonOpen(false)
  }

  const openStepBuilder = () => {
    if (stepForm.messageContent.trim()) {
      const model = flexToModel(stepForm.messageContent)
      if (!model) {
        setStepBuilderError('')
        setStepAdvancedJsonOpen(false)
        setStepRebuildConfirmOpen(true)
        return
      }
      setStepBuilderInitial(model)
    } else {
      setStepBuilderInitial(undefined)
    }
    setStepBuilderError('')
    setStepRebuildConfirmOpen(false)
    setStepBuilderOpen(true)
  }

  const confirmStepBuilderRebuild = () => {
    setStepBuilderInitial(undefined)
    setStepBuilderError('')
    setStepRebuildConfirmOpen(false)
    setStepAdvancedJsonOpen(false)
    setStepBuilderOpen(true)
  }

  const cancelStepBuilderRebuild = () => {
    setStepRebuildConfirmOpen(false)
    setStepAdvancedJsonOpen(true)
    setStepBuilderError(flexRebuildGuidance)
    stepBuilderTriggerRef.current?.focus()
  }
  const [stepError, setStepError] = useState('')

  const [previewOpen, setPreviewOpen] = useState(false)
  // G7 手動シナリオ登録モーダルの開閉。
  const [enrollOpen, setEnrollOpen] = useState(false)

  const [stats, setStats] = useState<ScenarioStats | null>(null)
  const [templates, setTemplates] = useState<TemplateOpt[]>([])
  const [tags, setTags] = useState<TagOpt[]>([])

  const deliveryMode: DeliveryMode = (scenario?.deliveryMode ?? 'relative') as DeliveryMode

  const loadScenario = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.scenarios.get(id)
      if (res.success) {
        setScenario(res.data)
        setEditForm({
          name: res.data.name,
          description: res.data.description ?? '',
          triggerType: res.data.triggerType,
          isActive: res.data.isActive,
        })
      } else {
        setError(res.error)
      }
    } catch {
      setError('シナリオの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    loadScenario()
  }, [loadScenario])

  const handleDuplicate = async () => {
    if (!scenario) return
    setDuplicating(true)
    setError('')
    try {
      // scenario 自身の account を guard に渡す (元と同 account の複製・別 account 混入なし)。
      const accountId = (scenario as { lineAccountId?: string | null }).lineAccountId ?? undefined
      const res = await api.scenarios.duplicate(id, accountId)
      if (res.success) {
        // 複製先の詳細へ遷移 → 「(コピー) 元名」「無効」バッジで複製を即目視 (ui-design §1.4)。
        router.push(`/scenarios/detail?id=${res.data.id}`)
      } else {
        setError(res.error)
        setConfirmDup(false)
      }
    } catch {
      setError('複製に失敗しました。もう一度お試しください。')
      setConfirmDup(false)
    } finally {
      setDuplicating(false)
    }
  }

  // 並列で stats / templates / tags を取得（リグレッションを起こさないよう失敗は無視）
  useEffect(() => {
    if (!id) return
    let cancelled = false
    Promise.all([
      api.scenarios.stats(id).catch(() => null),
      api.templates.list().catch(() => null),
      api.tags.list().catch(() => null),
    ]).then(([statsRes, tplRes, tagRes]) => {
      if (cancelled) return
      if (statsRes && statsRes.success) setStats(statsRes.data)
      if (tplRes && tplRes.success) {
        setTemplates(tplRes.data.map((t) => ({
          id: t.id,
          name: t.name,
          category: t.category,
          messageType: t.messageType,
          messageContent: t.messageContent,
        })))
      }
      if (tagRes && tagRes.success) {
        setTags(tagRes.data.map((t) => ({ id: t.id, name: t.name })))
      }
    })
    return () => { cancelled = true }
  }, [id])

  const reloadStats = useCallback(() => {
    api.scenarios.stats(id).then((r) => { if (r.success) setStats(r.data) }).catch(() => {})
  }, [id])

  const handleSaveScenario = async () => {
    if (!editForm.name.trim()) return
    setSaving(true)
    try {
      const res = await api.scenarios.update(id, {
        name: editForm.name,
        description: editForm.description || null,
        triggerType: editForm.triggerType,
        isActive: editForm.isActive,
      })
      if (res.success) {
        setEditing(false)
        loadScenario()
      } else {
        setError(res.error)
      }
    } catch {
      setError('保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const openAddStep = () => {
    const nextOrder = scenario ? (scenario.steps.length > 0 ? Math.max(...scenario.steps.map(s => s.stepOrder)) + 1 : 1) : 1
    setStepForm(emptyStepForm(nextOrder))
    setEditingStepId(null)
    setShowStepForm(true)
    setStepError('')
    resetStepBuilderFeedback()
  }

  const openEditStep = (step: ScenarioStep) => {
    const ui = uiFromOffsetMinutes(step.offsetMinutes)
    // 分岐条件を UI 状態へ復元（condition_value を tag_id／生 needle／{"key","value"} に読み解く）。
    const ct = (step.conditionType ?? null) as BranchConditionType | null
    let conditionTagId: string | null = null
    let conditionTagNameQuery = ''
    let conditionMetaKey = ''
    let conditionMetaValue = ''
    if (isTagCondition(ct)) {
      conditionTagId = step.conditionValue ?? null
    } else if (isTagNameContainsCondition(ct)) {
      conditionTagNameQuery = step.conditionValue ?? ''
    } else if (isMetaCondition(ct)) {
      try {
        const parsed = JSON.parse(step.conditionValue ?? '{}') as { key?: unknown; value?: unknown }
        conditionMetaKey = typeof parsed.key === 'string' ? parsed.key : ''
        conditionMetaValue = parsed.value != null ? String(parsed.value) : ''
      } catch { /* 壊れた値は空欄で開く */ }
    }
    setStepForm({
      stepOrder: step.stepOrder,
      schedule: {
        delayMinutes: step.delayMinutes,
        offsetDays: step.offsetDays ?? 0,
        offsetHours: ui.offsetHours,
        offsetMinutesRemainder: ui.offsetMinutesRemainder,
        deliveryTime: step.deliveryTime ?? '09:00',
      },
      messageType: step.messageType,
      messageContent: step.messageContent,
      templateId: step.templateId ?? null,
      onReachTagId: step.onReachTagId ?? null,
      inputMode: step.templateId ? 'template' : 'direct',
      conditionType: ct,
      conditionTagId,
      conditionTagNameQuery,
      conditionMetaKey,
      conditionMetaValue,
      nextStepOnFalse: step.nextStepOnFalse ?? null,
    })
    setEditingStepId(step.id)
    setShowStepForm(true)
    setStepError('')
    resetStepBuilderFeedback()
  }

  const handleSaveStep = async () => {
    // 直接入力モード: messageContent 必須 + Flex/画像 は JSON parse 検証
    if (stepForm.inputMode === 'direct') {
      if (!stepForm.messageContent.trim()) {
        setStepError('メッセージ内容を入力してください')
        return
      }
      if (stepForm.messageType === 'flex' || stepForm.messageType === 'image') {
        try {
          JSON.parse(stepForm.messageContent)
        } catch {
          setStepError(
            stepForm.messageType === 'flex'
              ? 'Flex メッセージの JSON が不正です'
              : '画像メッセージの JSON が不正です',
          )
          return
        }
      }
    } else {
      if (!stepForm.templateId) {
        setStepError('テンプレートを選択してください')
        return
      }
    }
    // 分岐条件を選んだら、種別に応じた必須項目を検証する。
    if (stepForm.conditionType) {
      if (isTagCondition(stepForm.conditionType) && !stepForm.conditionTagId) {
        setStepError('分岐条件の対象タグを選択してください')
        return
      }
      if (isTagNameContainsCondition(stepForm.conditionType) && !stepForm.conditionTagNameQuery.trim()) {
        setStepError('分岐条件のタグ名（含める文字）を入力してください')
        return
      }
      if (isMetaCondition(stepForm.conditionType) && !stepForm.conditionMetaKey.trim()) {
        setStepError('分岐条件の項目名（設問キー）を入力してください')
        return
      }
    }
    setStepSaving(true)
    setStepError('')
    try {
      const schedulePayload = buildSchedulePayload(deliveryMode, stepForm.schedule)
      // テンプレモード保存時は、選択中テンプレ内容を scenario_steps の messageType /
      // messageContent にスナップショットコピーする。テンプレ削除時に resolveStepContent
      // がここから正しい内容にフォールバックできるため。
      let payloadMessageType: MessageType = stepForm.messageType
      let payloadMessageContent: string = stepForm.messageContent || ' '
      if (stepForm.inputMode === 'template' && stepForm.templateId) {
        const tpl = templates.find((t) => t.id === stepForm.templateId)
        if (tpl) {
          // messageType: テンプレが image/carousel のときは scenario_steps の CHECK に
          // ('text','image','flex') の制約があるため text/image/flex のみ許容。
          // carousel が来る可能性は低いが念のため text にフォールバック。
          payloadMessageType = (['text', 'image', 'flex'].includes(tpl.messageType)
            ? tpl.messageType
            : 'text') as MessageType
          payloadMessageContent = tpl.messageContent || ' '
        }
      }
      // 分岐条件を DB 表現へ変換（tag → tag_id / tag_name → 生 needle / metadata → {"key","value"} JSON）。
      // 種別なしのときは 3 列とも null を送り、既存の条件を解除する。
      let conditionType: string | null = null
      let conditionValue: string | null = null
      let nextStepOnFalse: number | null = null
      if (stepForm.conditionType) {
        conditionType = stepForm.conditionType
        conditionValue = isTagCondition(stepForm.conditionType)
          ? stepForm.conditionTagId
          : isTagNameContainsCondition(stepForm.conditionType)
            ? stepForm.conditionTagNameQuery
            : JSON.stringify({ key: stepForm.conditionMetaKey.trim(), value: stepForm.conditionMetaValue })
        nextStepOnFalse = stepForm.nextStepOnFalse
      }
      const payload = {
        stepOrder: stepForm.stepOrder,
        ...schedulePayload,
        messageType: payloadMessageType,
        messageContent: payloadMessageContent,
        templateId: stepForm.inputMode === 'template' ? stepForm.templateId : null,
        onReachTagId: stepForm.onReachTagId,
        conditionType,
        conditionValue,
        nextStepOnFalse,
      }
      if (editingStepId) {
        const res = await api.scenarios.updateStep(id, editingStepId, payload)
        if (!res.success) {
          setStepError(res.error)
          return
        }
      } else {
        const res = await api.scenarios.addStep(id, payload)
        if (!res.success) {
          setStepError(res.error)
          return
        }
      }
      setShowStepForm(false)
      setEditingStepId(null)
      loadScenario()
      reloadStats()
    } catch {
      setStepError('ステップの保存に失敗しました')
    } finally {
      setStepSaving(false)
    }
  }

  const handleDeleteStep = async (stepId: string) => {
    // TODO(F2 batch1 スコープ外): window.confirm は headless E2E 非互換。
    //   複製 (confirmDup) と同じ行内確認 UI へ置換すべき既知課題 (別 batch)。
    if (!confirm('このステップを削除してもよいですか？')) return
    try {
      await api.scenarios.deleteStep(id, stepId)
      loadScenario()
    } catch {
      setError('ステップの削除に失敗しました')
    }
  }

  const handleMoveStep = async (stepId: string, direction: 'up' | 'down') => {
    if (!scenario) return
    const sorted = [...scenario.steps].sort((a, b) => a.stepOrder - b.stepOrder)
    const idx = sorted.findIndex((s) => s.id === stepId)
    const swap = direction === 'up' ? idx - 1 : idx + 1
    if (idx < 0 || swap < 0 || swap >= sorted.length) return
    const a = sorted[idx]
    const b = sorted[swap]
    try {
      await api.scenarios.reorderSteps(id, [
        { stepId: a.id, stepOrder: b.stepOrder },
        { stepId: b.id, stepOrder: a.stepOrder },
      ])
      loadScenario()
      // 到達率バッジは stepOrder ベースでマッチングするので、並び替え後は stats も再取得
      reloadStats()
    } catch {
      setError('並び替えに失敗しました')
    }
  }

  if (loading) {
    return (
      <div>
        <Header title="シナリオ詳細" />
        <div className="bg-white rounded-lg border border-gray-200 p-8 animate-pulse space-y-4">
          <div className="h-6 bg-gray-200 rounded w-1/3" />
          <div className="h-4 bg-gray-100 rounded w-2/3" />
          <div className="h-4 bg-gray-100 rounded w-1/2" />
        </div>
      </div>
    )
  }

  if (!scenario) {
    return (
      <div>
        <Header title="シナリオ詳細" />
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center">
          <p className="text-gray-500">{error || 'シナリオが見つかりません'}</p>
          <Link href="/scenarios" className="text-sm text-green-600 hover:text-green-700 mt-4 inline-block">
            ← シナリオ一覧に戻る
          </Link>
        </div>
      </div>
    )
  }

  const sortedSteps = [...scenario.steps].sort((a, b) => a.stepOrder - b.stepOrder)
  const modeBadge = modeBadgeStyle[deliveryMode]

  return (
    <div>
      <Header
        title="シナリオ詳細"
        action={
          <div className="flex gap-2">
            <Link
              href={`/scenarios/flow?id=${id}`}
              className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90 inline-flex items-center"
              style={{ backgroundColor: '#06C755' }}
            >
              🔗 フロー表示
            </Link>
            <Link
              href="/scenarios"
              className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors inline-flex items-center"
            >
              ← シナリオ一覧
            </Link>
          </div>
        }
      />

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Stats Header Bar */}
      {stats && stats.enrolledTotal > 0 && (
        <div className="mb-4 bg-white rounded-lg border border-gray-200 p-3 flex items-center gap-4 text-sm flex-wrap">
          <span className="font-medium text-gray-700">📊 集計</span>
          <span>登録 <span className="font-semibold">{stats.enrolledTotal}</span> 人</span>
          <span className="text-gray-400">/</span>
          <span>進行中 <span className="font-semibold text-blue-700">{stats.activeNow}</span></span>
          <span className="text-gray-400">/</span>
          <span>完了 <span className="font-semibold text-green-700">{stats.completed}</span></span>
          {stats.paused > 0 && (
            <>
              <span className="text-gray-400">/</span>
              <span>一時停止 {stats.paused}</span>
            </>
          )}
        </div>
      )}

      {/* Scenario Info */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
        {editing ? (
          <div className="space-y-4 max-w-lg">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">シナリオ名 <span className="text-red-500">*</span></label>
              <input
                type="text"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                value={editForm.name}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">説明</label>
              <textarea
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-none"
                rows={2}
                value={editForm.description}
                onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
              />
            </div>
            <div>
              <div className="mb-1 flex items-center gap-1">
                <label className="text-xs font-medium text-gray-600">トリガー</label>
                <HelpPopover helpKey="scenario.condition" />
              </div>
              <select
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                value={editForm.triggerType}
                onChange={(e) => setEditForm({ ...editForm, triggerType: e.target.value as ScenarioTriggerType })}
              >
                {triggerOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="editIsActive"
                checked={editForm.isActive}
                onChange={(e) => setEditForm({ ...editForm, isActive: e.target.checked })}
                className="w-4 h-4 rounded border-gray-300 text-green-600 focus:ring-green-500"
              />
              <label htmlFor="editIsActive" className="text-sm text-gray-600">有効</label>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleSaveScenario}
                disabled={saving}
                className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
                style={{ backgroundColor: '#06C755' }}
              >
                {saving ? '保存中...' : '保存'}
              </button>
              <button
                onClick={() => {
                  setEditing(false)
                  setEditForm({
                    name: scenario.name,
                    description: scenario.description ?? '',
                    triggerType: scenario.triggerType,
                    isActive: scenario.isActive,
                  })
                }}
                className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
              >
                キャンセル
              </button>
            </div>
          </div>
        ) : (
          <div>
            <div className="flex items-start justify-between gap-4 mb-3">
              <h2 className="text-lg font-semibold text-gray-900">{scenario.name}</h2>
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${modeBadge.bg} ${modeBadge.text}`}>
                  {modeBadge.label}
                </span>
                <span
                  className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                    scenario.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                  }`}
                >
                  {scenario.isActive ? '有効' : '無効'}
                </span>
                <button
                  onClick={() => setEditing(true)}
                  className="text-xs font-medium text-green-600 hover:text-green-700 px-3 py-1.5 rounded-md hover:bg-green-50 transition-colors"
                >
                  編集
                </button>
                {confirmDup ? (
                  <span className="flex items-center gap-1">
                    <span className="text-xs text-gray-600">このシナリオを複製しますか？（複製は「無効」で作られます）</span>
                    <button
                      onClick={handleDuplicate}
                      disabled={duplicating}
                      className="min-h-[36px] px-3 rounded-md text-xs font-medium text-white disabled:opacity-50"
                      style={{ backgroundColor: '#06C755' }}
                    >
                      {duplicating ? '複製中…' : 'はい'}
                    </button>
                    <button
                      onClick={() => setConfirmDup(false)}
                      disabled={duplicating}
                      className="min-h-[36px] px-3 rounded-md text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 disabled:opacity-50"
                    >
                      いいえ
                    </button>
                  </span>
                ) : (
                  <button
                    onClick={() => setConfirmDup(true)}
                    className="text-xs font-medium text-green-600 hover:text-green-700 px-3 py-1.5 rounded-md hover:bg-green-50 transition-colors"
                  >
                    複製
                  </button>
                )}
              </div>
            </div>
            {scenario.description && (
              <p className="text-sm text-gray-500 mb-3">{scenario.description}</p>
            )}
            <div className="flex items-center gap-4 text-xs text-gray-500 flex-wrap">
              <span>トリガー: {triggerOptions.find(o => o.value === scenario.triggerType)?.label ?? scenario.triggerType}</span>
              <span>ステップ数: {scenario.steps.length}</span>
              <span>作成日: {new Date(scenario.createdAt).toLocaleDateString('ja-JP')}</span>
            </div>
          </div>
        )}
      </div>

      {/* このシナリオに登録した友だち (G7 手動シナリオ登録 / 指名移動) */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
        <h3 className="text-sm font-semibold text-gray-800 mb-2">このシナリオに登録した友だち</h3>

        {/* 誤解防止の説明文 (friend_add トリガーは自動追加が主目的のため省略)。
            DeliveryMode は relative/elapsed/absolute_time のいずれも「決まったタイミングで
            自動送信」= 同一文面 (spec に無い 'manual' モードは存在しない)。 */}
        {scenario.triggerType !== 'friend_add' && (
          <p className="text-xs text-gray-500 mb-3 leading-relaxed">
            登録すると、このシナリオのステップが決まったタイミングで自動で送られます。登録しただけでは何も送信されません。
          </p>
        )}

        <button
          onClick={() => setEnrollOpen(true)}
          className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
        >
          友だちを登録する
        </button>

        {stats && stats.enrolledTotal > 0 ? (
          <p className="text-sm text-gray-700 mt-3">
            登録済み <span className="font-semibold">{stats.enrolledTotal}</span> 人
            <span className="text-xs text-gray-400 ml-1">（詳細リストは今後実装予定）</span>
          </p>
        ) : (
          <p className="text-sm text-gray-500 mt-3">
            まだ誰も登録されていません。「友だちを登録する」ボタンから追加できます。
          </p>
        )}
      </div>

      {/* Steps */}
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-800">ステップ一覧</h3>
          <div className="flex gap-2">
            <button
              onClick={() => setPreviewOpen(true)}
              disabled={sortedSteps.length === 0}
              className="px-3 py-1.5 min-h-[44px] text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors disabled:opacity-40"
            >
              一括プレビュー
            </button>
            <button
              onClick={openAddStep}
              className="px-3 py-1.5 min-h-[44px] text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
              style={{ backgroundColor: '#06C755' }}
            >
              + ステップ追加
            </button>
          </div>
        </div>

        {/* Step form */}
        {showStepForm && (
          <div className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
            <h4 className="text-sm font-medium text-gray-700 mb-3">
              {editingStepId ? 'ステップを編集' : '新しいステップを追加'}
            </h4>
            <div className="space-y-3 max-w-lg">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">ステップ順序</label>
                <input
                  type="number"
                  min={1}
                  className="w-32 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                  value={stepForm.stepOrder}
                  onChange={(e) => setStepForm({ ...stepForm, stepOrder: Number(e.target.value) })}
                />
              </div>
              <ScheduleInput
                mode={deliveryMode}
                value={stepForm.schedule}
                onChange={(schedule) => setStepForm({ ...stepForm, schedule })}
              />

              {/* 入力モード切替: 直接入力 / テンプレート参照 */}
              <div className="space-y-2">
                <label className="block text-xs font-medium text-gray-600">メッセージの指定方法</label>
                <div className="flex gap-4 text-sm">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      checked={stepForm.inputMode === 'direct'}
                      onChange={() => setStepForm({ ...stepForm, inputMode: 'direct', templateId: null })}
                    />
                    <span>直接入力</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      checked={stepForm.inputMode === 'template'}
                      onChange={() => setStepForm({ ...stepForm, inputMode: 'template' })}
                    />
                    <span>テンプレートを使う</span>
                  </label>
                </div>
              </div>

              {stepForm.inputMode === 'template' && (
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">テンプレート <span className="text-red-500">*</span></label>
                  <select
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                    value={stepForm.templateId ?? ''}
                    onChange={(e) => setStepForm({ ...stepForm, templateId: e.target.value || null })}
                  >
                    <option value="">-- 選択してください --</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}{t.category ? ` (${t.category})` : ''}</option>
                    ))}
                  </select>
                  <p className="text-xs text-amber-700 mt-1">
                    ⓘ テンプレートが修正されると、このステップの内容も自動で同期されます
                  </p>
                </div>
              )}

              {stepForm.inputMode === 'direct' && (
                <>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">メッセージタイプ</label>
                    <select
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                      value={stepForm.messageType}
                      onChange={(e) => {
                        resetStepBuilderFeedback()
                        setStepForm({ ...stepForm, messageType: e.target.value as MessageType })
                      }}
                    >
                      {messageTypeOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      メッセージ内容 <span className="text-red-500">*</span>
                      {stepForm.messageType === 'image' && (
                        <span className="ml-1 text-gray-400">(JSON形式)</span>
                      )}
                    </label>

                    {/* 画像: アップローダで LINE 画像 JSON を自動生成 (W5 T-E4) */}
                    {stepForm.messageType === 'image' && (
                      <div className="mb-2">
                        <ImageUploader
                          mode="line-image"
                          value={(() => {
                            try {
                              const parsed = JSON.parse(stepForm.messageContent) as { originalContentUrl?: string; previewImageUrl?: string }
                              if (parsed.originalContentUrl) {
                                return { mode: 'line-image' as const, originalContentUrl: parsed.originalContentUrl, previewImageUrl: parsed.previewImageUrl ?? parsed.originalContentUrl }
                              }
                            } catch { /* ignore */ }
                            return null
                          })()}
                          onChange={(v) => {
                            if (v?.mode === 'line-image') {
                              setStepForm({ ...stepForm, messageContent: JSON.stringify({ originalContentUrl: v.originalContentUrl, previewImageUrl: v.previewImageUrl }) })
                            } else {
                              setStepForm({ ...stepForm, messageContent: '' })
                            }
                          }}
                          label="送信する画像"
                        />
                      </div>
                    )}

                    {/* image: 生 JSON は <details> で上級者に格下げ (findings A3)。
                        flex: ビジュアルビルダー起動 + プレビュー、生 JSON textarea は上級者折りたたみへ (T-A5)。
                        text: 従来どおり textarea。 */}
                    {stepForm.messageType === 'image' ? (
                      <details className="mt-1">
                        <summary className="text-xs text-gray-400 cursor-pointer select-none">上級者向け: 画像 JSON を直接編集</summary>
                        <textarea
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-y mt-2"
                          rows={3}
                          placeholder='{"originalContentUrl":"...","previewImageUrl":"..."}'
                          value={stepForm.messageContent}
                          onChange={(e) => setStepForm({ ...stepForm, messageContent: e.target.value })}
                          style={{ fontFamily: 'monospace' }}
                        />
                      </details>
                    ) : stepForm.messageType === 'flex' ? (
                      <div className="space-y-3">
                        {stepForm.messageContent && (() => { try { JSON.parse(stepForm.messageContent); return true } catch { return false } })() ? (
                          <div className="border border-gray-200 rounded-lg p-3">
                            <FlexPreviewComponent content={stepForm.messageContent} maxWidth={300} />
                            <div className="mt-2 flex gap-2">
                              <button
                                ref={stepBuilderTriggerRef}
                                type="button"
                                onClick={openStepBuilder}
                                className="px-3 py-1.5 min-h-[36px] text-xs font-medium text-green-700 border border-green-500 bg-green-50 rounded-md hover:bg-green-100"
                              >
                                ✎ カードを編集
                              </button>
                              <button
                                type="button"
                                onClick={() => setStepForm({ ...stepForm, messageContent: '' })}
                                className="px-3 py-1.5 min-h-[36px] text-xs font-medium text-gray-500 border border-gray-300 rounded-md hover:text-red-600"
                              >
                                🗑 削除
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            ref={stepBuilderTriggerRef}
                            type="button"
                            onClick={openStepBuilder}
                            className="w-full min-h-[44px] px-4 py-3 text-sm font-medium text-white rounded-md"
                            style={{ backgroundColor: '#06C755' }}
                          >
                            🎨 ビジュアルでカードを作る
                          </button>
                        )}
                        {stepRebuildConfirmOpen && (
                          <div
                            role="alertdialog"
                            aria-label="Flexを新しく作り直す確認"
                            aria-describedby="scenario-flex-rebuild-description"
                            onKeyDown={(event) => {
                              if (event.key === 'Escape') {
                                event.preventDefault()
                                cancelStepBuilderRebuild()
                              }
                            }}
                            className="rounded-lg border border-amber-300 bg-amber-50 p-3"
                          >
                            <p id="scenario-flex-rebuild-description" className="text-sm text-amber-900">{flexRebuildPrompt}</p>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <button
                                ref={stepRebuildConfirmButtonRef}
                                type="button"
                                onClick={confirmStepBuilderRebuild}
                                className="min-h-[40px] rounded-md bg-amber-600 px-3 py-2 text-xs font-medium text-white hover:bg-amber-700"
                              >
                                新しく作り直す
                              </button>
                              <button
                                type="button"
                                onClick={cancelStepBuilderRebuild}
                                className="min-h-[40px] rounded-md border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50"
                              >
                                キャンセル
                              </button>
                            </div>
                          </div>
                        )}
                        {stepBuilderError && (
                          <p role="alert" className="text-xs text-red-600">{stepBuilderError}</p>
                        )}
                        <div>
                          <button
                            type="button"
                            onClick={() => setStepAdvancedJsonOpen((v) => !v)}
                            className="text-xs text-gray-500 hover:text-gray-700"
                          >
                            {stepAdvancedJsonOpen ? '▾' : '▸'} 上級者向け: JSONを直接貼り付ける
                          </button>
                          {stepAdvancedJsonOpen && (
                            <div className="mt-2">
                              <textarea
                                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-y"
                                rows={8}
                                placeholder='{"type":"bubble","body":{...}}'
                                value={stepForm.messageContent}
                                onChange={(e) => {
                                  let next = e.target.value
                                  try {
                                    const parsed = JSON.parse(next)
                                    if (parsed && typeof parsed === 'object' && parsed.type === 'flex' && parsed.contents) {
                                      next = JSON.stringify(parsed.contents, null, 2)
                                    }
                                  } catch { /* 入力途中は無視 */ }
                                  setStepForm({ ...stepForm, messageContent: next })
                                }}
                                style={{ fontFamily: 'monospace' }}
                              />
                              <p className="text-xs text-gray-400 mt-1">
                                ⓘ contents(bubble/carousel)だけを貼ってください。message object を貼ると contents だけ自動で取り出します。
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                    ) : (
                      <PersonalizedTextEditor
                        mode="variables-and-emoji"
                        ariaLabel="ステップのメッセージ内容"
                        placeholder="メッセージ内容を入力..."
                        value={stepForm.messageContent}
                        onChange={(messageContent) => setStepForm({ ...stepForm, messageContent })}
                      />
                    )}
                  </div>
                </>
              )}

              {/* 到達時のアクション */}
              <div className="pt-3 border-t border-gray-200 space-y-2">
                <h4 className="text-xs font-semibold text-gray-700">到達時のアクション</h4>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">到達したらタグ付与</label>
                  <select
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                    value={stepForm.onReachTagId ?? ''}
                    onChange={(e) => setStepForm({ ...stepForm, onReachTagId: e.target.value || null })}
                  >
                    <option value="">-- なし --</option>
                    {tags.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-400 mt-0.5">
                    このステップが配信完了したら、選んだタグを友だちに付与します
                  </p>
                </div>
              </div>

              {/* 分岐条件（回答／タグで枝分かれ・slice-1） */}
              <div className="pt-3 border-t border-gray-200 space-y-2">
                <h4 className="text-xs font-semibold text-gray-700">分岐条件（任意）</h4>
                <p className="text-xs text-gray-400 leading-relaxed">
                  条件を設定すると、条件に合う友だちだけがこのステップに進みます。合わない友だちは「不成立のときの飛び先」へ分岐します（未設定なら次のステップへ順送り）。
                </p>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">条件の種類</label>
                  <select
                    aria-label="分岐条件の種類"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                    value={stepForm.conditionType ?? ''}
                    onChange={(e) =>
                      setStepForm({
                        ...stepForm,
                        conditionType: (e.target.value || null) as BranchConditionType | null,
                      })
                    }
                  >
                    <option value="">なし（常にこのステップを配信）</option>
                    {branchConditionOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </div>

                {isTagCondition(stepForm.conditionType) && (
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">対象タグ</label>
                    <select
                      aria-label="分岐条件の対象タグ"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                      value={stepForm.conditionTagId ?? ''}
                      onChange={(e) => setStepForm({ ...stepForm, conditionTagId: e.target.value || null })}
                    >
                      <option value="">-- タグを選択 --</option>
                      {tags.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                    </select>
                  </div>
                )}

                {isTagNameContainsCondition(stepForm.conditionType) && (
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">タグ名に含める文字</label>
                    <input
                      type="text"
                      aria-label="タグ名に含める文字"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                      placeholder="例: 購入済"
                      value={stepForm.conditionTagNameQuery}
                      onChange={(e) => setStepForm({ ...stepForm, conditionTagNameQuery: e.target.value })}
                    />
                  </div>
                )}

                {isMetaCondition(stepForm.conditionType) && (
                  <div className="space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">項目名（設問キー）</label>
                        <input
                          type="text"
                          aria-label="回答の項目名"
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                          placeholder="例: answer"
                          value={stepForm.conditionMetaKey}
                          onChange={(e) => setStepForm({ ...stepForm, conditionMetaKey: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">値</label>
                        <input
                          type="text"
                          aria-label="回答の値"
                          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                          placeholder="例: A"
                          value={stepForm.conditionMetaValue}
                          onChange={(e) => setStepForm({ ...stepForm, conditionMetaValue: e.target.value })}
                        />
                      </div>
                    </div>
                    <p className="text-xs text-gray-400">
                      ※ フォーム回答が友だち情報（メタデータ）に保存されている場合に使えます。単一回答が対象です。
                    </p>
                  </div>
                )}

                {stepForm.conditionType && (
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">不成立のときの飛び先</label>
                    <select
                      aria-label="不成立のときの飛び先"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
                      value={stepForm.nextStepOnFalse ?? ''}
                      onChange={(e) =>
                        setStepForm({ ...stepForm, nextStepOnFalse: e.target.value ? Number(e.target.value) : null })
                      }
                    >
                      <option value="">次のステップへ順送り（スキップ）</option>
                      {sortedSteps
                        .filter((s) => s.stepOrder > stepForm.stepOrder)
                        .map((s) => (
                          <option key={s.id} value={s.stepOrder}>
                            ステップ {s.stepOrder} へ分岐
                          </option>
                        ))}
                    </select>
                    <p className="text-xs text-gray-400 mt-0.5">
                      飛び先はこのステップより後ろのステップだけを選べます（後戻りループを防ぐため）。
                    </p>
                  </div>
                )}
              </div>

              {stepError && <p className="text-xs text-red-600">{stepError}</p>}

              <div className="flex gap-2">
                {(() => {
                  const template = stepForm.inputMode === 'template' && stepForm.templateId
                    ? templates.find((item) => item.id === stepForm.templateId)
                    : null
                  const message = template
                    ? { type: template.messageType, content: template.messageContent }
                    : { type: stepForm.messageType, content: stepForm.messageContent }
                  const accountId = scenario.lineAccountId ?? selectedAccountId
                  return (
                    <TestSendDialog
                      accountIds={accountId ? [accountId] : []}
                      source={scenario.triggerType === 'friend_add' && stepForm.stepOrder === 1 ? 'greeting' : 'scenario'}
                      messages={[message]}
                      buttonLabel="この内容をテスト送信"
                      disabled={stepSaving || !accountId || !message.content.trim()}
                    />
                  )
                })()}
                <button
                  onClick={handleSaveStep}
                  disabled={stepSaving}
                  className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
                  style={{ backgroundColor: '#06C755' }}
                >
                  {stepSaving ? '保存中...' : editingStepId ? '更新' : '追加'}
                </button>
                <button
                  onClick={() => {
                    setShowStepForm(false)
                    setEditingStepId(null)
                    setStepError('')
                    resetStepBuilderFeedback()
                  }}
                  className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                >
                  キャンセル
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Steps list */}
        {sortedSteps.length === 0 ? (
          <div className="text-center py-8 text-gray-400 text-sm">
            ステップがありません。「+ ステップ追加」から追加してください。
          </div>
        ) : (
          <div className="space-y-3">
            {sortedSteps.map((step, idx) => (
              <div
                key={step.id}
                className="border border-gray-200 rounded-lg p-4 hover:border-gray-300 transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-2 flex-wrap">
                      <span
                        className="inline-flex items-center justify-center w-7 h-7 rounded-full text-xs font-bold text-white shrink-0"
                        style={{ backgroundColor: '#06C755' }}
                      >
                        {step.stepOrder}
                      </span>
                      <span className="text-xs text-gray-500">{formatScheduleLabel(deliveryMode, step)}</span>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        step.messageType === 'text' ? 'bg-blue-50 text-blue-600' :
                        step.messageType === 'image' ? 'bg-purple-50 text-purple-600' :
                        'bg-orange-50 text-orange-600'
                      }`}>
                        {messageTypeOptions.find(o => o.value === step.messageType)?.label ?? step.messageType}
                      </span>
                      {(() => {
                        const stat = stats?.steps.find((s) => s.stepOrder === step.stepOrder)
                        return stat ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-50 text-purple-700">
                            📊 {stat.reachedCount}人到達 ({Math.round(stat.reachRate * 100)}%)
                          </span>
                        ) : null
                      })()}
                    </div>
                    {(() => {
                      // テンプレ参照時は、表示も「現在のテンプレ内容」を見せる。
                      // (templates state には list で取得済みの最新内容が入っている)
                      const tpl = step.templateId ? templates.find((t) => t.id === step.templateId) : null
                      const displayType = tpl ? tpl.messageType : step.messageType
                      const displayContent = tpl ? tpl.messageContent : step.messageContent
                      return (
                        <div className="text-sm text-gray-700 bg-gray-50 rounded-md px-3 py-2">
                          {displayType === 'text' ? (
                            <p className="whitespace-pre-wrap break-words">{displayContent}</p>
                          ) : displayType === 'flex' ? (
                            <FlexPreview content={displayContent} />
                          ) : displayType === 'image' ? (
                            <ImagePreview content={displayContent} />
                          ) : (
                            <p className="whitespace-pre-wrap break-words">{displayContent}</p>
                          )}
                        </div>
                      )
                    })()}
                    {step.templateId && (
                      <p className="mt-2 text-xs text-amber-700">
                        📋 テンプレ: {templates.find((t) => t.id === step.templateId)?.name ?? step.templateId}
                      </p>
                    )}
                    {step.onReachTagId && (
                      <p className="mt-1 text-xs text-green-700">
                        🏷 到達タグ: {tags.find((t) => t.id === step.onReachTagId)?.name ?? step.onReachTagId}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col items-stretch gap-1 shrink-0">
                    <div className="flex gap-1">
                      <button
                        onClick={() => handleMoveStep(step.id, 'up')}
                        disabled={idx === 0}
                        className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100 transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                        aria-label="上へ"
                      >
                        ↑
                      </button>
                      <button
                        onClick={() => handleMoveStep(step.id, 'down')}
                        disabled={idx === sortedSteps.length - 1}
                        className="text-xs text-gray-500 hover:text-gray-700 px-2 py-1 rounded hover:bg-gray-100 transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                        aria-label="下へ"
                      >
                        ↓
                      </button>
                    </div>
                    {(() => {
                      const template = step.templateId ? templates.find((item) => item.id === step.templateId) : null
                      const message = template
                        ? { type: template.messageType, content: template.messageContent }
                        : { type: step.messageType, content: step.messageContent }
                      const accountId = scenario.lineAccountId ?? selectedAccountId
                      return (
                        <TestSendDialog
                          accountIds={accountId ? [accountId] : []}
                          source={scenario.triggerType === 'friend_add' && idx === 0 ? 'greeting' : 'scenario'}
                          messages={[message]}
                          buttonLabel="テスト送信"
                          disabled={!accountId || !message.content.trim()}
                          className="px-2 py-1 min-h-0 text-xs"
                        />
                      )
                    })()}
                    <button
                      onClick={() => openEditStep(step)}
                      className="text-xs text-green-600 hover:text-green-700 px-2 py-1 rounded hover:bg-green-50 transition-colors"
                    >
                      編集
                    </button>
                    <button
                      onClick={() => handleDeleteStep(step.id)}
                      className="text-xs text-red-500 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50 transition-colors"
                    >
                      削除
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <BulkPreviewModal
        open={previewOpen}
        scenarioId={id}
        onClose={() => setPreviewOpen(false)}
      />

      {stepBuilderOpen && (
        <FlexBuilderModal
          initialModel={stepBuilderInitial}
          textEditorMode="variables-and-emoji"
          onSave={(jsonString) => {
            setStepForm((prev) => ({ ...prev, messageContent: jsonString, messageType: 'flex' }))
            setStepBuilderOpen(false)
          }}
          onClose={() => setStepBuilderOpen(false)}
        />
      )}

      {enrollOpen && (
        <EnrollFriendDialog
          scenarioId={id}
          onClose={() => setEnrollOpen(false)}
          onEnrolled={() => reloadStats()}
        />
      )}
    </div>
  )
}
