import type {
  AutomationAction,
  AutomationActionType,
  AutomationEventType,
} from '@line-crm/shared'

export type FixedAutomationEventType = Exclude<AutomationEventType, `incoming_webhook.${string}`>

export interface AutomationTriggerDefinition {
  kind: FixedAutomationEventType | 'incoming_webhook.*'
  label: string
}

type AutomationFixedTriggerDefinitions = {
  readonly [EventType in FixedAutomationEventType]: {
    readonly kind: EventType
    readonly label: string
  }
}

export const AUTOMATION_FIXED_TRIGGER_DEFINITIONS = {
  friend_add: { kind: 'friend_add', label: '友だち追加' },
  tag_change: { kind: 'tag_change', label: 'タグ変更' },
  score_threshold: { kind: 'score_threshold', label: 'スコア閾値' },
  cv_fire: { kind: 'cv_fire', label: 'CV発火' },
  message_received: { kind: 'message_received', label: 'メッセージ受信' },
  calendar_booked: { kind: 'calendar_booked', label: 'カレンダー予約' },
} satisfies AutomationFixedTriggerDefinitions

export const AUTOMATION_TRIGGER_DEFINITIONS: readonly AutomationTriggerDefinition[] = [
  ...Object.values(AUTOMATION_FIXED_TRIGGER_DEFINITIONS),
  { kind: 'incoming_webhook.*', label: '外部Webhook受信' },
]

export interface AutomationActionParamDefinition {
  key: string
  label: string
  control: 'text' | 'url' | 'textarea' | 'select'
  required?: boolean
  options?: ReadonlyArray<{ value: string; label: string }>
  placeholder?: string
}

export interface AutomationActionDefinition {
  label: string
  defaultParams: Record<string, string>
  params: readonly AutomationActionParamDefinition[]
}

export const AUTOMATION_ACTION_TYPES: readonly AutomationActionType[] = [
  'add_tag',
  'remove_tag',
  'start_scenario',
  'send_message',
  'send_webhook',
  'switch_rich_menu',
  'remove_rich_menu',
  'set_metadata',
]

export const AUTOMATION_ACTION_DEFINITIONS: Record<AutomationActionType, AutomationActionDefinition> = {
  add_tag: {
    label: 'タグを付ける',
    defaultParams: { tagId: '' },
    params: [{ key: 'tagId', label: 'タグID', control: 'text', required: true, placeholder: 'tag-uuid' }],
  },
  remove_tag: {
    label: 'タグを外す',
    defaultParams: { tagId: '' },
    params: [{ key: 'tagId', label: 'タグID', control: 'text', required: true, placeholder: 'tag-uuid' }],
  },
  start_scenario: {
    label: 'シナリオを開始する',
    defaultParams: { scenarioId: '' },
    params: [{ key: 'scenarioId', label: 'シナリオID', control: 'text', required: true, placeholder: 'scenario-uuid' }],
  },
  send_message: {
    label: 'メッセージを送る',
    defaultParams: { messageType: 'text', content: '' },
    params: [
      { key: 'template_id', label: 'テンプレートID（任意）', control: 'text', placeholder: 'template-uuid' },
      {
        key: 'messageType',
        label: 'メッセージ形式',
        control: 'select',
        options: [
          { value: 'text', label: 'テキスト' },
          { value: 'flex', label: 'Flex' },
          { value: 'image', label: '画像' },
        ],
      },
      { key: 'content', label: '本文', control: 'textarea' },
      { key: 'altText', label: '代替テキスト（任意）', control: 'text' },
    ],
  },
  send_webhook: {
    label: 'Webhookを送る',
    defaultParams: { url: '' },
    params: [{ key: 'url', label: '送信先URL', control: 'url', required: true, placeholder: 'https://example.com/hook' }],
  },
  switch_rich_menu: {
    label: 'リッチメニューを切り替える',
    defaultParams: { richMenuId: '' },
    params: [{ key: 'richMenuId', label: 'リッチメニューID', control: 'text', required: true, placeholder: 'richmenu-...' }],
  },
  remove_rich_menu: {
    label: 'リッチメニューを外す',
    defaultParams: {},
    params: [],
  },
  set_metadata: {
    label: '友だち情報を更新する',
    defaultParams: { data: '{}' },
    params: [{ key: 'data', label: '追加する情報（JSON文字列）', control: 'textarea', required: true, placeholder: '{"source":"{{message}}"}' }],
  },
} satisfies Record<AutomationActionType, AutomationActionDefinition>

