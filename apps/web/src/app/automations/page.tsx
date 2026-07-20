'use client'

import { useCallback, useEffect, useState } from 'react'
import type { Automation } from '@line-crm/shared'
import { api } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import Header from '@/components/layout/header'
import CcPromptButton from '@/components/cc-prompt-button'
import {
  AutomationRuleBuilder,
  AutomationUnsupportedNotice,
} from '@/components/automations/automation-rule-builder'
import {
  AUTOMATION_ACTION_DEFINITIONS,
  AUTOMATION_TRIGGER_DEFINITIONS,
  buildAutomationRuleChanges,
  createAutomationRuleModel,
  decodeAutomationRule,
  serializeAutomationRule,
  type AutomationRuleModel,
  type DecodedAutomationRule,
} from '@/lib/automation-rule-builder'

interface EditorState {
  mode: 'create' | 'edit'
  automation: Automation | null
  decoded: DecodedAutomationRule | null
  model: AutomationRuleModel | null
  name: string
  description: string
  priority: number
}

const inputClass = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500'

const eventTypeBadgeColor: Record<string, string> = {
  friend_add: 'bg-green-100 text-green-700',
  tag_change: 'bg-blue-100 text-blue-700',
  score_threshold: 'bg-yellow-100 text-yellow-700',
  cv_fire: 'bg-red-100 text-red-700',
  message_received: 'bg-purple-100 text-purple-700',
  calendar_booked: 'bg-indigo-100 text-indigo-700',
}

function automationSource(automation: Automation) {
  return {
    eventType: String(automation.eventType),
    conditionsJson: automation.conditionsJson ?? JSON.stringify(automation.conditions),
    actionsJson: automation.actionsJson ?? JSON.stringify(automation.actions),
  }
}

function eventTypeLabel(eventType: string): string {
  if (eventType.startsWith('incoming_webhook.')) {
    const definition = AUTOMATION_TRIGGER_DEFINITIONS.find((item) => item.kind === 'incoming_webhook.*')
    return `${definition?.label ?? '外部Webhook受信'} (${eventType.slice('incoming_webhook.'.length)})`
  }
  return AUTOMATION_TRIGGER_DEFINITIONS.find((item) => item.kind === eventType)?.label ?? eventType
}

function validateModel(model: AutomationRuleModel): string | null {
  if (model.eventType.startsWith('incoming_webhook.') && !model.eventType.slice('incoming_webhook.'.length).trim()) {
    return 'Webhookの種類を入力してください'
  }
  if (model.actions.length === 0) return 'アクションを1つ以上追加してください'

  for (const [index, action] of model.actions.entries()) {
    const definition = AUTOMATION_ACTION_DEFINITIONS[action.type]
    for (const param of definition.params) {
      if (param.required && !String(action.params[param.key] ?? '').trim()) {
        return `アクション ${index + 1}の「${param.label}」を入力してください`
      }
    }
    if (action.type === 'set_metadata') {
      try {
        const data = JSON.parse(String(action.params.data ?? ''))
        if (data === null || typeof data !== 'object' || Array.isArray(data)) {
          return `アクション ${index + 1}の追加情報はJSONオブジェクトで入力してください`
        }
      } catch {
        return `アクション ${index + 1}の追加情報JSONが正しくありません`
      }
    }
  }
  return null
}

const ccPrompts = [
  {
    title: 'オートメーションルール作成',
    prompt: `新しいオートメーションルールを作るサポートをしてください。
1. きっかけにするイベントを決める
2. 実行するアクションと入力項目を決める
3. 条件と優先度を日常語で確認する
手順を示してください。`,
  },
  {
    title: 'オートメーション効果分析',
    prompt: `現在のオートメーションルールの効果を分析してください。
1. 各ルールの発火回数と成功率を確認
2. イベントタイプ別の自動化カバレッジを評価
3. 効果の低いルールの改善提案と新規ルールの推奨
結果をレポートしてください。`,
  },
]

