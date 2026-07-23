const ALERT_DELAY_MS = 15 * 60_000;
const REPEAT_ALERT_MS = 6 * 60 * 60_000;
const ALERT_CLAIM_STALE_MS = 5 * 60_000;
const DELIVERY_TIMEOUT_MS = 10_000;

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface SheetsSyncAlertRow {
  id: string;
  line_account_id: string | null;
  account_name: string | null;
  sheet_name: string;
  last_sync_at: string | null;
  last_sync_status: 'idle' | 'running' | 'success' | 'warning' | 'error';
  last_sync_warning: string | null;
  sync_error_started_at: string | null;
  sync_alerted_at: string | null;
  sync_alert_claimed_at: string | null;
  sync_recovery_pending_at: string | null;
}

export interface RunSheetsSyncAlertsOptions {
  db: D1Database;
  webhookUrl?: string | null;
  now?: Date;
  fetcher?: Fetcher;
  deliveryTimeoutMs?: number;
}

export interface SheetsSyncAlertResult {
  scanned: number;
  alertsSent: number;
  recoveriesSent: number;
  failures: number;
}

function compactLabel(value: string | null, fallback: string, limit: number): string {
  const compact = value?.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return (compact || fallback).slice(0, limit);
}

function timestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function alertMessage(row: SheetsSyncAlertRow): string {
  const account = compactLabel(row.account_name ?? row.line_account_id, 'アカウント', 100);
  const connection = compactLabel(row.sheet_name, '接続名なし', 200);
  const reason = compactLabel(
    row.last_sync_warning,
    '同期処理でエラーが発生しました',
    500,
  );
  return `⚠️ [${account}] スプレッドシート同期が15分以上失敗しています。接続: ${connection} / 理由: ${reason}。管理画面の連携設定から確認してください`;
}

function recoveryMessage(row: SheetsSyncAlertRow): string {
  const connection = compactLabel(row.sheet_name, '接続名なし', 200);
  return `✅ スプレッドシート同期が復旧しました(${connection})`;
}

async function postDiscord(
  fetcher: Fetcher,
  webhookUrl: string,
  content: string,
  timeoutMs: number,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('sheets_sync_alert_delivery_failed');
  } finally {
    clearTimeout(timeout);
  }
}

async function establishErrorStart(
  db: D1Database,
  row: SheetsSyncAlertRow,
  nowIso: string,
): Promise<string | null> {
  if (row.sync_error_started_at) return row.sync_error_started_at;
  const startedAt = timestamp(row.last_sync_at) === null ? nowIso : row.last_sync_at!;
  const result = await db.prepare(
    `UPDATE sheets_connections SET sync_error_started_at = ?
     WHERE id = ? AND last_sync_status = 'error' AND sync_error_started_at IS NULL`,
  ).bind(startedAt, row.id).run();
  return (result.meta.changes ?? 0) === 1 ? startedAt : null;
}

async function claimAlert(
  db: D1Database,
  row: SheetsSyncAlertRow,
  errorStartedAt: string,
  nowIso: string,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE sheets_connections SET sync_alert_claimed_at = ?
     WHERE id = ? AND last_sync_status = 'error' AND sync_error_started_at = ?
       AND ((? IS NULL AND sync_alerted_at IS NULL) OR sync_alerted_at = ?)
       AND ((? IS NULL AND sync_alert_claimed_at IS NULL) OR sync_alert_claimed_at = ?)`,
  ).bind(
    nowIso,
    row.id,
    errorStartedAt,
    row.sync_alerted_at,
    row.sync_alerted_at,
    row.sync_alert_claimed_at,
    row.sync_alert_claimed_at,
  ).run();
  return (result.meta.changes ?? 0) === 1;
}

async function restoreAlertClaim(
  db: D1Database,
  row: SheetsSyncAlertRow,
  claimedAt: string,
): Promise<void> {
  await db.prepare(
    `UPDATE sheets_connections SET sync_alert_claimed_at = ?
     WHERE id = ? AND sync_alert_claimed_at = ?`,
  ).bind(row.sync_alert_claimed_at, row.id, claimedAt).run();
}

async function finalizeAlertClaim(
  db: D1Database,
  row: SheetsSyncAlertRow,
  errorStartedAt: string,
  claimedAt: string,
): Promise<void> {
  await db.prepare(
    `UPDATE sheets_connections
     SET sync_alert_claimed_at = NULL,
         sync_alerted_at = CASE
           WHEN last_sync_status = 'success' THEN ?
           WHEN last_sync_status IN ('error', 'running') AND sync_error_started_at = ? THEN ?
           ELSE sync_alerted_at
         END,
         sync_recovery_pending_at = CASE
           WHEN last_sync_status = 'success'
             THEN COALESCE(sync_recovery_pending_at, last_sync_at, ?)
           WHEN last_sync_status IN ('error', 'running')
             AND (sync_error_started_at IS NULL OR sync_error_started_at <> ?)
             THEN COALESCE(sync_recovery_pending_at, ?)
           ELSE sync_recovery_pending_at
         END
     WHERE id = ? AND sync_alert_claimed_at = ?`,
  ).bind(
    claimedAt,
    errorStartedAt,
    claimedAt,
    claimedAt,
    errorStartedAt,
    claimedAt,
    row.id,
    claimedAt,
  ).run();
}

async function claimRecovery(db: D1Database, row: SheetsSyncAlertRow): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE sheets_connections
     SET sync_recovery_pending_at = NULL,
         sync_alerted_at = CASE
           WHEN last_sync_status = 'success' THEN NULL
           ELSE sync_alerted_at
         END
     WHERE id = ? AND sync_recovery_pending_at = ?`,
  ).bind(row.id, row.sync_recovery_pending_at).run();
  return (result.meta.changes ?? 0) === 1;
}

