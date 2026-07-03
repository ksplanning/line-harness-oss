import { jstNow } from './utils.js';
// =============================================================================
// Response Schedules (G28 応答時間帯) — 営業時間内=オペレーター対応 /
// 時間外=自動応答 or 不在メッセージ。webhook 受信時 (cron 非依存) に参照される。
// =============================================================================

export type OutsideHoursMode = 'auto_reply' | 'away_message' | 'none';

/** 曜日別営業時間の 1 エントリ。day は JS getUTCDay 準拠 (0=日曜 .. 6=土曜)。 */
export interface DayHours {
  day: number;
  closed: boolean;
  open: string; // 'HH:MM'
  close: string; // 'HH:MM'
}

/** DB row の camelCase ドメイン形。weekly_hours は JSON→配列に parse 済。 */
export interface ResponseSchedule {
  id: string;
  lineAccountId: string | null;
  isEnabled: boolean;
  timezone: string;
  outsideHoursMode: OutsideHoursMode;
  awayMessage: string | null;
  weeklyHours: DayHours[];
}

interface ResponseScheduleRow {
  id: string;
  line_account_id: string | null;
  is_enabled: number;
  timezone: string;
  outside_hours_mode: OutsideHoursMode;
  away_message: string | null;
  weekly_hours: string;
  created_at: string;
  updated_at: string;
}

function serialize(row: ResponseScheduleRow): ResponseSchedule {
  let weeklyHours: DayHours[] = [];
  try {
    const parsed = JSON.parse(row.weekly_hours || '[]');
    if (Array.isArray(parsed)) weeklyHours = parsed as DayHours[];
  } catch {
    weeklyHours = [];
  }
  return {
    id: row.id,
    lineAccountId: row.line_account_id,
    isEnabled: Boolean(row.is_enabled),
    timezone: row.timezone,
    outsideHoursMode: row.outside_hours_mode,
    awayMessage: row.away_message,
    weeklyHours,
  };
}

/**
 * Return the schedule row keyed exactly to `lineAccountId`.
 *
 * `line_account_id IS ?` is null-safe: with a null binding it matches the
 * global default row (line_account_id IS NULL); with an id it matches that
 * account. Returns null when no such row exists.
 */
export async function getResponseSchedule(
  db: D1Database,
  lineAccountId: string | null,
): Promise<ResponseSchedule | null> {
  const row = await db
    .prepare(`SELECT * FROM response_schedules WHERE line_account_id IS ?`)
    .bind(lineAccountId ?? null)
    .first<ResponseScheduleRow>();
  return row ? serialize(row) : null;
}

/**
 * Webhook lookup: account-specific schedule if present, otherwise the global
 * (line_account_id IS NULL) default. Mirrors the auto_replies "account rule +
 * global rule" convention so a global schedule set by the operator actually
 * takes effect at message time.
 */
export async function getEffectiveResponseSchedule(
  db: D1Database,
  lineAccountId: string | null,
): Promise<ResponseSchedule | null> {
  if (lineAccountId) {
    const specific = await getResponseSchedule(db, lineAccountId);
    if (specific) return specific;
  }
  return getResponseSchedule(db, null);
}

export interface UpsertResponseScheduleInput {
  lineAccountId: string | null;
  isEnabled: boolean;
  timezone?: string;
  outsideHoursMode: OutsideHoursMode;
  awayMessage: string | null;
  weeklyHours: DayHours[];
}

/**
 * Insert-or-update the single schedule row for an account key. Keyed by
 * line_account_id (null = global default) so a second upsert updates the same
 * row instead of creating a duplicate. Follows the auto_replies global-row
 * convention (app-layer single-row guarantee; no UNIQUE index because SQLite
 * treats NULLs as distinct in unique indexes).
 */
export async function upsertResponseSchedule(
  db: D1Database,
  input: UpsertResponseScheduleInput,
): Promise<ResponseSchedule> {
  const now = jstNow();
  const timezone = input.timezone ?? 'Asia/Tokyo';
  const weeklyHoursJson = JSON.stringify(input.weeklyHours ?? []);

  const existing = await db
    .prepare(`SELECT id FROM response_schedules WHERE line_account_id IS ?`)
    .bind(input.lineAccountId ?? null)
    .first<{ id: string }>();

  if (existing) {
    await db
      .prepare(
        `UPDATE response_schedules
           SET is_enabled = ?, timezone = ?, outside_hours_mode = ?,
               away_message = ?, weekly_hours = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        input.isEnabled ? 1 : 0,
        timezone,
        input.outsideHoursMode,
        input.awayMessage ?? null,
        weeklyHoursJson,
        now,
        existing.id,
      )
      .run();
    return (await getResponseSchedule(db, input.lineAccountId))!;
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO response_schedules
         (id, line_account_id, is_enabled, timezone, outside_hours_mode,
          away_message, weekly_hours, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.lineAccountId ?? null,
      input.isEnabled ? 1 : 0,
      timezone,
      input.outsideHoursMode,
      input.awayMessage ?? null,
      weeklyHoursJson,
      now,
      now,
    )
    .run();
  return (await getResponseSchedule(db, input.lineAccountId))!;
}
