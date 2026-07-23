'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { FriendFieldDefinition, Tag } from '@line-crm/shared'
import { api, type SegmentCondition, type SegmentRule } from '@/lib/api'

export type { SegmentCondition, SegmentRule } from '@/lib/api'

// 行動 rule (G11 遡及オーディエンス) の値: 期間 (過去N日) + 任意の対象。
// worker segment-query.ts / sdk types.ts の SegmentRule と同期 (3 型同期・Codex MEDIUM)。
interface BehavioralValue {
  sinceDays?: number
  trackedLinkId?: string | null
  groupId?: string
  formId?: string | null
}

interface SegmentBuilderProps {
  tags: Tag[]
  accountId: string | null
  initialConditions?: SegmentCondition | null
  onApply: (conditions: SegmentCondition) => void
  onCancel: () => void
  onCountChange?: (count: number | null) => void
  onDirty?: () => void
  followingOnly?: boolean
}

const ruleTypeLabels: Record<SegmentRule['type'], string> = {
  tag_exists: 'タグあり',
  tag_not_exists: 'タグなし',
  metadata_equals: 'カスタムフィールド一致',
  metadata_not_equals: 'カスタムフィールド不一致',
  metadata_empty: 'カスタムフィールドが空',
  metadata_not_empty: 'カスタムフィールドが空でない',
  is_following: 'フォロー中のみ',
  clicked_link: 'リンクをクリックした人',
  tapped_menu: 'メニューをタップした人',
  opened_form: 'フォームを開いた人',
}

const BEHAVIORAL_TYPES = new Set(['clicked_link', 'tapped_menu', 'opened_form'])
const METADATA_TYPES = new Set([
  'metadata_equals',
  'metadata_not_equals',
  'metadata_empty',
  'metadata_not_empty',
])
const METADATA_VALUE_TYPES = new Set(['metadata_equals', 'metadata_not_equals'])

function isValidRule(rule: SegmentRule): boolean {
  if (rule.type === 'is_following') return typeof rule.value === 'boolean'
  if (BEHAVIORAL_TYPES.has(rule.type)) {
    const value = rule.value as BehavioralValue
    if (typeof value !== 'object' || value === null) return false
    if (rule.type === 'tapped_menu' && !value.groupId) return false
    return typeof value.sinceDays === 'number' && value.sinceDays > 0
  }
  if (rule.type === 'tag_exists' || rule.type === 'tag_not_exists') {
    return typeof rule.value === 'string' && rule.value !== ''
  }
  if (METADATA_TYPES.has(rule.type)) {
    if (typeof rule.value !== 'object' || rule.value === null || !('key' in rule.value)) {
      return false
    }
    if (typeof rule.value.key !== 'string' || rule.value.key === '') return false
    return !METADATA_VALUE_TYPES.has(rule.type)
      || ('value' in rule.value && typeof rule.value.value === 'string')
  }
  return false
}

