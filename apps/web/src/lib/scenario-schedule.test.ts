/**
 * T-A2 — scenario-schedule 共有ユーティリティ（待機ラベル整形）の単体テスト。
 * 目的: detail-client から切り出した formatDelay / formatScheduleLabel が
 *       relative / elapsed / absolute_time の 3 mode で従来と同一ラベルを返すこと（再発明防止・単一正本）。
 */
import { describe, it, expect } from 'vitest'
import type { ScenarioStep } from '@line-crm/shared'
import { formatDelay, formatScheduleLabel } from './scenario-schedule'

function step(partial: Partial<ScenarioStep>): ScenarioStep {
  return {
    id: 's',
    scenarioId: 'sc',
    stepOrder: 1,
    delayMinutes: 0,
    offsetDays: null,
    offsetMinutes: null,
    deliveryTime: null,
    templateId: null,
    onReachTagId: null,
    messageType: 'text',
    messageContent: '',
    createdAt: '2026-07-12T00:00:00.000',
    ...partial,
  }
}

describe('formatDelay', () => {
  it('0 分は 即時', () => expect(formatDelay(0)).toBe('即時'))
  it('60 分未満は 分後', () => expect(formatDelay(45)).toBe('45分後'))
  it('ちょうど 1 時間', () => expect(formatDelay(60)).toBe('1時間後'))
  it('時間+分', () => expect(formatDelay(125)).toBe('2時間5分後'))
  it('ちょうど 1 日', () => expect(formatDelay(1440)).toBe('1日後'))
  it('日+時間', () => expect(formatDelay(1500)).toBe('1日1時間後'))
})

describe('formatScheduleLabel（3 mode）', () => {
  it('relative: delayMinutes を formatDelay に委譲', () => {
    expect(formatScheduleLabel('relative', step({ delayMinutes: 90 }))).toBe('1時間30分後')
    expect(formatScheduleLabel('relative', step({ delayMinutes: 0 }))).toBe('即時')
  })
  it('elapsed: 0/0 は 即時 (購読開始)', () => {
    expect(formatScheduleLabel('elapsed', step({ offsetDays: 0, offsetMinutes: 0 }))).toBe('即時 (購読開始)')
  })
  it('elapsed: 日数のみ', () => {
    expect(formatScheduleLabel('elapsed', step({ offsetDays: 3, offsetMinutes: 0 }))).toBe('購読開始から3日後')
  })
  it('elapsed: 日+時間+分', () => {
    expect(formatScheduleLabel('elapsed', step({ offsetDays: 1, offsetMinutes: 90 }))).toBe('購読開始から1日1時間30分後')
  })
  it('absolute_time: 日後の HH:MM', () => {
    expect(formatScheduleLabel('absolute_time', step({ offsetDays: 2, deliveryTime: '09:30' }))).toBe('購読開始から2日後の 09:30')
  })
  it('mode undefined は relative 扱い', () => {
    expect(formatScheduleLabel(undefined, step({ delayMinutes: 30 }))).toBe('30分後')
  })
})
