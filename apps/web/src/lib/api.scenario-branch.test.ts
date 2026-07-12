/**
 * T-A4 (scenario-visual-p2-branch slice-1) — api client の分岐 3 列 request 契約テスト。
 *
 * worker を叩かず global.fetch を stub し、addStep / updateStep が
 * conditionType / conditionValue / nextStepOnFalse を body に載せることを assert する。
 * worker route (scenarios.ts POST/PUT steps body) は既に同名フィールドを受理する (spec §2.2)。
 * 3 列未指定の既存呼び出しは body に該当キーを含めない (byte 同等・worker が ?? null で吸収)。
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

const BASE = 'https://worker.example.test'

beforeAll(() => {
  process.env.NEXT_PUBLIC_API_URL = BASE
})

interface Captured {
  url: string
  method: string
  body: Record<string, unknown> | undefined
}

let captured: Captured[] = []

beforeEach(() => {
  captured = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      captured.push({
        url,
        method: (init?.method ?? 'GET').toUpperCase(),
        body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined,
      })
      return { ok: true, status: 200, json: async () => ({ success: true, data: null }) } as unknown as Response
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function loadApi() {
  const mod = await import('./api')
  return mod.api
}

describe('T-A4: scenarios.addStep 分岐 3 列', () => {
  test('addStep は conditionType/conditionValue/nextStepOnFalse を body に載せる', async () => {
    const api = await loadApi()
    await api.scenarios.addStep('sc_1', {
      stepOrder: 1,
      messageType: 'text',
      messageContent: 'hello',
      conditionType: 'metadata_equals',
      conditionValue: JSON.stringify({ key: 'answer', value: 'A' }),
      nextStepOnFalse: 3,
    })
    expect(captured[0].url).toBe(`${BASE}/api/scenarios/sc_1/steps`)
    expect(captured[0].method).toBe('POST')
    expect(captured[0].body).toMatchObject({
      conditionType: 'metadata_equals',
      conditionValue: JSON.stringify({ key: 'answer', value: 'A' }),
      nextStepOnFalse: 3,
    })
  })

  test('分岐 3 列を指定しない既存呼び出しは body に該当キーを含めない (byte 同等)', async () => {
    const api = await loadApi()
    await api.scenarios.addStep('sc_1', { stepOrder: 1, messageType: 'text', messageContent: 'hello' })
    const keys = Object.keys(captured[0].body ?? {})
    expect(keys).not.toContain('conditionType')
    expect(keys).not.toContain('conditionValue')
    expect(keys).not.toContain('nextStepOnFalse')
  })
})

describe('T-A4: scenarios.updateStep 分岐 3 列', () => {
  test('updateStep は分岐 3 列を body に載せる (nextStepOnFalse=null で解除も送れる)', async () => {
    const api = await loadApi()
    await api.scenarios.updateStep('sc_1', 'st_9', {
      conditionType: 'tag_exists',
      conditionValue: 'tag_42',
      nextStepOnFalse: null,
    })
    expect(captured[0].url).toBe(`${BASE}/api/scenarios/sc_1/steps/st_9`)
    expect(captured[0].method).toBe('PUT')
    expect(captured[0].body).toMatchObject({
      conditionType: 'tag_exists',
      conditionValue: 'tag_42',
      nextStepOnFalse: null,
    })
  })
})