export default function SegmentBuilder({
  tags,
  accountId,
  initialConditions,
  onApply,
  onCancel,
  onCountChange,
  onDirty,
  followingOnly = false,
}: SegmentBuilderProps) {
  const [operator, setOperator] = useState<'AND' | 'OR'>(initialConditions?.operator ?? 'AND')
  const [rules, setRules] = useState<SegmentRule[]>(initialConditions?.rules ?? [{ type: 'tag_exists', value: '' }])
  const [count, setCount] = useState<number | null>(null)
  const [counting, setCounting] = useState(false)
  const countRequestRef = useRef(0)
  const [fieldDefinitions, setFieldDefinitions] = useState<FriendFieldDefinition[]>([])
  // 行動 rule の対象選択用リスト (トラッキングリンク / リッチメニュー / フォーム)。
  const [trackedLinks, setTrackedLinks] = useState<Array<{ id: string; name: string }>>([])
  const [menuGroups, setMenuGroups] = useState<Array<{ id: string; name: string }>>([])
  const [forms, setForms] = useState<Array<{ id: string; name: string }>>([])

  useEffect(() => {
    api.friendFieldDefinitions.list()
      .then((r) => {
        if (!r.success || !r.data) return
        setFieldDefinitions(
          r.data
            .filter((definition) => definition.isActive)
            .sort((a, b) => a.displayOrder - b.displayOrder || a.id.localeCompare(b.id)),
        )
      })
      .catch(() => {})
    api.trackedLinks.list().then(r => { if (r.success && r.data) setTrackedLinks(r.data.map(l => ({ id: l.id, name: l.name }))) }).catch(() => {})
    api.forms.list().then(r => { if (r.success && r.data) setForms(r.data.map(f => ({ id: f.id, name: f.name }))) }).catch(() => {})
  }, [])
  useEffect(() => {
    if (!accountId) { setMenuGroups([]); return }
    api.richMenuGroups.list(accountId).then(r => { if (r.success && r.data) setMenuGroups(r.data.map(g => ({ id: g.id, name: g.name }))) }).catch(() => {})
  }, [accountId])

  const allRulesValid = rules.length > 0 && rules.every(isValidRule)

  const fetchCount = useCallback(async () => {
    const requestId = ++countRequestRef.current
    if (!allRulesValid) {
      setCounting(false)
      setCount(null)
      onCountChange?.(null)
      return
    }

    setCounting(true)
    try {
      const res = await api.segments.count(
        { operator, rules },
        accountId ?? undefined,
        { followingOnly },
      )
      if (requestId !== countRequestRef.current) return
      if (res.success) {
        const nextCount = res.count ?? 0
        setCount(nextCount)
        onCountChange?.(nextCount)
      }
    } catch {
      if (requestId !== countRequestRef.current) return
      setCount(null)
      onCountChange?.(null)
    }
    finally {
      if (requestId === countRequestRef.current) setCounting(false)
    }
  }, [operator, rules, accountId, allRulesValid, followingOnly, onCountChange])

  useEffect(() => {
    const timer = setTimeout(fetchCount, 500)
    return () => clearTimeout(timer)
  }, [fetchCount])

  const updateRule = (index: number, updates: Partial<SegmentRule>) => {
    onDirty?.()
    setRules(prev => prev.map((r, i) => i === index ? { ...r, ...updates } as SegmentRule : r))
  }

  const removeRule = (index: number) => {
    onDirty?.()
    setRules(prev => prev.filter((_, i) => i !== index))
  }

  const addRule = () => {
    onDirty?.()
    setRules(prev => [...prev, { type: 'tag_exists', value: '' }])
  }

  return (
    <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-700">配信対象を絞り込む</h3>
        <select
          aria-label="条件の結合方法"
          value={operator}
          onChange={(e) => {
            onDirty?.()
            setOperator(e.target.value as 'AND' | 'OR')
          }}
          className="text-xs border border-gray-300 rounded px-2 py-1 bg-white"
        >
          <option value="AND">すべて満たす (AND)</option>
          <option value="OR">いずれか満たす (OR)</option>
        </select>
      </div>

      <div className="space-y-2 mb-3">
        {rules.map((rule, i) => (
          <div key={i} className="flex items-center gap-2 bg-white rounded border border-gray-200 p-2">
            <select
              aria-label="条件の種類"
              value={rule.type}
              onChange={(e) => {
                const type = e.target.value as SegmentRule['type']
                const defaultValue = type === 'is_following' ? true
                  : METADATA_VALUE_TYPES.has(type) ? { key: '', value: '' }
                  : METADATA_TYPES.has(type) ? { key: '' }
                  : BEHAVIORAL_TYPES.has(type) ? { sinceDays: 30 }
                  : ''
                updateRule(i, { type, value: defaultValue })
              }}
              className="text-xs border border-gray-300 rounded px-2 py-1 bg-white min-w-[120px]"
            >
              {Object.entries(ruleTypeLabels).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>

            {(rule.type === 'tag_exists' || rule.type === 'tag_not_exists') && (
              <select
                aria-label="タグ"
                value={typeof rule.value === 'string' ? rule.value : ''}
                onChange={(e) => updateRule(i, { value: e.target.value })}
                className="text-xs border border-gray-300 rounded px-2 py-1 bg-white flex-1"
              >
                <option value="">タグを選択...</option>
                {tags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}

            {METADATA_TYPES.has(rule.type) && (
              <>
                <select
                  aria-label="カスタムフィールド"
                  value={typeof rule.value === 'object' && rule.value !== null ? (rule.value as { key: string }).key : ''}
                  onChange={(e) => updateRule(i, {
                    value: METADATA_VALUE_TYPES.has(rule.type)
                      ? {
                          key: e.target.value,
                          value: typeof rule.value === 'object' && rule.value !== null && 'value' in rule.value
                            ? String(rule.value.value)
                            : '',
                        }
                      : { key: e.target.value },
                  })}
                  className="text-xs border border-gray-300 rounded px-2 py-1 bg-white flex-1"
                >
                  <option value="">カスタムフィールドを選択...</option>
                  {fieldDefinitions.map((definition) => (
                    <option key={definition.id} value={definition.name}>{definition.name}</option>
                  ))}
                </select>
                {METADATA_VALUE_TYPES.has(rule.type) && (
                  <input
                    aria-label="値"
                    type="text"
                    placeholder="値"
                    value={typeof rule.value === 'object' && rule.value !== null && 'value' in rule.value ? String(rule.value.value) : ''}
                    onChange={(e) => updateRule(i, {
                      value: {
                        key: typeof rule.value === 'object' && rule.value !== null && 'key' in rule.value
                          ? String(rule.value.key)
                          : '',
                        value: e.target.value,
                      },
                    })}
                    className="text-xs border border-gray-300 rounded px-2 py-1 w-24"
                  />
                )}
              </>
            )}

            {BEHAVIORAL_TYPES.has(rule.type) && (
              <>
                {rule.type === 'clicked_link' && (
                  <select
                    value={(rule.value as BehavioralValue).trackedLinkId ?? ''}
                    onChange={(e) => updateRule(i, { value: { ...(rule.value as BehavioralValue), trackedLinkId: e.target.value || null } })}
                    className="text-xs border border-gray-300 rounded px-2 py-1 bg-white flex-1"
                  >
                    <option value="">すべてのリンク</option>
                    {trackedLinks.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                )}
                {rule.type === 'tapped_menu' && (
                  <select
                    value={(rule.value as BehavioralValue).groupId ?? ''}
                    onChange={(e) => updateRule(i, { value: { ...(rule.value as BehavioralValue), groupId: e.target.value } })}
                    className="text-xs border border-gray-300 rounded px-2 py-1 bg-white flex-1"
                  >
                    <option value="">メニューを選択...</option>
                    {menuGroups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                )}
                {rule.type === 'opened_form' && (
                  <select
                    value={(rule.value as BehavioralValue).formId ?? ''}
                    onChange={(e) => updateRule(i, { value: { ...(rule.value as BehavioralValue), formId: e.target.value || null } })}
                    className="text-xs border border-gray-300 rounded px-2 py-1 bg-white flex-1"
                  >
                    <option value="">すべてのフォーム</option>
                    {forms.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </select>
                )}
                <label className="text-xs text-gray-500 whitespace-nowrap">過去
                  <input
                    type="number"
                    min={1}
                    value={(rule.value as BehavioralValue).sinceDays ?? 30}
                    onChange={(e) => updateRule(i, { value: { ...(rule.value as BehavioralValue), sinceDays: Math.max(1, Number(e.target.value) || 1) } })}
                    className="text-xs border border-gray-300 rounded px-1 py-1 w-14 mx-1"
                  />日
                </label>
              </>
            )}

            {rule.type !== 'is_following' && (
              <button onClick={() => removeRule(i)} className="text-red-400 hover:text-red-600 text-xs px-1 shrink-0">×</button>
            )}
          </div>
        ))}
      </div>

      {rules.some(r => BEHAVIORAL_TYPES.has(r.type)) && (
        <p className="text-xs mb-3 rounded px-2 py-1.5" style={{ backgroundColor: '#FEF3C7', color: '#92400E' }}>
          ※ LINE の配信開封は個人単位で取得できないため、「フォームを開いた人」で代替します。リンクの URI/メッセージ・タップは計測対象外です。
        </p>
      )}

      <div className="flex items-center justify-between">
        <button aria-label="ルール追加" onClick={addRule} className="text-xs text-blue-500 hover:text-blue-700">+ ルール追加</button>
        <span className="text-xs text-gray-500">
          {counting ? '計算中...' : count != null ? `該当: ${count.toLocaleString('ja-JP')}人` : ''}
        </span>
      </div>

      <div className="flex gap-2 mt-3 pt-3 border-t border-gray-200">
        <button
          onClick={() => {
            if (allRulesValid) onApply({ operator, rules })
          }}
          disabled={!allRulesValid}
          className="px-3 py-1.5 min-h-[44px] text-xs font-medium text-white rounded-md disabled:opacity-50"
          style={{ backgroundColor: '#06C755' }}
        >
          適用
        </button>
        <button onClick={onCancel} className="px-3 py-1.5 min-h-[44px] text-xs font-medium text-gray-600 bg-gray-200 rounded-md">
          キャンセル
        </button>
      </div>
    </div>
  )
}