export default function AutomationsPage() {
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const [automations, setAutomations] = useState<Automation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  const loadAutomations = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.automations.list({ accountId: selectedAccountId || undefined })
      if (res.success) setAutomations(res.data)
      else setError(res.error)
    } catch {
      setError('オートメーションの読み込みに失敗しました。もう一度お試しください。')
    } finally {
      setLoading(false)
    }
  }, [selectedAccountId])

  useEffect(() => {
    if (!accountLoading) void loadAutomations()
  }, [accountLoading, loadAutomations])

  const closeEditor = () => {
    setEditor(null)
    setFormError('')
  }

  const openCreate = () => {
    setFormError('')
    setEditor({
      mode: 'create',
      automation: null,
      decoded: null,
      model: createAutomationRuleModel(),
      name: '',
      description: '',
      priority: 0,
    })
  }

  const openEdit = (automation: Automation) => {
    const decoded = decodeAutomationRule(automationSource(automation))
    setFormError('')
    setEditor({
      mode: 'edit',
      automation,
      decoded,
      model: decoded.supported ? decoded.model : null,
      name: automation.name,
      description: automation.description ?? '',
      priority: automation.priority,
    })
  }

  const handleSave = async () => {
    if (!editor?.model) return
    if (!editor.name.trim()) {
      setFormError('ルール名を入力してください')
      return
    }
    const modelError = validateModel(editor.model)
    if (modelError) {
      setFormError(modelError)
      return
    }

    if (editor.mode === 'edit' && editor.automation && editor.decoded?.supported) {
      const changes: Parameters<typeof api.automations.update>[1] = {}
      if (editor.name !== editor.automation.name) changes.name = editor.name
      if (editor.description !== (editor.automation.description ?? '')) {
        changes.description = editor.description || null
      }
      if (editor.priority !== editor.automation.priority) changes.priority = editor.priority
      Object.assign(changes, buildAutomationRuleChanges(editor.decoded.model, editor.model))

      if (Object.keys(changes).length === 0) {
        closeEditor()
        return
      }

      setSaving(true)
      setFormError('')
      try {
        const res = await api.automations.update(editor.automation.id, changes)
        if (res.success) {
          closeEditor()
          await loadAutomations()
        } else {
          setFormError(res.error)
        }
      } catch {
        setFormError('変更の保存に失敗しました')
      } finally {
        setSaving(false)
      }
      return
    }

    setSaving(true)
    setFormError('')
    try {
      const res = await api.automations.create({
        name: editor.name,
        description: editor.description || null,
        eventType: editor.model.eventType,
        conditions: editor.model.conditions,
        actions: editor.model.actions,
        priority: editor.priority,
        lineAccountId: selectedAccountId || undefined,
      })
      if (res.success) {
        closeEditor()
        await loadAutomations()
      } else {
        setFormError(res.error)
      }
    } catch {
      setFormError('作成に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const handleToggleActive = async (id: string, current: boolean) => {
    try {
      const res = await api.automations.update(id, { isActive: !current })
      if (res.success) await loadAutomations()
      else setError(res.error)
    } catch {
      setError('ステータスの変更に失敗しました')
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('このオートメーションを削除してもよいですか？')) return
    try {
      const res = await api.automations.delete(id)
      if (res.success) await loadAutomations()
      else setError(res.error)
    } catch {
      setError('削除に失敗しました')
    }
  }

  let editorJson: { conditionsJson: string; actionsJson: string } | null = null
  if (editor?.model) {
    editorJson = editor.decoded?.supported
      ? serializeAutomationRule(editor.decoded, editor.model)
      : {
          conditionsJson: JSON.stringify(editor.model.conditions, null, 2),
          actionsJson: JSON.stringify(editor.model.actions, null, 2),
        }
  }

  return (
    <div>
      <Header
        title="オートメーション"
        action={(
          <button
            onClick={openCreate}
            className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            + 新規ルール
          </button>
        )}
      />

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">{error}</div>
      )}

      {editor && (
        <section className="mb-6 bg-white rounded-lg shadow-sm border border-gray-200 p-6" aria-label="オートメーション編集">
          <h2 className="text-base font-semibold text-gray-800 mb-4">
            {editor.mode === 'create' ? '新規オートメーションを作成' : `「${editor.automation?.name}」を編集`}
          </h2>

          {editor.decoded && !editor.decoded.supported ? (
            <div className="space-y-4">
              <AutomationUnsupportedNotice
                reasons={editor.decoded.reasons}
                conditionsJson={editor.decoded.source.conditionsJson}
                actionsJson={editor.decoded.source.actionsJson}
              />
              <button type="button" onClick={closeEditor} className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg">
                閉じる
              </button>
            </div>
          ) : editor.model && editorJson ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <div>
                  <label htmlFor="automation-rule-name" className="block text-xs font-medium text-gray-600 mb-1">ルール名 <span className="text-red-500">*</span></label>
                  <input
                    id="automation-rule-name"
                    aria-label="ルール名"
                    className={inputClass}
                    placeholder="例: 友だち追加時にウェルカムタグ付与"
                    value={editor.name}
                    onChange={(event) => setEditor({ ...editor, name: event.target.value })}
                  />
                </div>
                <div>
                  <label htmlFor="automation-priority" className="block text-xs font-medium text-gray-600 mb-1">優先度</label>
                  <input
                    id="automation-priority"
                    type="number"
                    className={inputClass}
                    value={editor.priority}
                    onChange={(event) => setEditor({ ...editor, priority: Number.parseInt(event.target.value, 10) || 0 })}
                  />
                  <p className="mt-1 text-xs text-gray-500">数字が大きいルールから先に動きます。</p>
                </div>
              </div>
              <div>
                <label htmlFor="automation-description" className="block text-xs font-medium text-gray-600 mb-1">説明</label>
                <textarea
                  id="automation-description"
                  className={`${inputClass} resize-none`}
                  rows={2}
                  value={editor.description}
                  onChange={(event) => setEditor({ ...editor, description: event.target.value })}
                />
              </div>

              <AutomationRuleBuilder
                model={editor.model}
                onChange={(model) => setEditor({ ...editor, model })}
                conditionsJson={editorJson.conditionsJson}
                actionsJson={editorJson.actionsJson}
              />

              {formError && <p className="text-sm text-red-600">{formError}</p>}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50"
                  style={{ backgroundColor: '#06C755' }}
                >
                  {saving ? '保存中...' : editor.mode === 'create' ? '作成' : '変更を保存'}
                </button>
                <button type="button" onClick={closeEditor} className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg">
                  キャンセル
                </button>
              </div>
            </div>
          ) : null}
        </section>
      )}

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[...Array(3)].map((_, index) => (
            <div key={index} className="bg-white rounded-lg border border-gray-200 p-5 animate-pulse space-y-3">
              <div className="h-4 bg-gray-200 rounded w-3/4" />
              <div className="h-3 bg-gray-100 rounded w-full" />
              <div className="h-3 bg-gray-100 rounded w-24" />
            </div>
          ))}
        </div>
      ) : automations.length === 0 && !editor ? (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
          <p className="text-gray-500">オートメーションがありません。「新規ルール」から作成してください。</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {automations.map((automation) => {
            const decoded = decodeAutomationRule(automationSource(automation))
            const actions = Array.isArray(automation.actions) ? automation.actions : []
            const sendMsgWithTemplate = actions.filter(
              (action) => action.type === 'send_message' && typeof action.params.template_id === 'string' && action.params.template_id,
            ).length
            return (
              <article key={automation.id} className="bg-white rounded-lg shadow-sm border border-gray-200 p-5 hover:shadow-md transition-shadow">
                <div className="flex items-start justify-between mb-2">
                  <h3 className="text-sm font-semibold text-gray-900 leading-tight">{automation.name}</h3>
                  <button
                    onClick={() => handleToggleActive(automation.id, automation.isActive)}
                    className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${automation.isActive ? 'bg-green-500' : 'bg-gray-300'}`}
                    title={automation.isActive ? '有効 - クリックで無効化' : '無効 - クリックで有効化'}
                    aria-label={automation.isActive ? `${automation.name}を無効化` : `${automation.name}を有効化`}
                  >
                    <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transition ${automation.isActive ? 'translate-x-4' : 'translate-x-0'}`} />
                  </button>
                </div>

                {automation.description && <p className="text-xs text-gray-500 mb-3 line-clamp-2">{automation.description}</p>}

                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${eventTypeBadgeColor[String(automation.eventType)] ?? 'bg-slate-100 text-slate-700'}`}>
                    {eventTypeLabel(String(automation.eventType))}
                  </span>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${automation.isActive ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                    {automation.isActive ? '有効' : '無効'}
                  </span>
                  {!decoded.supported && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-800">GUI非対応</span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-4 text-xs text-gray-400 mb-3">
                  <span>アクション: {actions.length}件</span>
                  {sendMsgWithTemplate > 0 && (
                    <a href="/templates" className="text-blue-600 hover:underline">🔗 template×{sendMsgWithTemplate}</a>
                  )}
                  <span>優先度: {automation.priority}</span>
                </div>

                <div className="flex items-center justify-end gap-2 pt-2 border-t border-gray-100">
                  <button onClick={() => openEdit(automation)} className="px-3 py-1 min-h-[44px] text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-md">
                    編集
                  </button>
                  <button onClick={() => handleDelete(automation.id)} className="px-3 py-1 min-h-[44px] text-xs font-medium text-red-500 bg-red-50 hover:bg-red-100 rounded-md">
                    削除
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}
      <CcPromptButton prompts={ccPrompts} />
    </div>
  )
}
