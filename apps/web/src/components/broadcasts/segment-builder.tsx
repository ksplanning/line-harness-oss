'use client'

import { useState, useEffect, useCallback } from 'react'
import type { Tag } from '@line-crm/shared'
import { api } from '@/lib/api'

// 行動 rule (G11 遡及オーディエンス) の値: 期間 (過去N日) + 任意の対象。
// worker segment-query.ts / sdk types.ts の SegmentRule と同期 (3 型同期・Codex MEDIUM)。
interface BehavioralValue {
  sinceDays?: number
  trackedLinkId?: string | null
  groupId?: string
  formId?: string | null
}

interface SegmentRule {
  type:
    | 'tag_exists' | 'tag_not_exists' | 'metadata_equals' | 'metadata_not_equals' | 'is_following'
    // G11 行動 rule (F2 batch4)。
    | 'clicked_link' | 'tapped_menu' | 'opened_form'
  value: string | boolean | { key: string; value: string } | BehavioralValue
}

interface SegmentCondition {
  operator: 'AND' | 'OR'
  rules: SegmentRule[]
}

interface SegmentBuilderProps {
  tags: Tag[]
  accountId: string | null
  initialConditions?: SegmentCondition | null
  onApply: (conditions: SegmentCondition) => void
  onCancel: () => void
}

const ruleTypeLabels: Record<SegmentRule['type'], string> = {
  tag_exists: 'タグあり',
  tag_not_exists: 'タグなし',
  metadata_equals: 'メタデータ一致',
  metadata_not_equals: 'メタデータ不一致',
  is_following: 'フォロー中のみ',
  clicked_link: 'リンクをクリックした人',
  tapped_menu: 'メニューをタップした人',
  opened_form: 'フォームを開いた人',
}

const BEHAVIORAL_TYPES = new Set(['clicked_link', 'tapped_menu', 'opened_form'])

export default function SegmentBuilder({ tags, accountId, initialConditions, onApply, onCancel }: SegmentBuilderProps) {
  const [operator, setOperator] = useState<'AND' | 'OR'>(initialConditions?.operator ?? 'AND')
  const [rules, setRules] = useState<SegmentRule[]>(initialConditions?.rules ?? [{ type: 'tag_exists', value: '' }])
  const [count, setCount] = useState<number | null>(null)
  const [counting, setCounting] = useState(false)
  // 行動 rule の対象選択用リスト (トラッキングリンク / リッチメニュー)。
  const [trackedLinks, setTrackedLinks] = useState<Array<{ id: string; name: string }>>([])
  const [menuGroups, setMenuGroups] = useState<Array<{ id: string; name: string }>>([])

  useEffect(() => {
    api.trackedLinks.list().then(r => { if (r.success && r.data) setTrackedLinks(r.data.map(l => ({ id: l.id, name: l.name }))) }).catch(() => {})
  }, [])
  useEffect(() => {
    if (!accountId) { setMenuGroups([]); return }
    api.richMenuGroups.list(accountId).then(r => { if (r.success && r.data) setMenuGroups(r.data.map(g => ({ id: g.id, name: g.name }))) }).catch(() => {})
  }, [accountId])

  const fetchCount = useCallback(async () => {
    const validRules = rules.filter(r => {
      if (r.type === 'is_following') return true
      // 行動 rule: 期間 (sinceDays) があれば有効。tapped_menu は対象メニュー (groupId) 必須。
      if (BEHAVIORAL_TYPES.has(r.type)) {
        const v = r.value as BehavioralValue
        if (typeof v !== 'object' || v === null) return false
        if (r.type === 'tapped_menu' && !v.groupId) return false
        return typeof v.sinceDays === 'number' && v.sinceDays > 0
      }
      if (typeof r.value === 'string') return r.value !== ''
      if (typeof r.value === 'object' && r.value !== null) return (r.value as { key: string }).key !== ''
      return false
    })
    if (validRules.length === 0) { setCount(null); return }

    setCounting(true)
    try {
      const res = await api.segments.count({ operator, rules: validRules }, accountId ?? undefined)
      if (res.success) setCount(res.count ?? 0)
    } catch { /* ignore */ }
    finally { setCounting(false) }
  }, [operator, rules, accountId])

  useEffect(() => {
    const timer = setTimeout(fetchCount, 500)
    return () => clearTimeout(timer)
  }, [fetchCount])

  const updateRule = (index: number, updates: Partial<SegmentRule>) => {
    setRules(prev => prev.map((r, i) => i === index ? { ...r, ...updates } as SegmentRule : r))
  }

  const removeRule = (index: number) => {
    setRules(prev => prev.filter((_, i) => i !== index))
  }

  const addRule = () => {
    setRules(prev => [...prev, { type: 'tag_exists', value: '' }])
  }

  return (
    <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-700">配信対象を絞り込む</h3>
        <select
          value={operator}
          onChange={(e) => setOperator(e.target.value as 'AND' | 'OR')}
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
              value={rule.type}
              onChange={(e) => {
                const type = e.target.value as SegmentRule['type']
                const defaultValue = type === 'is_following' ? true
                  : (type === 'metadata_equals' || type === 'metadata_not_equals') ? { key: '', value: '' }
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
                value={typeof rule.value === 'string' ? rule.value : ''}
                onChange={(e) => updateRule(i, { value: e.target.value })}
                className="text-xs border border-gray-300 rounded px-2 py-1 bg-white flex-1"
              >
                <option value="">タグを選択...</option>
                {tags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            )}

            {(rule.type === 'metadata_equals' || rule.type === 'metadata_not_equals') && (
              <>
                <input
                  type="text"
                  placeholder="key"
                  value={typeof rule.value === 'object' && rule.value !== null ? (rule.value as { key: string }).key : ''}
                  onChange={(e) => updateRule(i, { value: { key: e.target.value, value: typeof rule.value === 'object' && rule.value !== null ? (rule.value as { value: string }).value : '' } })}
                  className="text-xs border border-gray-300 rounded px-2 py-1 w-24"
                />
                <input
                  type="text"
                  placeholder="value"
                  value={typeof rule.value === 'object' && rule.value !== null ? (rule.value as { value: string }).value : ''}
                  onChange={(e) => updateRule(i, { value: { key: typeof rule.value === 'object' && rule.value !== null ? (rule.value as { key: string }).key : '', value: e.target.value } })}
                  className="text-xs border border-gray-300 rounded px-2 py-1 w-24"
                />
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
                  <span className="text-xs text-gray-500 flex-1">すべてのフォーム</span>
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
        <button onClick={addRule} className="text-xs text-blue-500 hover:text-blue-700">+ ルール追加</button>
        <span className="text-xs text-gray-500">
          {counting ? '計算中...' : count != null ? `該当: ${count.toLocaleString('ja-JP')}人` : ''}
        </span>
      </div>

      <div className="flex gap-2 mt-3 pt-3 border-t border-gray-200">
        <button
          onClick={() => onApply({ operator, rules })}
          className="px-3 py-1.5 min-h-[44px] text-xs font-medium text-white rounded-md"
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
