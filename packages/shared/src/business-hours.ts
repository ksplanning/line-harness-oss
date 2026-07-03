// =============================================================================
// Business hours (G28 応答時間帯) — 受信メッセージが営業時間内かを判定する純関数。
//
// 判定は Asia/Tokyo の壁時計で行う。Cloudflare Workers は UTC 実行なので、
// `Date.now() + 9h` を UTC として読む (getUTCDay / getUTCHours / getUTCMinutes) と
// JST の曜日・時刻が得られる。cron に依存せず webhook 受信時に評価する。
// =============================================================================

/** 曜日別営業時間の 1 エントリ。day は getUTCDay 準拠 (0=日曜 .. 6=土曜)。 */
export interface BusinessDayHours {
  day: number;
  closed: boolean;
  open: string; // 'HH:MM'
  close: string; // 'HH:MM'
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 'HH:MM' を 0-1439 の分に変換。形式不正 (空文字含む) は null。 */
function toMinutes(hhmm: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 単一曜日エントリ内で now(分) が営業時間内か。open>close は深夜跨ぎ (>=open OR <close)。 */
function entryContains(entry: BusinessDayHours | undefined, nowMin: number): boolean {
  if (!entry || entry.closed) return false;
  const o = toMinutes(entry.open);
  const c = toMinutes(entry.close);
  if (o === null || c === null) return false;
  if (o < c) return nowMin >= o && nowMin < c;
  if (o > c) return nowMin >= o || nowMin < c; // 深夜跨ぎ: 当日夜〜翌未明を同エントリで表現
  return false; // open === close は 0 長 → 常に外
}

/**
 * Whether `nowMs` (epoch ms) falls inside the account's business hours.
 *
 * - 当日エントリの window (深夜跨ぎ含む) に入っていれば内。
 * - さらに「前日が深夜跨ぎ (open>close) でその close まで」を当日早朝の spillover
 *   として内と判定する。これにより「月 22:00-02:00 営業・火 定休」でも火 01:00 は
 *   月曜営業の延長として内になる (gap-check #7)。
 * - 定休日 / エントリ無し / weekly_hours 空 は外。
 */
export function isWithinBusinessHours(
  schedule: { weeklyHours: BusinessDayHours[] },
  nowMs: number,
): boolean {
  const jst = new Date(nowMs + JST_OFFSET_MS);
  const day = jst.getUTCDay();
  const nowMin = jst.getUTCHours() * 60 + jst.getUTCMinutes();

  const entryFor = (d: number) => schedule.weeklyHours.find((e) => e.day === d);

  if (entryContains(entryFor(day), nowMin)) return true;

  // 前日の深夜跨ぎ window の早朝 tail への spillover。
  const prev = entryFor((day + 6) % 7);
  if (prev && !prev.closed) {
    const po = toMinutes(prev.open);
    const pc = toMinutes(prev.close);
    if (po !== null && pc !== null && po > pc && nowMin < pc) return true;
  }

  return false;
}