export const AUTOMATION_CONDITION_DEFINITIONS = [
  { key: 'score_threshold', label: 'スコアがこの値以上', control: 'number' as const },
  { key: 'tag_id', label: 'タグIDが一致', control: 'text' as const },
  { key: 'keyword', label: 'メッセージに含む言葉', control: 'text' as const },
  { key: 'keyword_exact', label: 'メッセージと完全一致する言葉', control: 'text' as const },
] as const

type AutomationConditionKey = typeof AUTOMATION_CONDITION_DEFINITIONS[number]['key']

export interface AutomationRuleSource {
  eventType: string
  conditionsJson: string
  actionsJson: string
}

export interface AutomationRuleModel {
  eventType: AutomationEventType
  conditions: Partial<Record<AutomationConditionKey, string | number>>
  actions: AutomationAction[]
}

interface DecodedAutomationRuleBase {
  source: AutomationRuleSource
  sourceFingerprint: string
}

export interface SupportedAutomationRule extends DecodedAutomationRuleBase {
  supported: true
  model: AutomationRuleModel
}

export interface UnsupportedAutomationRule extends DecodedAutomationRuleBase {
  supported: false
  reasons: string[]
}

export type DecodedAutomationRule = SupportedAutomationRule | UnsupportedAutomationRule

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseJson(source: string, label: string, reasons: string[]): unknown {
  try {
    return JSON.parse(source)
  } catch {
    reasons.push(`${label}のJSONが壊れています`)
    return undefined
  }
}

function isSupportedEventType(eventType: string): eventType is AutomationEventType {
  return AUTOMATION_TRIGGER_DEFINITIONS.some((definition) => {
    if (definition.kind === 'incoming_webhook.*') {
      return eventType.startsWith('incoming_webhook.') && eventType.slice('incoming_webhook.'.length).length > 0
    }
    return definition.kind === eventType
  })
}

function validateConditions(value: unknown, reasons: string[]): value is AutomationRuleModel['conditions'] {
  if (!isRecord(value)) {
    reasons.push('条件がJSONオブジェクトではありません')
    return false
  }

  const supportedKeys = new Set<string>(AUTOMATION_CONDITION_DEFINITIONS.map((definition) => definition.key))
  let valid = true
  for (const [key, fieldValue] of Object.entries(value)) {
    if (!supportedKeys.has(key)) {
      reasons.push(`未対応の条件があります: ${key}`)
      valid = false
      continue
    }
    if (key === 'score_threshold') {
      if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)) {
        reasons.push('スコア条件が数値ではありません')
        valid = false
      }
    } else if (typeof fieldValue !== 'string') {
      reasons.push(`${key} が文字列ではありません`)
      valid = false
    }
  }
  return valid
}

