/**
 * 期間限定リッチメニューのスケジュール自動切替 (F2 batch4 G17) — **dark-ship**。
 *
 * 二重 dark-ship: (1) KS 本番 crons=[] (wrangler.ks.toml) で scheduled handler 自体が発火しない。
 * (2) scheduled handler は RICH_MENU_SCHEDULE_ENABLED==='true' の時だけ本 job を push する (既定 OFF)。
 * さらに本 module は既定で **実 LINE menu 切替 API を叩かない** (onActivate/onExpire を注入しない限り
 * 計画をログするだけ)。実切替の配線は owner 立会後 (real switcher 注入)。本 batch は「開始/終了を設定でき、
 * 切替の DECISION ロジックが決定論で動く」まで。
 */

export interface ScheduledMenuGroupRow {
  id: string;
  account_id: string;
  status: string;
  schedule_start: string | null;
  schedule_end: string | null;
}

export type ScheduleAction = 'activate' | 'expire';

export interface ScheduledMenuChange {
  groupId: string;
  accountId: string;
  action: ScheduleAction;
}

/** RICH_MENU_SCHEDULE_ENABLED が 'true' の時だけ有効 (既定 OFF = dark)。 */
export function isRichMenuScheduleEnabled(env: { RICH_MENU_SCHEDULE_ENABLED?: string }): boolean {
  return env.RICH_MENU_SCHEDULE_ENABLED === 'true';
}

/**
 * 期間限定メニューの切替計画を決定論的に計算する (純関数)。
 *  - schedule_start <= now < schedule_end かつ未公開 → activate (期間に入った)
 *  - now >= schedule_end かつ公開中 → expire (期間が終わったので既定に戻す)
 * schedule 未設定 (両方 null) の group は対象外。start のみ/end のみも扱える (欠けた側は ±∞)。
 */
export function computeScheduledMenuChanges(
  groups: ScheduledMenuGroupRow[],
  now: Date,
): ScheduledMenuChange[] {
  const nowMs = now.getTime();
  const changes: ScheduledMenuChange[] = [];
  for (const g of groups) {
    if (!g.schedule_start && !g.schedule_end) continue;
    const startMs = g.schedule_start ? new Date(g.schedule_start).getTime() : -Infinity;
    const endMs = g.schedule_end ? new Date(g.schedule_end).getTime() : Infinity;
    const inWindow = nowMs >= startMs && nowMs < endMs;
    if (inWindow && g.status !== 'published') {
      changes.push({ groupId: g.id, accountId: g.account_id, action: 'activate' });
    } else if (!inWindow && Number.isFinite(endMs) && nowMs >= endMs && g.status === 'published') {
      changes.push({ groupId: g.id, accountId: g.account_id, action: 'expire' });
    }
  }
  return changes;
}

export interface RichMenuScheduleOpts {
  now?: Date;
  /** 実 activate 切替の executor (owner 立会後に注入)。未指定 = dark (ログのみ・LINE を叩かない)。 */
  onActivate?: (groupId: string, accountId: string) => Promise<void>;
  /** 実 expire 切替の executor (owner 立会後に注入)。未指定 = dark。 */
  onExpire?: (groupId: string, accountId: string) => Promise<void>;
}

export interface RichMenuScheduleResult {
  changes: ScheduledMenuChange[];
  /** 実際に switcher を呼んだ件数 (dark 実行時は 0)。 */
  switched: number;
}

/**
 * schedule 設定済み group を読み、切替計画を計算する。onActivate/onExpire が注入されていればそれで切替を
 * 実行 (owner 立会後)、未注入なら **dark** (計画をログするだけで LINE menu 切替 API を叩かない)。
 */
export async function processRichMenuSchedule(
  db: D1Database,
  opts: RichMenuScheduleOpts = {},
): Promise<RichMenuScheduleResult> {
  const now = opts.now ?? new Date();
  const rows = await db
    .prepare(
      `SELECT id, account_id, status, schedule_start, schedule_end FROM rich_menu_groups
        WHERE schedule_start IS NOT NULL OR schedule_end IS NOT NULL`,
    )
    .all<ScheduledMenuGroupRow>();
  const changes = computeScheduledMenuChanges(rows.results ?? [], now);
  let switched = 0;
  for (const ch of changes) {
    if (ch.action === 'activate' && opts.onActivate) {
      await opts.onActivate(ch.groupId, ch.accountId);
      switched++;
    } else if (ch.action === 'expire' && opts.onExpire) {
      await opts.onExpire(ch.groupId, ch.accountId);
      switched++;
    } else {
      // dark-ship: 実切替は owner 立会後に配線する。ここでは計画をログするだけ (LINE を叩かない)。
      console.log(`[rich-menu-schedule] (dark) would ${ch.action} group ${ch.groupId} (account ${ch.accountId})`);
    }
  }
  return { changes, switched };
}
