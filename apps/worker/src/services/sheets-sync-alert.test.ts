import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runSheetsSyncAlerts } from './sheets-sync-alert.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const WEBHOOK = 'https://discord.example.test/api/webhooks/secret-value';

function d1(raw: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = raw.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
        async run() {
          const result = statement.run(...(params as never[]));
          return { meta: { changes: result.changes } };
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

interface SeedConnection {
  id: string;
  status: 'idle' | 'running' | 'success' | 'warning' | 'error';
  lastSyncAt?: string | null;
  errorStartedAt?: string | null;
  alertedAt?: string | null;
  claimedAt?: string | null;
  recoveryPendingAt?: string | null;
  warning?: string | null;
  sheetName?: string;
}

let raw: Database.Database;
let db: D1Database;

function seedConnection(input: SeedConnection): void {
  raw.prepare(`INSERT INTO sheets_connections
    (id, line_account_id, form_id, spreadsheet_id, sheet_name,
     last_sync_at, last_sync_status, last_sync_warning,
     sync_error_started_at, sync_alerted_at,
     sync_alert_claimed_at, sync_recovery_pending_at)
    VALUES (?, 'acc-1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      input.id,
      `form-${input.id}`,
      `spreadsheet-${input.id}`,
      input.sheetName ?? `タブ-${input.id}`,
      input.lastSyncAt ?? null,
      input.status,
      input.warning ?? null,
      input.errorStartedAt ?? null,
      input.alertedAt ?? null,
      input.claimedAt ?? null,
      input.recoveryPendingAt ?? null,
    );
}

function discordContent(fetcher: ReturnType<typeof vi.fn>, call = 0): string {
  const init = fetcher.mock.calls[call]?.[1] as RequestInit | undefined;
  const payload = JSON.parse(String(init?.body)) as { content: string };
  return payload.content;
}

beforeEach(() => {
  raw = new Database(':memory:');
  raw.exec(readFileSync(join(DB_ROOT, 'bootstrap.sql'), 'utf8'));
  raw.prepare(`INSERT INTO line_accounts
    (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('acc-1', 'channel-1', 'テスト店舗', 'token', 'secret')`).run();
  db = d1(raw);
});

afterEach(() => {
  raw.close();
  vi.restoreAllMocks();
});

describe('Sheets sync Discord alerts', () => {
  test('sends a safe Japanese alert at the 15-minute boundary', async () => {
    seedConnection({
      id: 'connection-alert',
      status: 'error',
      lastSyncAt: '2026-07-23T10:14:00.000Z',
      errorStartedAt: '2026-07-23T10:00:00.000Z',
      warning: 'Googleへの接続を確認できませんでした',
      sheetName: '回答タブ',
    });
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));

    const result = await runSheetsSyncAlerts({
      db, webhookUrl: WEBHOOK, now: new Date('2026-07-23T10:15:00.000Z'), fetcher,
    });

    expect(result).toEqual({ scanned: 1, alertsSent: 1, recoveriesSent: 0, failures: 0 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(WEBHOOK, expect.objectContaining({ method: 'POST' }));
    const content = discordContent(fetcher);
    expect(content).toBe('⚠️ [テスト店舗] スプレッドシート同期が15分以上失敗しています。接続: 回答タブ / 理由: Googleへの接続を確認できませんでした。管理画面の連携設定から確認してください');
    expect(content).not.toContain('spreadsheet-connection-alert');
    expect(content).not.toContain('token');
  });

  test('does nothing before 15 minutes, for non-error state, or without a webhook', async () => {
    const prepare = vi.fn(() => { throw new Error('DB must stay untouched'); });
    const disabledFetch = vi.fn();
    await expect(runSheetsSyncAlerts({
      db: { prepare } as unknown as D1Database,
      webhookUrl: '   ',
      now: new Date('2026-07-23T10:15:00.000Z'),
      fetcher: disabledFetch,
    })).resolves.toEqual({ scanned: 0, alertsSent: 0, recoveriesSent: 0, failures: 0 });
    expect(prepare).not.toHaveBeenCalled();
    expect(disabledFetch).not.toHaveBeenCalled();

    seedConnection({
      id: 'connection-short', status: 'error',
      errorStartedAt: '2026-07-23T10:00:01.000Z', warning: '短時間の失敗',
    });
    seedConnection({ id: 'connection-success', status: 'success' });
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await runSheetsSyncAlerts({
      db, webhookUrl: WEBHOOK, now: new Date('2026-07-23T10:15:00.000Z'), fetcher,
    });
    expect(result).toEqual({ scanned: 2, alertsSent: 0, recoveriesSent: 0, failures: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  test('sends one recovery after an alerted error becomes successful', async () => {
    seedConnection({
      id: 'connection-recovery', status: 'error',
      errorStartedAt: '2026-07-23T09:00:00.000Z', warning: '同期に失敗しました',
      sheetName: '顧客一覧',
    });
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));

    await runSheetsSyncAlerts({
      db, webhookUrl: WEBHOOK, now: new Date('2026-07-23T10:00:00.000Z'), fetcher,
    });
    raw.prepare(`UPDATE sheets_connections
      SET last_sync_status = 'success', last_sync_warning = NULL,
          sync_error_started_at = NULL,
          sync_recovery_pending_at = '2026-07-23T10:05:00.000Z'
      WHERE id = 'connection-recovery'`).run();
    const recovered = await runSheetsSyncAlerts({
      db, webhookUrl: WEBHOOK, now: new Date('2026-07-23T10:05:00.000Z'), fetcher,
    });
    const repeated = await runSheetsSyncAlerts({
      db, webhookUrl: WEBHOOK, now: new Date('2026-07-23T10:10:00.000Z'), fetcher,
    });

    expect(recovered).toEqual({ scanned: 1, alertsSent: 0, recoveriesSent: 1, failures: 0 });
    expect(repeated).toEqual({ scanned: 1, alertsSent: 0, recoveriesSent: 0, failures: 0 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(discordContent(fetcher, 1)).toBe('✅ スプレッドシート同期が復旧しました(顧客一覧)');
    expect(raw.prepare(`SELECT sync_alerted_at FROM sheets_connections
      WHERE id = 'connection-recovery'`).get()).toEqual({ sync_alerted_at: null });

    raw.prepare(`UPDATE sheets_connections
      SET last_sync_status = 'error', last_sync_warning = '新しい同期失敗',
          sync_error_started_at = '2026-07-23T10:10:00.000Z',
          sync_alerted_at = NULL, sync_recovery_pending_at = NULL
      WHERE id = 'connection-recovery'`).run();
    await runSheetsSyncAlerts({
      db, webhookUrl: WEBHOOK, now: new Date('2026-07-23T10:24:59.000Z'), fetcher,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await runSheetsSyncAlerts({
      db, webhookUrl: WEBHOOK, now: new Date('2026-07-23T10:25:00.000Z'), fetcher,
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  test('waits six hours before repeating an ongoing-error alert', async () => {
    seedConnection({
      id: 'connection-repeat', status: 'error',
      errorStartedAt: '2026-07-22T10:00:00.000Z',
      alertedAt: '2026-07-23T04:01:00.000Z', warning: 'まだ失敗しています',
    });
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));

    await runSheetsSyncAlerts({
      db, webhookUrl: WEBHOOK, now: new Date('2026-07-23T10:00:00.000Z'), fetcher,
    });
    expect(fetcher).not.toHaveBeenCalled();

    const result = await runSheetsSyncAlerts({
      db, webhookUrl: WEBHOOK, now: new Date('2026-07-23T10:01:00.000Z'), fetcher,
    });
    expect(result.alertsSent).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('isolates webhook failures, retries them, and never logs the secret URL', async () => {
    seedConnection({
      id: 'a-failing', status: 'error', errorStartedAt: '2026-07-23T09:00:00.000Z',
      warning: '失敗A',
    });
    seedConnection({
      id: 'b-working', status: 'error', errorStartedAt: '2026-07-23T09:00:00.000Z',
      warning: '失敗B',
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error(WEBHOOK))
      .mockResolvedValue(new Response(null, { status: 204 }));
    const now = new Date('2026-07-23T10:00:00.000Z');

    const result = await runSheetsSyncAlerts({ db, webhookUrl: WEBHOOK, now, fetcher });

    expect(result).toEqual({ scanned: 2, alertsSent: 1, recoveriesSent: 0, failures: 1 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(raw.prepare(`SELECT id, sync_alerted_at FROM sheets_connections
      ORDER BY id`).all()).toEqual([
      { id: 'a-failing', sync_alerted_at: null },
      { id: 'b-working', sync_alerted_at: now.toISOString() },
    ]);
    expect(errorLog.mock.calls.flat().join('\n')).not.toContain(WEBHOOK);

    const retry = await runSheetsSyncAlerts({
      db, webhookUrl: WEBHOOK, now: new Date('2026-07-23T10:05:00.000Z'), fetcher,
    });
    expect(retry.alertsSent).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  test('does not treat an in-flight alert as delivered or send recovery before it finishes', async () => {
    seedConnection({
      id: 'connection-inflight', status: 'error',
      errorStartedAt: '2026-07-23T09:00:00.000Z', warning: '継続失敗',
    });
    let rejectDelivery: ((reason?: unknown) => void) | undefined;
    const fetcher = vi.fn(() => new Promise<Response>((_resolve, reject) => {
      rejectDelivery = reject;
    }));
    const now = new Date('2026-07-23T10:00:00.000Z');

    const firstCheck = runSheetsSyncAlerts({
      db, webhookUrl: WEBHOOK, now, fetcher, deliveryTimeoutMs: 1_000,
    });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(raw.prepare(`SELECT sync_alerted_at, sync_alert_claimed_at
      FROM sheets_connections WHERE id = 'connection-inflight'`).get()).toEqual({
      sync_alerted_at: null,
      sync_alert_claimed_at: now.toISOString(),
    });

    raw.prepare(`UPDATE sheets_connections
      SET last_sync_status = 'success', sync_error_started_at = NULL
      WHERE id = 'connection-inflight'`).run();
    const recoveryFetcher = vi.fn(async () => new Response(null, { status: 204 }));
    await runSheetsSyncAlerts({
      db, webhookUrl: WEBHOOK, now: new Date('2026-07-23T10:01:00.000Z'),
      fetcher: recoveryFetcher,
    });
    expect(recoveryFetcher).not.toHaveBeenCalled();

    rejectDelivery?.(new Error('webhook unavailable'));
    await firstCheck;
    expect(raw.prepare(`SELECT sync_alerted_at, sync_alert_claimed_at
      FROM sheets_connections WHERE id = 'connection-inflight'`).get()).toEqual({
      sync_alerted_at: null,
      sync_alert_claimed_at: null,
    });
  });

  test('queues recovery when an in-flight alert succeeds just after the sync recovers', async () => {
    seedConnection({
      id: 'connection-inflight-success', status: 'error',
      errorStartedAt: '2026-07-23T09:00:00.000Z', warning: '継続失敗',
    });
    let resolveDelivery: ((response: Response) => void) | undefined;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => {
      resolveDelivery = resolve;
    }));
    const alertedAt = new Date('2026-07-23T10:00:00.000Z');

    const firstCheck = runSheetsSyncAlerts({
      db, webhookUrl: WEBHOOK, now: alertedAt, fetcher, deliveryTimeoutMs: 1_000,
    });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    raw.prepare(`UPDATE sheets_connections
      SET last_sync_status = 'success', last_sync_at = '2026-07-23T10:01:00.000Z',
          sync_error_started_at = NULL
      WHERE id = 'connection-inflight-success'`).run();
    resolveDelivery?.(new Response(null, { status: 204 }));

    await expect(firstCheck).resolves.toMatchObject({ alertsSent: 1, failures: 0 });
    expect(raw.prepare(`SELECT sync_alerted_at, sync_alert_claimed_at,
      sync_recovery_pending_at FROM sheets_connections
      WHERE id = 'connection-inflight-success'`).get()).toEqual({
      sync_alerted_at: alertedAt.toISOString(),
      sync_alert_claimed_at: null,
      sync_recovery_pending_at: '2026-07-23T10:01:00.000Z',
    });

    const recoveryFetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const recovered = await runSheetsSyncAlerts({
      db, webhookUrl: WEBHOOK, now: new Date('2026-07-23T10:05:00.000Z'),
      fetcher: recoveryFetcher,
    });
    expect(recovered.recoveriesSent).toBe(1);
    expect(recoveryFetcher).toHaveBeenCalledTimes(1);
  });

  test('times out a stalled webhook and restores the connection for the next cron', async () => {
    seedConnection({
      id: 'connection-timeout', status: 'error',
      errorStartedAt: '2026-07-23T09:00:00.000Z', warning: '継続失敗',
    });
    const fetcher = vi.fn((_input: string | URL | Request, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        const rejectAbort = () => reject(new Error('aborted'));
        if (signal.aborted) rejectAbort();
        else signal.addEventListener('abort', rejectAbort, { once: true });
      })
    ));

    const result = await runSheetsSyncAlerts({
      db,
      webhookUrl: WEBHOOK,
      now: new Date('2026-07-23T10:00:00.000Z'),
      fetcher,
      deliveryTimeoutMs: 5,
    });

    expect(result).toMatchObject({ alertsSent: 0, recoveriesSent: 0, failures: 1 });
    expect(raw.prepare(`SELECT sync_alerted_at, sync_alert_claimed_at
      FROM sheets_connections WHERE id = 'connection-timeout'`).get()).toEqual({
      sync_alerted_at: null,
      sync_alert_claimed_at: null,
    });
  });

  test('restores a failed recovery and sends it once on the next cron', async () => {
    seedConnection({
      id: 'connection-recovery-retry', status: 'success',
      alertedAt: '2026-07-23T09:00:00.000Z',
      recoveryPendingAt: '2026-07-23T09:05:00.000Z',
    });
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('webhook unavailable'))
      .mockResolvedValue(new Response(null, { status: 204 }));

    const failed = await runSheetsSyncAlerts({
      db, webhookUrl: WEBHOOK, now: new Date('2026-07-23T09:05:00.000Z'), fetcher,
    });
    expect(failed.failures).toBe(1);
    expect(raw.prepare(`SELECT sync_alerted_at, sync_recovery_pending_at
      FROM sheets_connections WHERE id = 'connection-recovery-retry'`).get()).toEqual({
      sync_alerted_at: '2026-07-23T09:00:00.000Z',
      sync_recovery_pending_at: '2026-07-23T09:05:00.000Z',
    });

    const retried = await runSheetsSyncAlerts({
      db, webhookUrl: WEBHOOK, now: new Date('2026-07-23T09:10:00.000Z'), fetcher,
    });
    const repeated = await runSheetsSyncAlerts({
      db, webhookUrl: WEBHOOK, now: new Date('2026-07-23T09:15:00.000Z'), fetcher,
    });
    expect(retried.recoveriesSent).toBe(1);
    expect(repeated.recoveriesSent).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('re-fetches durable state so two identical checks send only once', async () => {
    seedConnection({
      id: 'connection-idempotent', status: 'error',
      errorStartedAt: '2026-07-23T09:00:00.000Z', warning: '継続失敗',
    });
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const now = new Date('2026-07-23T10:00:00.000Z');

    await runSheetsSyncAlerts({ db, webhookUrl: WEBHOOK, now, fetcher });
    await runSheetsSyncAlerts({ db, webhookUrl: WEBHOOK, now, fetcher });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(raw.prepare(`SELECT sync_error_started_at, sync_alerted_at
      FROM sheets_connections WHERE id = 'connection-idempotent'`).get()).toEqual({
      sync_error_started_at: '2026-07-23T09:00:00.000Z',
      sync_alerted_at: now.toISOString(),
    });
  });
});
