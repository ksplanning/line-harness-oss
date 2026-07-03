/**
 * isWithinBusinessHours 純関数テスト (G28 / tz 安全)。
 *
 * 判定は Asia/Tokyo 壁時計 (Date.now()+9h の getUTCDay/getUTCHours)。clock を
 * ミリ秒で注入して境界を固定検証する:
 *   - 開店ちょうど=内 / 閉店ちょうど=外 / 範囲内=内・範囲外=外
 *   - 深夜跨ぎ (22:00-02:00 の 23:00=内・01:00=内・03:00=外)
 *   - 前日からの深夜跨ぎ window の当日早朝への spillover (定休翌日でも延長は営業中)
 *   - 定休日=外 / weekly_hours 空=外
 *   - JST 固定時刻を UTC ミリ秒で与えても 9h ズレず正しい曜日/時刻で判定
 */
import { describe, test, expect } from 'vitest';
import { isWithinBusinessHours } from './business-hours';

/** JST 壁時計の日時から曜日 index (getUTCDay 準拠 0=日..6=土) を返すヘルパ。 */
function jstDay(nowMs: number): number {
  return new Date(nowMs + 9 * 3600 * 1000).getUTCDay();
}
const ms = (jst: string) => Date.parse(jst);

describe('isWithinBusinessHours', () => {
  test('open time inclusive / close time exclusive', () => {
    const at = ms('2026-07-06T09:00:00+09:00'); // 月曜 09:00 JST
    const schedule = { weeklyHours: [{ day: jstDay(at), closed: false, open: '09:00', close: '18:00' }] };
    expect(isWithinBusinessHours(schedule, ms('2026-07-06T09:00:00+09:00'))).toBe(true); // 開店ちょうど=内
    expect(isWithinBusinessHours(schedule, ms('2026-07-06T18:00:00+09:00'))).toBe(false); // 閉店ちょうど=外
    expect(isWithinBusinessHours(schedule, ms('2026-07-06T13:30:00+09:00'))).toBe(true); // 範囲内=内
    expect(isWithinBusinessHours(schedule, ms('2026-07-06T08:59:00+09:00'))).toBe(false); // 範囲外=外
    expect(isWithinBusinessHours(schedule, ms('2026-07-06T18:01:00+09:00'))).toBe(false); // 範囲外=外
  });

  test('cross-midnight window (22:00-02:00) covers both night and early morning of the same day entry', () => {
    const anchor = ms('2026-07-06T23:00:00+09:00');
    const schedule = { weeklyHours: [{ day: jstDay(anchor), closed: false, open: '22:00', close: '02:00' }] };
    expect(isWithinBusinessHours(schedule, ms('2026-07-06T23:00:00+09:00'))).toBe(true); // 23:00=内
    expect(isWithinBusinessHours(schedule, ms('2026-07-06T01:00:00+09:00'))).toBe(true); // 01:00=内
    expect(isWithinBusinessHours(schedule, ms('2026-07-06T03:00:00+09:00'))).toBe(false); // 03:00=外
  });

  test('previous-day cross-midnight window spills into the next morning even if that day is 定休', () => {
    // 火曜 01:00 JST。月曜 22:00-02:00 営業・火曜は定休。月曜夜の延長として内であるべき。
    const tue0100 = ms('2026-07-07T01:00:00+09:00');
    const monDay = jstDay(ms('2026-07-06T23:00:00+09:00'));
    const tueDay = jstDay(tue0100);
    const schedule = {
      weeklyHours: [
        { day: monDay, closed: false, open: '22:00', close: '02:00' },
        { day: tueDay, closed: true, open: '', close: '' },
      ],
    };
    expect(isWithinBusinessHours(schedule, tue0100)).toBe(true);
    // 火曜 03:00 は月曜窓 (〜02:00) を過ぎ、火曜は定休 → 外
    expect(isWithinBusinessHours(schedule, ms('2026-07-07T03:00:00+09:00'))).toBe(false);
  });

  test('closed day is always outside', () => {
    const at = ms('2026-07-06T13:00:00+09:00');
    const schedule = { weeklyHours: [{ day: jstDay(at), closed: true, open: '09:00', close: '18:00' }] };
    expect(isWithinBusinessHours(schedule, at)).toBe(false);
  });

  test('empty weekly_hours is always outside', () => {
    expect(isWithinBusinessHours({ weeklyHours: [] }, ms('2026-07-06T13:00:00+09:00'))).toBe(false);
  });

  test('JST wall-clock: same instant given as UTC ms is judged in JST, not shifted by 9h', () => {
    // 10:00 JST = 01:00 UTC。JST 曜日の 09:00-18:00 に対し「内」でなければ 9h ズレ。
    const at = ms('2026-07-06T10:00:00+09:00');
    const schedule = { weeklyHours: [{ day: jstDay(at), closed: false, open: '09:00', close: '18:00' }] };
    expect(isWithinBusinessHours(schedule, at)).toBe(true);
  });
});
