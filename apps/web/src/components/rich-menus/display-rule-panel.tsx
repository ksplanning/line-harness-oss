'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  api,
  type RichMenuDisplayConditionType,
  type RichMenuDisplayRule,
  type RichMenuDisplayRuleInput,
  type RichMenuRuleReapplyJob,
} from '@/lib/api'

type MenuOption = { richMenuId: string; name: string }
type TagOption = { id: string; name: string }
type FieldOption = { id: string; name: string; isActive: boolean }

function unwrap<T>(response: { success: true; data: T } | { success: false; error: string }): T {
  if (!response.success) throw new Error(response.error)
  return response.data
}

const CONDITION_OPTIONS: Array<{ value: RichMenuDisplayConditionType; label: string }> = [
  { value: 'tag_exists', label: 'タグを持っている' },
  { value: 'tag_not_exists', label: 'タグを持っていない' },
  { value: 'metadata_equals', label: 'カスタム項目が一致' },
  { value: 'metadata_not_equals', label: 'カスタム項目が不一致' },
  { value: 'metadata_contains', label: 'カスタム項目に含む' },
  { value: 'metadata_not_contains', label: 'カスタム項目に含まない' },
  { value: 'tag_name_contains', label: 'タグ名に含む' },
  { value: 'tag_name_not_contains', label: 'タグ名に含まない' },
]

type RuleForm = {
  id: string | null
  name: string
  conditionType: RichMenuDisplayConditionType
  tagId: string
  fieldName: string
  compareValue: string
  richMenuId: string
  priority: string
  isActive: boolean
  activeFrom: string
  activeUntil: string
}

function sortRules(rules: RichMenuDisplayRule[]): RichMenuDisplayRule[] {
  return [...rules].sort((a, b) =>
    Number(b.isActive) - Number(a.isActive)
    || b.priority - a.priority
    || a.createdAt.localeCompare(b.createdAt)
    || a.id.localeCompare(b.id),
  )
}

function parseMetadataValue(raw: string): { key: string; value: string } {
  try {
    const parsed = JSON.parse(raw) as { key?: unknown; value?: unknown }
    return {
      key: typeof parsed.key === 'string' ? parsed.key : '',
      value: parsed.value === null || parsed.value === undefined ? '' : String(parsed.value),
    }
  } catch {
    return { key: '', value: '' }
  }
}

function conditionLabel(type: RichMenuDisplayConditionType): string {
  return CONDITION_OPTIONS.find((option) => option.value === type)?.label ?? type
}

type PeriodStatus = 'current' | 'upcoming' | 'ended'

function periodStatus(rule: RichMenuDisplayRule, now = Date.now()): PeriodStatus {
  if (rule.activeFrom && now < Date.parse(rule.activeFrom)) return 'upcoming'
  if (rule.activeUntil && now >= Date.parse(rule.activeUntil)) return 'ended'
  return 'current'
}

function toJstDateTimeInput(value: string | null): string {
  if (!value) return ''
  const instant = Date.parse(value)
  if (!Number.isFinite(instant)) return ''
  return new Date(instant + 9 * 60 * 60_000).toISOString().slice(0, 16)
}

function fromJstDateTimeInput(value: string): string | null {
  if (!value) return null
  return `${value}${value.length === 16 ? ':00' : ''}+09:00`
}

