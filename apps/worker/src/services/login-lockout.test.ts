/**
 * T-F4 (batch F) — login lockout ポリシー (純関数)。
 *   - 閾値未満は lock なし
 *   - 非 owner は指数バックオフ (1→2→4→8→16→30 で頭打ち)
 *   - owner は hard-lock しない (1 分で頭打ち = 短窓 throttle)
 */
import { describe, it, expect } from 'vitest'
import {
  computeLockMinutes,
  lockedUntilFromNow,
  LOGIN_FAIL_THRESHOLD,
  MAX_LOCK_MINUTES,
  OWNER_MAX_THROTTLE_MINUTES,
} from './login-lockout.js'

describe('T-F4 computeLockMinutes', () => {
  it('閾値未満は lock しない (0)', () => {
    for (let n = 0; n < LOGIN_FAIL_THRESHOLD; n++) {
      expect(computeLockMinutes(n, 'staff')).toBe(0)
    }
  })

  it('非 owner は指数バックオフし MAX で頭打ち', () => {
    expect(computeLockMinutes(5, 'staff')).toBe(1)
    expect(computeLockMinutes(6, 'staff')).toBe(2)
    expect(computeLockMinutes(7, 'admin')).toBe(4)
    expect(computeLockMinutes(8, 'staff')).toBe(8)
    expect(computeLockMinutes(9, 'staff')).toBe(16)
    expect(computeLockMinutes(20, 'staff')).toBe(MAX_LOCK_MINUTES) // 頭打ち
  })

  it('owner は hard-lock しない (短窓 throttle で頭打ち)', () => {
    for (const n of [5, 10, 50, 1000]) {
      expect(computeLockMinutes(n, 'owner')).toBeLessThanOrEqual(OWNER_MAX_THROTTLE_MINUTES)
    }
    // owner でも閾値到達で最低限の throttle は掛かる (総当たりを遅くする)。
    expect(computeLockMinutes(5, 'owner')).toBe(OWNER_MAX_THROTTLE_MINUTES)
  })
})

describe('T-F4 lockedUntilFromNow', () => {
  it('now+minutes を JST 文字列で返す (未来)', () => {
    const base = new Date('2026-07-07T00:00:00.000Z')
    const s = lockedUntilFromNow(30, base)
    // JST = base + 9h + 30m = 2026-07-07T09:30
    expect(s.startsWith('2026-07-07T09:30')).toBe(true)
    expect(s).not.toContain('Z')
  })
})