function validateActions(value: unknown, reasons: string[]): value is AutomationAction[] {
  if (!Array.isArray(value)) {
    reasons.push('アクションが配列ではありません')
    return false
  }

  let valid = true
  for (const [index, action] of value.entries()) {
    if (!isRecord(action) || typeof action.type !== 'string' || !isRecord(action.params)) {
      reasons.push(`${index + 1}番目のアクション形式に対応していません`)
      valid = false
      continue
    }
    const actionKeys = Object.keys(action)
    if (actionKeys.some((key) => key !== 'type' && key !== 'params')) {
      reasons.push(`${index + 1}番目のアクションに未対応の項目があります`)
      valid = false
    }
    if (!AUTOMATION_ACTION_TYPES.includes(action.type as AutomationActionType)) {
      reasons.push(`未対応のアクションです: ${action.type}`)
      valid = false
      continue
    }

    const definition = AUTOMATION_ACTION_DEFINITIONS[action.type as AutomationActionType]
    const allowedParams = new Map(definition.params.map((param) => [param.key, param]))
    for (const [key, paramValue] of Object.entries(action.params)) {
      const param = allowedParams.get(key)
      if (!param) {
        reasons.push(`${action.type} に未対応の設定があります: ${key}`)
        valid = false
        continue
      }
      if (typeof paramValue !== 'string') {
        reasons.push(`${action.type}.${key} が文字列ではありません`)
        valid = false
        continue
      }
      if (param.options && !param.options.some((option) => option.value === paramValue)) {
        reasons.push(`${action.type}.${key} の値に対応していません`)
        valid = false
      }
    }
  }
  return valid
}

export function fingerprintAutomationSource(source: AutomationRuleSource): string {
  const framed = `${source.eventType.length}:${source.eventType}|${source.conditionsJson.length}:${source.conditionsJson}|${source.actionsJson.length}:${source.actionsJson}`
  let hash = 0x811c9dc5
  for (let index = 0; index < framed.length; index += 1) {
    hash ^= framed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `fnv1a32:${hash.toString(16).padStart(8, '0')}`
}

export function decodeAutomationRule(source: AutomationRuleSource): DecodedAutomationRule {
  const reasons: string[] = []
  const conditions = parseJson(source.conditionsJson, '条件', reasons)
  const actions = parseJson(source.actionsJson, 'アクション', reasons)

  if (!isSupportedEventType(source.eventType)) {
    reasons.push(`未対応のイベントです: ${source.eventType}`)
  }
  const conditionsSupported = conditions !== undefined && validateConditions(conditions, reasons)
  const actionsSupported = actions !== undefined && validateActions(actions, reasons)
  const base: DecodedAutomationRuleBase = {
    source,
    sourceFingerprint: fingerprintAutomationSource(source),
  }

  if (reasons.length > 0 || !conditionsSupported || !actionsSupported || !isSupportedEventType(source.eventType)) {
    return { ...base, supported: false, reasons }
  }

  return {
    ...base,
    supported: true,
    model: {
      eventType: source.eventType,
      conditions,
      actions,
    },
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function semanticEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

export function buildAutomationRuleChanges(
  original: AutomationRuleModel,
  draft: AutomationRuleModel,
): Partial<Pick<AutomationRuleModel, 'eventType' | 'conditions' | 'actions'>> {
  const changes: Partial<Pick<AutomationRuleModel, 'eventType' | 'conditions' | 'actions'>> = {}
  if (original.eventType !== draft.eventType) changes.eventType = draft.eventType
  if (!semanticEqual(original.conditions, draft.conditions)) changes.conditions = draft.conditions
  if (!semanticEqual(original.actions, draft.actions)) changes.actions = draft.actions
  return changes
}

export function serializeAutomationRule(
  decoded: SupportedAutomationRule,
  draft: AutomationRuleModel,
): Pick<AutomationRuleSource, 'conditionsJson' | 'actionsJson'> {
  return {
    conditionsJson: semanticEqual(decoded.model.conditions, draft.conditions)
      ? decoded.source.conditionsJson
      : JSON.stringify(draft.conditions, null, 2),
    actionsJson: semanticEqual(decoded.model.actions, draft.actions)
      ? decoded.source.actionsJson
      : JSON.stringify(draft.actions, null, 2),
  }
}

export function createAutomationAction(type: AutomationActionType): AutomationAction {
  return {
    type,
    params: { ...AUTOMATION_ACTION_DEFINITIONS[type].defaultParams },
  }
}

export function createAutomationRuleModel(): AutomationRuleModel {
  return {
    eventType: 'friend_add',
    conditions: {},
    actions: [createAutomationAction('add_tag')],
  }
}
