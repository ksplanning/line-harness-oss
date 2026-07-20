import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AUTOMATION_ACTION_DEFINITIONS,
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_FIXED_TRIGGER_DEFINITIONS,
  AUTOMATION_TRIGGER_DEFINITIONS,
  buildAutomationRuleChanges,
  decodeAutomationRule,
  fingerprintAutomationSource,
  serializeAutomationRule,
  type AutomationRuleSource,
} from './automation-rule-builder'

const expectedActionTypes = [
  'add_tag',
  'remove_tag',
  'start_scenario',
  'send_message',
  'send_webhook',
  'switch_rich_menu',
  'remove_rich_menu',
  'set_metadata',
]

const bytePinnedSource: AutomationRuleSource = {
  eventType: 'message_received',
  conditionsJson: '{\n  "keyword": "資料請求"\n}',
  actionsJson: '[\n  { "type": "send_message", "params": { "content": "承知しました", "messageType": "text" } }\n]',
}

describe('automation builder registries', () => {
  it('exposes the exhaustive fixed-trigger map plus the incoming webhook family', () => {
    expect(AUTOMATION_TRIGGER_DEFINITIONS).toEqual([
      ...Object.values(AUTOMATION_FIXED_TRIGGER_DEFINITIONS),
      { kind: 'incoming_webhook.*', label: '外部Webhook受信' },
    ])
  })

  it('covers every action implemented by the worker switch', () => {
    expect(AUTOMATION_ACTION_TYPES).toEqual(expectedActionTypes)
    expect(Object.keys(AUTOMATION_ACTION_DEFINITIONS)).toEqual(expectedActionTypes)

    const workerSource = readFileSync(
      resolve(process.cwd(), '../worker/src/services/event-bus.ts'),
      'utf8',
    )
    const switchStart = workerSource.indexOf('switch (action.type)')
    const switchEnd = workerSource.indexOf('default:', switchStart)
    const actionSwitch = workerSource.slice(switchStart, switchEnd)
    const workerActionTypes = [...actionSwitch.matchAll(/case '([^']+)':/g)].map((match) => match[1])
    expect(workerActionTypes).toEqual(expectedActionTypes)
  })

  it.each(expectedActionTypes)('round-trips the default %s action without semantic loss', (type) => {
    const definition = AUTOMATION_ACTION_DEFINITIONS[type]
    const source: AutomationRuleSource = {
      eventType: 'friend_add',
      conditionsJson: '{}',
      actionsJson: JSON.stringify([{ type, params: definition.defaultParams }]),
    }

    const decoded = decodeAutomationRule(source)
    expect(decoded.supported).toBe(true)
    if (!decoded.supported) return
    expect(decoded.model.actions).toEqual([{ type, params: definition.defaultParams }])
    expect(serializeAutomationRule(decoded, decoded.model)).toEqual({
      conditionsJson: source.conditionsJson,
      actionsJson: source.actionsJson,
    })
  })
})

describe('automation JSON safety', () => {
  it('pins the exact source fingerprint and returns the original bytes when untouched', () => {
    expect(fingerprintAutomationSource(bytePinnedSource)).toBe('fnv1a32:74440fd9')
    const decoded = decodeAutomationRule(bytePinnedSource)
    expect(decoded.supported).toBe(true)
    if (!decoded.supported) return

    expect(buildAutomationRuleChanges(decoded.model, decoded.model)).toEqual({})
    expect(serializeAutomationRule(decoded, decoded.model)).toEqual({
      conditionsJson: bytePinnedSource.conditionsJson,
      actionsJson: bytePinnedSource.actionsJson,
    })
  })

  it('only emits the JSON field whose meaning changed', () => {
    const decoded = decodeAutomationRule(bytePinnedSource)
    expect(decoded.supported).toBe(true)
    if (!decoded.supported) return
    const draft = {
      ...decoded.model,
      conditions: { ...decoded.model.conditions, keyword_exact: '資料請求' },
    }

    expect(buildAutomationRuleChanges(decoded.model, draft)).toEqual({
      conditions: { keyword: '資料請求', keyword_exact: '資料請求' },
    })
    expect(serializeAutomationRule(decoded, draft)).toEqual({
      conditionsJson: '{\n  "keyword": "資料請求",\n  "keyword_exact": "資料請求"\n}',
      actionsJson: bytePinnedSource.actionsJson,
    })
  })

  it.each([
    ['unknown trigger', { eventType: 'manual_test', conditionsJson: '{}', actionsJson: '[]' }],
    ['broken conditions JSON', { eventType: 'friend_add', conditionsJson: '{', actionsJson: '[]' }],
    ['unknown condition', { eventType: 'friend_add', conditionsJson: '{"future":true}', actionsJson: '[]' }],
    ['broken actions JSON', { eventType: 'friend_add', conditionsJson: '{}', actionsJson: '[' }],
    ['non-array actions', { eventType: 'friend_add', conditionsJson: '{}', actionsJson: '{}' }],
    ['null action item', { eventType: 'friend_add', conditionsJson: '{}', actionsJson: '[null]' }],
    ['null action params', { eventType: 'friend_add', conditionsJson: '{}', actionsJson: '[{"type":"send_message","params":null}]' }],
    ['unknown action', { eventType: 'friend_add', conditionsJson: '{}', actionsJson: '[{"type":"future","params":{}}]' }],
    ['unknown action parameter', { eventType: 'friend_add', conditionsJson: '{}', actionsJson: '[{"type":"add_tag","params":{"tagId":"vip","future":true}}]' }],
  ] satisfies Array<[string, AutomationRuleSource]>)('fails safe for %s and retains its source', (_label, source) => {
    const decoded = decodeAutomationRule(source)
    expect(decoded.supported).toBe(false)
    expect(decoded.source).toEqual(source)
    expect(decoded.reasons.length).toBeGreaterThan(0)
  })

  it('accepts a concrete incoming webhook trigger', () => {
    const source: AutomationRuleSource = {
      eventType: 'incoming_webhook.stripe',
      conditionsJson: '{}',
      actionsJson: '[{"type":"send_webhook","params":{"url":"https://example.test/hook"}}]',
    }
    expect(decodeAutomationRule(source).supported).toBe(true)
  })
})