async function restoreRecoveryClaim(db: D1Database, row: SheetsSyncAlertRow): Promise<void> {
  await db.prepare(
    `UPDATE sheets_connections
     SET sync_recovery_pending_at = ?,
         sync_alerted_at = CASE
           WHEN last_sync_status = 'success' AND sync_alerted_at IS NULL THEN ?
           ELSE sync_alerted_at
         END
     WHERE id = ? AND sync_recovery_pending_at IS NULL`,
  ).bind(row.sync_recovery_pending_at, row.sync_alerted_at, row.id).run();
}

export async function runSheetsSyncAlerts(
  options: RunSheetsSyncAlertsOptions,
): Promise<SheetsSyncAlertResult> {
  const result: SheetsSyncAlertResult = {
    scanned: 0,
    alertsSent: 0,
    recoveriesSent: 0,
    failures: 0,
  };
  const webhookUrl = options.webhookUrl?.trim();
  if (!webhookUrl) return result;

  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const fetcher = options.fetcher ?? fetch;
  const requestedTimeout = options.deliveryTimeoutMs ?? DELIVERY_TIMEOUT_MS;
  const deliveryTimeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(1, Math.min(60_000, Math.trunc(requestedTimeout)))
    : DELIVERY_TIMEOUT_MS;
  const rows = (await options.db.prepare(
    `SELECT c.id, c.line_account_id, a.name AS account_name, c.sheet_name,
            c.last_sync_at, c.last_sync_status, c.last_sync_warning,
            c.sync_error_started_at, c.sync_alerted_at,
            c.sync_alert_claimed_at, c.sync_recovery_pending_at
     FROM sheets_connections c
     LEFT JOIN line_accounts a ON a.id = c.line_account_id
     WHERE c.is_active = 1 AND c.deleted_at IS NULL
     ORDER BY c.id ASC`,
  ).all<SheetsSyncAlertRow>()).results;
  result.scanned = rows.length;

  for (const row of rows) {
    try {
      if (row.sync_recovery_pending_at !== null) {
        if (await claimRecovery(options.db, row)) {
          try {
            await postDiscord(fetcher, webhookUrl, recoveryMessage(row), deliveryTimeoutMs);
            result.recoveriesSent += 1;
            row.sync_recovery_pending_at = null;
            if (row.last_sync_status === 'success') row.sync_alerted_at = null;
          } catch {
            result.failures += 1;
            await restoreRecoveryClaim(options.db, row).catch(() => undefined);
          }
        }
      }

      if (row.last_sync_status === 'error') {
        const errorStartedAt = await establishErrorStart(options.db, row, nowIso);
        const errorStartedMs = timestamp(errorStartedAt);
        if (errorStartedAt === null || errorStartedMs === null) continue;
        if (nowMs - errorStartedMs < ALERT_DELAY_MS) continue;

        const previousAlertedMs = timestamp(row.sync_alerted_at);
        if (row.sync_alerted_at !== null && (
          previousAlertedMs === null || nowMs - previousAlertedMs < REPEAT_ALERT_MS
        )) continue;
        const claimedMs = timestamp(row.sync_alert_claimed_at);
        if (row.sync_alert_claimed_at !== null && claimedMs !== null
          && nowMs - claimedMs < ALERT_CLAIM_STALE_MS) continue;
        if (!await claimAlert(options.db, row, errorStartedAt, nowIso)) continue;

        try {
          await postDiscord(fetcher, webhookUrl, alertMessage(row), deliveryTimeoutMs);
          await finalizeAlertClaim(options.db, row, errorStartedAt, nowIso);
          result.alertsSent += 1;
        } catch {
          result.failures += 1;
          await restoreAlertClaim(options.db, row, nowIso).catch(() => undefined);
        }
        continue;
      }

    } catch {
      result.failures += 1;
    }
  }

  return result;
}
