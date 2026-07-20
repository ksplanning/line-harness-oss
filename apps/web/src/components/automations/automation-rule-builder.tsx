'use client'

import type { AutomationActionType, AutomationEventType } from '@line-crm/shared'
import {
  AUTOMATION_ACTION_DEFINITIONS,
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_CONDITION_DEFINITIONS,
  AUTOMATION_TRIGGER_DEFINITIONS,
  createAutomationAction,
  type AutomationRuleModel,
} from '@/lib/automation-rule-builder'

interface AutomationRuleBuilderProps {
  model: AutomationRuleModel
  onChange: (model: AutomationRuleModel) => void
  conditionsJson: string
  actionsJson: string
}

const inputClass = 'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white'

function triggerSelectValue(eventType: string): string {
  return eventType.startsWith('incoming_webhook.') ? 'incoming_webhook.*' : eventType
}

export function AutomationRuleBuilder({
  model,
  onChange,
  conditionsJson,
  actionsJson,
}: AutomationRuleBuilderProps) {
  const selectedTrigger = triggerSelectValue(model.eventType)
  const webhookSource = model.eventType.startsWith('incoming_webhook.')
    ? model.eventType.slice('incoming_webhook.'.length)
    : 'custom'

  const updateCondition = (key: string, rawValue: string, control: 'number' | 'text') => {
    const conditions = { ...model.conditions }
    if (rawValue === '') {
      delete conditions[key as keyof typeof conditions]
    } else {
      conditions[key as keyof typeof conditions] = control === 'number' ? Number(rawValue) : rawValue
    }
    onChange({ ...model, conditions })
  }

  const updateActionType = (index: number, type: AutomationActionType) => {
    const actions = model.actions.map((action, actionIndex) => (
      actionIndex === index ? createAutomationAction(type) : action
    ))
    onChange({ ...model, actions })
  }

  const updateActionParam = (index: number, key: string, value: string) => {
    const actions = model.actions.map((action, actionIndex) => {
      if (actionIndex !== index) return action
      return { ...action, params: { ...action.params, [key]: value } }
    })
    onChange({ ...model, actions })
  }

  const removeAction = (index: number) => {
    onChange({ ...model, actions: model.actions.filter((_, actionIndex) => actionIndex !== index) })
  }

  return (
    <div className="space-y-4">
      <fieldset className="rounded-lg border border-green-200 bg-green-50/40 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">1. このイベントが起きたら</legend>
        <div className="mt-2 space-y-3">
          <div>
            <label htmlFor="automation-trigger" className="block text-xs font-medium text-gray-600 mb-1">イベント</label>
            <select
              id="automation-trigger"
              className={inputClass}
              value={selectedTrigger}
              onChange={(event) => {
                const value = event.target.value
                const eventType: AutomationEventType = value === 'incoming_webhook.*'
                  ? `incoming_webhook.${webhookSource || 'custom'}` as AutomationEventType
                  : value as AutomationEventType
                onChange({ ...model, eventType })
              }}
            >
              {AUTOMATION_TRIGGER_DEFINITIONS.map((definition) => (
                <option key={definition.kind} value={definition.kind}>{definition.label}</option>
              ))}
            </select>
          </div>

          {selectedTrigger === 'incoming_webhook.*' && (
            <div>
              <label htmlFor="automation-webhook-source" className="block text-xs font-medium text-gray-600 mb-1">Webhookの種類</label>
              <input
                id="automation-webhook-source"
                className={inputClass}
                value={webhookSource}
                placeholder="例: stripe"
                onChange={(event) => onChange({
                  ...model,
                  eventType: `incoming_webhook.${event.target.value}` as AutomationEventType,
                })}
              />
              <p className="mt-1 text-xs text-gray-500">受信Webhookの source_type と同じ文字を入力します。</p>
            </div>
          )}

          <details className="rounded-md border border-gray-200 bg-white p-3">
            <summary className="cursor-pointer text-xs font-medium text-gray-700">条件を追加（任意・すべて AND）</summary>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {AUTOMATION_CONDITION_DEFINITIONS.map((definition) => (
                <div key={definition.key}>
                  <label htmlFor={`condition-${definition.key}`} className="block text-xs font-medium text-gray-600 mb-1">
                    {definition.label}
                  </label>
                  <input
                    id={`condition-${definition.key}`}
                    type={definition.control}
                    className={inputClass}
                    value={model.conditions[definition.key] ?? ''}
                    onChange={(event) => updateCondition(definition.key, event.target.value, definition.control)}
                  />
                </div>
              ))}
            </div>
          </details>
        </div>
      </fieldset>

      <div aria-hidden="true" className="text-center text-xl font-bold text-green-600">↓</div>

      <fieldset className="rounded-lg border border-blue-200 bg-blue-50/30 p-4">
        <legend className="px-1 text-sm font-semibold text-gray-800">2. これをする</legend>
        <div className="mt-2 space-y-3">
          {model.actions.map((action, index) => {
            const number = index + 1
            const definition = AUTOMATION_ACTION_DEFINITIONS[action.type]
            return (
              <article key={index} aria-label={`アクション ${number}`} className="rounded-lg border border-gray-200 bg-white p-3 space-y-3">
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1">
                    <label htmlFor={`action-${index}-type`} className="block text-xs font-medium text-gray-600 mb-1">
                      アクション {number}の種類
                    </label>
                    <select
                      id={`action-${index}-type`}
                      className={inputClass}
                      value={action.type}
                      onChange={(event) => updateActionType(index, event.target.value as AutomationActionType)}
                    >
                      {AUTOMATION_ACTION_TYPES.map((type) => (
                        <option key={type} value={type}>{AUTOMATION_ACTION_DEFINITIONS[type].label}</option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeAction(index)}
                    className="min-h-[40px] rounded-md bg-red-50 px-3 text-xs font-medium text-red-600 hover:bg-red-100"
                    aria-label={`アクション ${number}を削除`}
                  >
                    削除
                  </button>
                </div>

                {definition.params.map((param) => (
                  <div key={param.key}>
                    <label htmlFor={`action-${index}-${param.key}`} className="block text-xs font-medium text-gray-600 mb-1">
                      アクション {number}: {param.label}
                    </label>
                    {param.control === 'textarea' ? (
                      <textarea
                        id={`action-${index}-${param.key}`}
                        className={`${inputClass} min-h-20 font-mono`}
                        value={String(action.params[param.key] ?? '')}
                        placeholder={param.placeholder}
                        onChange={(event) => updateActionParam(index, param.key, event.target.value)}
                      />
                    ) : param.control === 'select' ? (
                      <select
                        id={`action-${index}-${param.key}`}
                        className={inputClass}
                        value={String(action.params[param.key] ?? '')}
                        onChange={(event) => updateActionParam(index, param.key, event.target.value)}
                      >
                        {param.options?.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        id={`action-${index}-${param.key}`}
                        type={param.control}
                        className={inputClass}
                        value={String(action.params[param.key] ?? '')}
                        placeholder={param.placeholder}
                        onChange={(event) => updateActionParam(index, param.key, event.target.value)}
                      />
                    )}
                  </div>
                ))}
                {definition.params.length === 0 && (
                  <p className="text-xs text-gray-500">追加設定はありません。</p>
                )}
              </article>
            )
          })}

          <button
            type="button"
            aria-label="アクションを追加"
            onClick={() => onChange({ ...model, actions: [...model.actions, createAutomationAction('add_tag')] })}
            className="min-h-[44px] w-full rounded-lg border border-dashed border-blue-300 bg-white text-sm font-medium text-blue-700 hover:bg-blue-50"
          >
            + アクションを追加
          </button>
        </div>
      </fieldset>

      <details className="rounded-lg border border-gray-200 bg-gray-50 p-3">
        <summary className="cursor-pointer text-xs font-medium text-gray-700">JSONを表示（上級者向け・読み取り専用）</summary>
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div>
            <label htmlFor="automation-conditions-json" className="block text-xs font-medium text-gray-600 mb-1">条件JSON</label>
            <textarea id="automation-conditions-json" readOnly rows={6} className={`${inputClass} font-mono bg-gray-100`} value={conditionsJson} />
          </div>
          <div>
            <label htmlFor="automation-actions-json" className="block text-xs font-medium text-gray-600 mb-1">アクションJSON</label>
            <textarea id="automation-actions-json" readOnly rows={6} className={`${inputClass} font-mono bg-gray-100`} value={actionsJson} />
          </div>
        </div>
      </details>
    </div>
  )
}

interface AutomationUnsupportedNoticeProps {
  reasons: string[]
  conditionsJson: string
  actionsJson: string
}

export function AutomationUnsupportedNotice({
  reasons,
  conditionsJson,
  actionsJson,
}: AutomationUnsupportedNoticeProps) {
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 space-y-3">
      <div>
        <h3 className="text-sm font-semibold text-amber-900">GUI 非対応・JSON のまま保持します</h3>
        <p className="mt-1 text-xs text-amber-800">知らない形式を自動変換すると設定が壊れるため、このルールは変更せず表示だけ行います。</p>
      </div>
      {reasons.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-amber-800">
          {reasons.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      )}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div>
          <label htmlFor="unsupported-conditions-json" className="block text-xs font-medium text-amber-900 mb-1">保持中の条件JSON</label>
          <textarea id="unsupported-conditions-json" readOnly rows={6} className={`${inputClass} font-mono bg-white`} value={conditionsJson} />
        </div>
        <div>
          <label htmlFor="unsupported-actions-json" className="block text-xs font-medium text-amber-900 mb-1">保持中のアクションJSON</label>
          <textarea id="unsupported-actions-json" readOnly rows={6} className={`${inputClass} font-mono bg-white`} value={actionsJson} />
        </div>
      </div>
    </div>
  )
}