function formatJstDateTime(value: string): string {
  const shifted = new Date(Date.parse(value) + 9 * 60 * 60_000)
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${shifted.getUTCFullYear()}年${shifted.getUTCMonth() + 1}月${shifted.getUTCDate()}日 ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}`
}

function describePeriod(rule: RichMenuDisplayRule): string {
  if (!rule.activeFrom && !rule.activeUntil) return '期間: 無期限'
  const from = rule.activeFrom ? formatJstDateTime(rule.activeFrom) : '指定なし'
  const until = rule.activeUntil ? formatJstDateTime(rule.activeUntil) : '無期限'
  return `期間: ${from} から ${until} まで（日本時間）`
}

function initialForm(menus: MenuOption[], tags: TagOption[], fields: FieldOption[]): RuleForm {
  return {
    id: null,
    name: '',
    conditionType: 'tag_exists',
    tagId: tags[0]?.id ?? '',
    fieldName: fields.find((field) => field.isActive)?.name ?? '',
    compareValue: '',
    richMenuId: menus[0]?.richMenuId ?? '',
    priority: '0',
    isActive: true,
    activeFrom: '',
    activeUntil: '',
  }
}

export function DisplayRulePanel({ accountId, menus }: { accountId: string; menus: MenuOption[] }) {
  const [rules, setRules] = useState<RichMenuDisplayRule[]>([])
  const [tags, setTags] = useState<TagOption[]>([])
  const [fields, setFields] = useState<FieldOption[]>([])
  const [job, setJob] = useState<RichMenuRuleReapplyJob | null>(null)
  const [form, setForm] = useState<RuleForm | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [starting, setStarting] = useState(false)
  const [needsReapply, setNeedsReapply] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [rulesResponse, optionsResponse, jobResponse] = await Promise.all([
        api.richMenuDisplayRules.list(accountId),
        api.richMenuDisplayRules.options(accountId),
        api.richMenuDisplayRules.latestJob(accountId),
      ])
      setRules(sortRules(unwrap(rulesResponse)))
      const options = unwrap(optionsResponse)
      setTags(options.tags)
      setFields(options.fields)
      setJob(unwrap(jobResponse))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [accountId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (job?.status !== 'running') return
    const timer = window.setInterval(() => {
      void api.richMenuDisplayRules.latestJob(accountId).then((response) => {
        setJob(unwrap(response))
      }).catch(() => undefined)
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [accountId, job?.status])

  const menuNames = useMemo(
    () => new Map(menus.map((menu) => [menu.richMenuId, menu.name])),
    [menus],
  )
  const tagNames = useMemo(
    () => new Map(tags.map((tag) => [tag.id, tag.name])),
    [tags],
  )

  function openCreate(): void {
    setError(null)
    setForm(initialForm(menus, tags, fields))
  }

  function openEdit(rule: RichMenuDisplayRule): void {
    const metadata = rule.conditionType.startsWith('metadata_')
      ? parseMetadataValue(rule.conditionValue)
      : { key: '', value: '' }
    setError(null)
    setForm({
      id: rule.id,
      name: rule.name,
      conditionType: rule.conditionType,
      tagId: rule.conditionType === 'tag_exists' || rule.conditionType === 'tag_not_exists'
        ? rule.conditionValue
        : tags[0]?.id ?? '',
      fieldName: metadata.key || fields.find((field) => field.isActive)?.name || '',
      compareValue: rule.conditionType.startsWith('metadata_')
        ? metadata.value
        : rule.conditionType.startsWith('tag_name_') ? rule.conditionValue : '',
      richMenuId: rule.richMenuId,
      priority: String(rule.priority),
      isActive: rule.isActive,
      activeFrom: toJstDateTimeInput(rule.activeFrom),
      activeUntil: toJstDateTimeInput(rule.activeUntil),
    })
  }

  function toInput(current: RuleForm): RichMenuDisplayRuleInput | null {
    const priority = Number(current.priority)
    if (!current.name.trim() || !Number.isInteger(priority)) return null
    let conditionValue = current.compareValue.trim()
    if (current.conditionType === 'tag_exists' || current.conditionType === 'tag_not_exists') {
      conditionValue = current.tagId
    } else if (current.conditionType.startsWith('metadata_')) {
      if (!current.fieldName || !current.compareValue.trim()) return null
      conditionValue = JSON.stringify({ key: current.fieldName, value: current.compareValue })
    }
    if (!conditionValue || !current.richMenuId) return null
    return {
      name: current.name.trim(),
      conditionType: current.conditionType,
      conditionValue,
      richMenuId: current.richMenuId,
      priority,
      isActive: current.isActive,
      activeFrom: fromJstDateTimeInput(current.activeFrom),
      activeUntil: fromJstDateTimeInput(current.activeUntil),
    }
  }

  async function saveRule(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (!form) return
    if (form.activeFrom && form.activeUntil && form.activeUntil < form.activeFrom) {
      setError('終了日時は開始日時以降にしてください。')
      return
    }
    const input = toInput(form)
    if (!input) {
      setError('ルール名・条件・メニュー・整数の優先度を入力してください。')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const response = form.id
        ? await api.richMenuDisplayRules.update(accountId, form.id, input)
        : await api.richMenuDisplayRules.create(accountId, input)
      const savedRule = unwrap(response)
      setRules((current) => sortRules(
        form.id
          ? current.map((rule) => rule.id === form.id ? savedRule : rule)
          : [...current, savedRule],
      ))
      setForm(null)
      setNeedsReapply(true)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError))
    } finally {
      setSaving(false)
    }
  }

  async function toggleRule(rule: RichMenuDisplayRule): Promise<void> {
    setError(null)
    try {
      const response = await api.richMenuDisplayRules.update(accountId, rule.id, { isActive: !rule.isActive })
      const savedRule = unwrap(response)
      setRules((current) => sortRules(current.map((item) => item.id === rule.id ? savedRule : item)))
      setNeedsReapply(true)
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : String(toggleError))
    }
  }

  async function removeRule(rule: RichMenuDisplayRule): Promise<void> {
    if (!window.confirm(`「${rule.name}」を削除しますか？`)) return
    setError(null)
    try {
      await api.richMenuDisplayRules.delete(accountId, rule.id)
      setRules((current) => current.filter((item) => item.id !== rule.id))
      setNeedsReapply(true)
      if (form?.id === rule.id) setForm(null)
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError))
    }
  }

  async function startReapply(): Promise<void> {
    setStarting(true)
    setError(null)
    try {
      const response = await api.richMenuDisplayRules.startReapply(accountId)
      setJob(unwrap(response))
      setNeedsReapply(false)
    } catch (startError) {
      try {
        const latest = await api.richMenuDisplayRules.latestJob(accountId)
        setJob(unwrap(latest))
      } catch {
        // Keep the original error when even progress recovery is unavailable.
      }
      setError(startError instanceof Error ? startError.message : String(startError))
    } finally {
      setStarting(false)
    }
  }

  function describeCondition(rule: RichMenuDisplayRule): string {
    if (rule.conditionType === 'tag_exists' || rule.conditionType === 'tag_not_exists') {
      return `${conditionLabel(rule.conditionType)}: ${tagNames.get(rule.conditionValue) ?? rule.conditionValue}`
    }
    if (rule.conditionType.startsWith('metadata_')) {
      const parsed = parseMetadataValue(rule.conditionValue)
      return `${conditionLabel(rule.conditionType)}: ${parsed.key} / ${parsed.value}`
    }
    return `${conditionLabel(rule.conditionType)}: ${rule.conditionValue}`
  }

  let activeRank = 0
  const rankedRules = rules.map((rule) => {
    const status = periodStatus(rule)
    return {
      rule,
      status,
      rank: rule.isActive && status === 'current' ? ++activeRank : null,
    }
  })
  const isRunning = job?.status === 'running'

  return (
    <section className="mt-8 bg-white border border-gray-200 rounded-lg shadow-sm p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-gray-900">表示条件ルール</h2>
          <p className="mt-1 text-sm text-gray-600">
            優先度の数字が大きいルールが勝ちます。同じ数字なら、先に作ったルール、その後はID順です。
          </p>
          <p className="text-sm text-gray-600">
            どれにも合わない友だちは「全員のデフォルト」に戻ります。ルールはいくつでも追加できます。
          </p>
          <p className="text-sm text-gray-600">
            表示期間はタグ・カスタム項目の条件と一緒に判定され、期間外は勝敗の対象になりません。
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="px-3 py-2 rounded bg-green-600 text-white text-sm font-medium disabled:opacity-50"
          disabled={loading || form !== null}
        >
          ルールを追加
        </button>
      </div>

      {error && <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
      {loading && <p className="mt-4 text-sm text-gray-500">ルールを読み込み中...</p>}

      {!loading && rankedRules.length === 0 && (
        <p className="mt-4 rounded bg-gray-50 p-4 text-sm text-gray-600">
          まだルールはありません。現在のデフォルト表示は変わりません。
        </p>
      )}

      {!loading && rankedRules.length > 0 && (
        <div className="mt-4 space-y-3">
          {rankedRules.map(({ rule, rank, status }) => (
            <article key={rule.id} className={`rounded border p-4 ${rule.isActive && status === 'current' ? 'border-gray-200' : 'border-gray-200 bg-gray-50'}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded px-2 py-0.5 text-xs font-semibold ${rank === 1 ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'}`}>
                      {rank ? `候補${rank}位` : rule.isActive ? '期間外（勝敗対象外）' : '停止中（勝敗対象外）'}
                    </span>
                    <span className={`rounded px-2 py-0.5 text-xs font-semibold ${status === 'current' ? 'bg-emerald-100 text-emerald-800' : status === 'upcoming' ? 'bg-blue-100 text-blue-800' : 'bg-gray-200 text-gray-700'}`}>
                      {status === 'current' ? '今有効' : status === 'upcoming' ? '開始前' : '終了済み'}
                    </span>
                    <strong className="text-sm text-gray-900">{rule.name}</strong>
                    <span className="text-xs text-gray-500">優先度 {rule.priority}</span>
                  </div>
                  <p className="mt-2 text-sm text-gray-700">{describeCondition(rule)}</p>
                  <p className="text-sm text-gray-700">{describePeriod(rule)}</p>
                  <p className="text-sm text-gray-700">
                    表示: {menuNames.get(rule.richMenuId) ?? rule.richMenuId}
                  </p>
                </div>
                <div className="flex gap-3 text-sm">
                  <button type="button" onClick={() => openEdit(rule)} className="text-blue-700 hover:underline">編集</button>
                  <button
                    type="button"
                    onClick={() => void toggleRule(rule)}
                    aria-label={`${rule.name}を${rule.isActive ? '停止' : '有効化'}`}
                    className="text-gray-700 hover:underline"
                  >
                    {rule.isActive ? '停止' : '有効化'}
                  </button>
                  <button type="button" onClick={() => void removeRule(rule)} className="text-red-600 hover:underline">削除</button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {form && (
        <form noValidate onSubmit={(event) => void saveRule(event)} className="mt-5 rounded border border-green-200 bg-green-50/40 p-4 space-y-4">
          <h3 className="font-semibold text-sm text-gray-900">{form.id ? 'ルールを編集' : '新しいルール'}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="text-sm text-gray-700">
              <span className="block mb-1">ルール名</span>
              <input aria-label="ルール名" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} className="w-full rounded border border-gray-300 px-3 py-2" required />
            </label>
            <label className="text-sm text-gray-700">
              <span className="block mb-1">条件の種類</span>
              <select aria-label="条件の種類" value={form.conditionType} onChange={(event) => setForm({ ...form, conditionType: event.target.value as RichMenuDisplayConditionType })} className="w-full rounded border border-gray-300 px-3 py-2">
                {CONDITION_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>

            {(form.conditionType === 'tag_exists' || form.conditionType === 'tag_not_exists') && (
              <label className="text-sm text-gray-700">
                <span className="block mb-1">タグ</span>
                <select aria-label="タグ" value={form.tagId} onChange={(event) => setForm({ ...form, tagId: event.target.value })} className="w-full rounded border border-gray-300 px-3 py-2" required>
                  <option value="">選択してください</option>
                  {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
                </select>
              </label>
            )}

            {form.conditionType.startsWith('metadata_') && (
              <>
                <label className="text-sm text-gray-700">
                  <span className="block mb-1">カスタム項目</span>
                  <select aria-label="カスタム項目" value={form.fieldName} onChange={(event) => setForm({ ...form, fieldName: event.target.value })} className="w-full rounded border border-gray-300 px-3 py-2" required>
                    <option value="">選択してください</option>
                    {fields.filter((field) => field.isActive || field.name === form.fieldName).map((field) => <option key={field.id} value={field.name}>{field.name}</option>)}
                  </select>
                </label>
                <label className="text-sm text-gray-700">
                  <span className="block mb-1">比較する値</span>
                  <input aria-label="比較する値" value={form.compareValue} onChange={(event) => setForm({ ...form, compareValue: event.target.value })} className="w-full rounded border border-gray-300 px-3 py-2" required />
                </label>
              </>
            )}

            {form.conditionType.startsWith('tag_name_') && (
              <label className="text-sm text-gray-700">
                <span className="block mb-1">タグ名に含む文字</span>
                <input aria-label="タグ名に含む文字" value={form.compareValue} onChange={(event) => setForm({ ...form, compareValue: event.target.value })} className="w-full rounded border border-gray-300 px-3 py-2" required />
              </label>
            )}

            <label className="text-sm text-gray-700">
              <span className="block mb-1">表示するリッチメニュー</span>
              <select aria-label="表示するリッチメニュー" value={form.richMenuId} onChange={(event) => setForm({ ...form, richMenuId: event.target.value })} className="w-full rounded border border-gray-300 px-3 py-2" required>
                <option value="">選択してください</option>
                {!menus.some((menu) => menu.richMenuId === form.richMenuId) && form.richMenuId && (
                  <option value={form.richMenuId}>{form.richMenuId}（LINE一覧で未確認）</option>
                )}
                {menus.map((menu) => <option key={menu.richMenuId} value={menu.richMenuId}>{menu.name}</option>)}
              </select>
              {menus.length === 0 && <span className="mt-1 block text-xs text-amber-700">LINE 上のメニューを取得できないため、新規保存はできません。</span>}
            </label>
            <label className="text-sm text-gray-700">
              <span className="block mb-1">優先度</span>
              <input aria-label="優先度" type="number" step="1" min="-1000000" max="1000000" value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value })} className="w-full rounded border border-gray-300 px-3 py-2" required />
            </label>
            <fieldset className="md:col-span-2 rounded border border-gray-200 bg-white p-3">
              <legend className="px-1 text-sm font-medium text-gray-800">表示期間（日本時間）</legend>
              <p className="mb-3 text-xs text-gray-600">
                両方空欄なら無期限です。開始だけ・終了だけでも設定できます。終了日時になると対象外になります。
              </p>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <label className="text-sm text-gray-700">
                  <span className="block mb-1">いつから（任意）</span>
                  <input
                    aria-label="いつから（任意）"
                    type="datetime-local"
                    step="60"
                    value={form.activeFrom}
                    onChange={(event) => setForm({ ...form, activeFrom: event.target.value })}
                    className="w-full rounded border border-gray-300 px-3 py-2"
                  />
                </label>
                <label className="text-sm text-gray-700">
                  <span className="block mb-1">いつまで（任意）</span>
                  <input
                    aria-label="いつまで（任意）"
                    type="datetime-local"
                    step="60"
                    min={form.activeFrom || undefined}
                    value={form.activeUntil}
                    onChange={(event) => setForm({ ...form, activeUntil: event.target.value })}
                    className="w-full rounded border border-gray-300 px-3 py-2"
                  />
                </label>
              </div>
            </fieldset>
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" checked={form.isActive} onChange={(event) => setForm({ ...form, isActive: event.target.checked })} />
            保存後すぐ勝敗の候補にする
          </label>
          <div className="flex gap-3">
            <button type="submit" disabled={saving || !form.richMenuId} className="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">保存</button>
            <button type="button" onClick={() => setForm(null)} className="rounded border border-gray-300 px-4 py-2 text-sm text-gray-700">キャンセル</button>
          </div>
        </form>
      )}

      <div className="mt-6 border-t border-gray-200 pt-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-gray-900">既存の友だちへの反映</h3>
            <p className="text-xs text-gray-600">LINE の負荷を抑えるため、5分ごとに最大20人ずつ反映します。</p>
          </div>
          <button
            type="button"
            onClick={() => void startReapply()}
            disabled={starting || isRunning}
            className="rounded border border-green-600 px-3 py-2 text-sm font-medium text-green-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isRunning ? '既存の友だちへ再適用中' : starting ? '開始中...' : '既存の友だちへ再適用'}
          </button>
        </div>
        {needsReapply && <p className="mt-2 text-sm font-medium text-amber-700">ルールを変えたため、既存の友だちへ再適用してください。</p>}
        {job && (
          <div className="mt-3 rounded bg-gray-50 p-3 text-sm text-gray-700">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <strong>{job.processedCount} / {job.totalCount}人</strong>
              <span>適用 {job.appliedCount}・変更なし {job.skippedCount}・失敗 {job.failedCount}</span>
              <span>{job.status === 'running' ? '処理中' : '完了'}</span>
            </div>
            {job.failedCount > 0 && <p className="mt-1 text-xs text-amber-700">失敗した友だちは再試行キューに残り、次回以降に再評価されます。</p>}
          </div>
        )}
      </div>
    </section>
  )
}
