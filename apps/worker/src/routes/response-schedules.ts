import { Hono } from 'hono';
import { getResponseSchedule, upsertResponseSchedule } from '@line-crm/db';
import type { OutsideHoursMode } from '@line-crm/db';
import type { Env } from '../index.js';

const responseSchedules = new Hono<Env>();

const OUTSIDE_MODES: OutsideHoursMode[] = ['auto_reply', 'away_message', 'none'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * server 側の weekly_hours 検証 (client と二重で持つ)。day は 0-6 (getUTCDay 準拠)、
 * 営業日は open/close が 'HH:MM' 形式。定休日 (closed) は時刻を問わない。
 */
function validateWeeklyHours(weeklyHours: unknown): string | null {
  if (!Array.isArray(weeklyHours)) return 'weeklyHours must be an array';
  for (const entry of weeklyHours) {
    if (typeof entry !== 'object' || entry === null) return 'invalid weekly_hours entry';
    const e = entry as Record<string, unknown>;
    if (typeof e.day !== 'number' || !Number.isInteger(e.day) || e.day < 0 || e.day > 6) {
      return 'day must be an integer 0-6';
    }
    if (typeof e.closed !== 'boolean') return 'closed must be a boolean';
    if (!e.closed) {
      if (typeof e.open !== 'string' || !HHMM.test(e.open)) return 'open must be HH:MM';
      if (typeof e.close !== 'string' || !HHMM.test(e.close)) return 'close must be HH:MM';
    }
  }
  return null;
}

// GET /api/response-schedules?accountId= — 保存済み or 既定 (is_enabled=false) を返す
responseSchedules.get('/api/response-schedules', async (c) => {
  const accountId = c.req.query('accountId') ?? null;
  const existing = await getResponseSchedule(c.env.DB, accountId);
  const data = existing ?? {
    id: null,
    lineAccountId: accountId,
    isEnabled: false,
    timezone: 'Asia/Tokyo',
    outsideHoursMode: 'auto_reply' as OutsideHoursMode,
    awayMessage: null,
    weeklyHours: [],
  };
  return c.json({ success: true, data });
});

// PUT /api/response-schedules — upsert (client+server 二重検証の server 側)
responseSchedules.put('/api/response-schedules', async (c) => {
  const body = await c.req.json<{
    accountId?: string | null;
    isEnabled?: boolean;
    outsideHoursMode?: string;
    awayMessage?: string | null;
    weeklyHours?: unknown;
  }>();

  const mode = body.outsideHoursMode as OutsideHoursMode;
  if (!OUTSIDE_MODES.includes(mode)) {
    return c.json({ success: false, error: 'invalid outsideHoursMode' }, 400);
  }

  const whError = validateWeeklyHours(body.weeklyHours ?? []);
  if (whError) {
    return c.json({ success: false, error: whError }, 400);
  }

  const awayMessage = body.awayMessage ?? null;
  if (mode === 'away_message' && !(awayMessage ?? '').trim()) {
    return c.json({ success: false, error: 'away_message is required when outsideHoursMode is away_message' }, 400);
  }

  const saved = await upsertResponseSchedule(c.env.DB, {
    lineAccountId: body.accountId ?? null,
    isEnabled: Boolean(body.isEnabled),
    outsideHoursMode: mode,
    awayMessage,
    weeklyHours: (body.weeklyHours ?? []) as never,
  });

  return c.json({ success: true, data: saved });
});

export { responseSchedules };
