/**
 * form-response-display-fix (T-C1): 回答データ画面の送信日時 JST 表示ヘルパ。
 *   mirror submitted_at は Formaloo created_at (UTC ISO・末尾 Z) をそのまま保存 → slice-only 表示だと UTC のまま。
 *   formatJstMinute は epoch に +9h shift して JST 壁時計 'YYYY-MM-DD HH:mm' を出す (packages/db toJstString 同型)。
 *   tz 明示入力 (Z / +00:00 / +09:00) は真の instant から正しい JST を出す = 二重変換にならない。
 */
import { describe, it, expect } from 'vitest'
import { formatJstMinute } from './datetime'

describe('formatJstMinute — UTC→JST 表示変換 (T-C1)', () => {
  it('UTC (Z) 入力を +9h して JST 壁時計を出す (08:18Z → 17:18)', () => {
    expect(formatJstMinute('2026-07-18T08:18:33Z')).toBe('2026-07-18 17:18')
  })

  it('秒・ミリ秒を丸めて分精度・空白区切りにする', () => {
    expect(formatJstMinute('2026-07-18T08:18:59.500Z')).toBe('2026-07-18 17:18')
  })

  it('+00:00 明示入力も Z と同じ JST を出す', () => {
    expect(formatJstMinute('2026-07-18T08:18:00+00:00')).toBe('2026-07-18 17:18')
  })

  it('+09:00 入力 (既に JST の editedAt) を二重変換しない', () => {
    // 17:18:33+09:00 の真の instant は 08:18:33Z → +9h shift で JST 壁時計 17:18 に戻る (二重変換なし)。
    expect(formatJstMinute('2026-07-18T17:18:33+09:00')).toBe('2026-07-18 17:18')
  })

  it('日跨ぎ: 23:30Z は翌日 08:30 JST', () => {
    expect(formatJstMinute('2026-07-18T23:30:00Z')).toBe('2026-07-19 08:30')
  })

  it('空/null/undefined は throw せず — を返す', () => {
    expect(formatJstMinute('')).toBe('—')
    expect(formatJstMinute(null)).toBe('—')
    expect(formatJstMinute(undefined)).toBe('—')
  })

  it('解釈不能な文字列は throw せず原文を返す (壊さない fallback)', () => {
    expect(formatJstMinute('not-a-date')).toBe('not-a-date')
  })
})
