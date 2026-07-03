/**
 * campaigns/aggregate-view.ts の純ロジック検証 (率計算 / null 整形 / fallback 名 / client 検証)。
 */
import { describe, test, expect } from 'vitest'
import {
  openRate,
  clickRate,
  formatCount,
  formatRate,
  broadcastDisplayName,
  validateCampaignName,
} from './aggregate-view'

describe('openRate / clickRate', () => {
  test('computes percentage to 1 decimal', () => {
    expect(openRate({ totalTarget: 1000, totalOpened: 258 })).toBe(25.8)
    expect(clickRate({ totalTarget: 1000, totalClicked: 69 })).toBe(6.9)
  })
  test('null when opened/clicked is null (insight 未取得)', () => {
    expect(openRate({ totalTarget: 1000, totalOpened: null })).toBeNull()
    expect(clickRate({ totalTarget: 1000, totalClicked: null })).toBeNull()
  })
  test('null when target is 0 (division guard)', () => {
    expect(openRate({ totalTarget: 0, totalOpened: 10 })).toBeNull()
  })
})

describe('formatCount / formatRate', () => {
  test('null renders as -', () => {
    expect(formatCount(null)).toBe('-')
    expect(formatRate(null)).toBe('-')
  })
  test('0 renders as 0 (not -)', () => {
    expect(formatCount(0, '人')).toBe('0人')
  })
  test('thousands separator + suffix', () => {
    expect(formatCount(1240, '人')).toBe('1,240人')
    expect(formatRate(25.8)).toBe('25.8%')
  })
})

describe('broadcastDisplayName (L-3 fallback)', () => {
  test('uses title when present', () => {
    expect(broadcastDisplayName({ title: '春のお知らせ', broadcastId: 'abc123456' })).toBe('春のお知らせ')
  })
  test('falls back to last 6 chars of id when title is null/blank', () => {
    expect(broadcastDisplayName({ title: null, broadcastId: 'uuid-xyz789' })).toBe('名前未取得 (ID: xyz789)')
    expect(broadcastDisplayName({ title: '  ', broadcastId: 'uuid-abc012' })).toBe('名前未取得 (ID: abc012)')
  })
})

describe('validateCampaignName', () => {
  test('rejects empty/whitespace', () => {
    expect(validateCampaignName('  ').ok).toBe(false)
  })
  test('rejects over 100 chars', () => {
    expect(validateCampaignName('あ'.repeat(101)).ok).toBe(false)
  })
  test('accepts a normal name', () => {
    expect(validateCampaignName('春の販促')).toEqual({ ok: true })
  })
})
