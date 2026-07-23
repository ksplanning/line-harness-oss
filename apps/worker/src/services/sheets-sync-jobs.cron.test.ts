import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  enqueue: vi.fn(async () => ({ enqueued: 0, runnable: 0 })),
  batch: vi.fn(async () => ({
    attempted: 0, chunks: 0, hasMore: false, continuationJobId: null, job: null,
  })),
  alerts: vi.fn(async () => ({
    scanned: 0, alertsSent: 0, recoveriesSent: 0, failures: 0,
  })),
}));

vi.mock('./sheets-sync-jobs.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./sheets-sync-jobs.js')>(),
  enqueueSheetsSyncPollingJobs: spies.enqueue,
  processSheetsSyncJobBatch: spies.batch,
}));

vi.mock('./sheets-sync-alert.js', () => ({
  runSheetsSyncAlerts: spies.alerts,
}));

import worker from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const tick = (scheduledTime = Date.now()) => ({
  cron: '*/5 * * * *', scheduledTime, type: 'scheduled',
}) as unknown as ScheduledEvent;

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

let raw: Database.Database;
let isolatedFetch: ReturnType<typeof vi.fn>;
const waitUntil = vi.fn((_promise: Promise<unknown>) => undefined);
const CTX = { waitUntil } as unknown as ExecutionContext;

function env(): Record<string, unknown> {
  return {
    DB: d1(raw),
    IMAGES: {}, ASSETS: {},
    LINE_CHANNEL_SECRET: 'secret', LINE_CHANNEL_ACCESS_TOKEN: 'token',
    API_KEY: 'key', LIFF_URL: 'https://liff.example.test',
    LINE_CHANNEL_ID: 'channel', LINE_LOGIN_CHANNEL_ID: 'login-channel',
    LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
    WORKER_URL: 'https://api.example.test',
    WORKER_PUBLIC_URL: 'https://worker.example.test',
    GOOGLE_SERVICE_ACCOUNT_JSON: '{"service":"credential"}',
  };
}

function sheetsCalls() {
  return isolatedFetch.mock.calls.filter((call) => String(call[0]).endsWith('/internal/sheets-sync-work'));
}

async function signedSheetsRequest(
  requestOrigin = 'https://worker.example.test',
  signedOrigin = requestOrigin,
): Promise<Request> {
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const payload = [
    'line-harness:sheets-sync-work:v1',
    'POST',
    '/internal/sheets-sync-work',
    signedOrigin,
    timestamp,
    nonce,
  ].join('\n');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode('secret'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(payload),
  ));
  const signature = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return new Request(`${requestOrigin}/internal/sheets-sync-work`, {
    method: 'POST',
    headers: {
      'x-sheets-sync-timestamp': timestamp,
      'x-sheets-sync-nonce': nonce,
      'x-sheets-sync-signature': signature,
    },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  raw = new Database(':memory:');
  raw.exec(readFileSync(join(DB_ROOT, 'bootstrap.sql'), 'utf8'));
  spies.enqueue.mockReset().mockResolvedValue({ enqueued: 0, runnable: 0 });
  spies.batch.mockReset().mockResolvedValue({
    attempted: 0, chunks: 0, hasMore: false, continuationJobId: null, job: null,
  });
  spies.alerts.mockReset().mockResolvedValue({
    scanned: 0, alertsSent: 0, recoveriesSent: 0, failures: 0,
  });
  waitUntil.mockClear();
  isolatedFetch = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', isolatedFetch);
});

describe('scheduled Sheets sync work', () => {
  test('does not evaluate alerts or change existing sync work when the webhook is unset', async () => {
    spies.enqueue.mockResolvedValueOnce({ enqueued: 1, runnable: 1 });

    await worker.scheduled(tick(), env() as never, CTX);

    expect(spies.enqueue).toHaveBeenCalledTimes(1);
    expect(spies.batch).toHaveBeenCalledTimes(1);
    expect(spies.alerts).not.toHaveBeenCalled();
  });

  test('evaluates alerts after the five-minute sync pass when the webhook is configured', async () => {
    const scheduledTime = Date.parse('2026-07-23T10:15:00.000Z');
    const bindings = { ...env(), SHEETS_ALERT_WEBHOOK: 'https://discord.example.test/secret' };

    await worker.scheduled(tick(scheduledTime), bindings as never, CTX);

    expect(spies.alerts).toHaveBeenCalledTimes(1);
    expect(spies.alerts).toHaveBeenCalledWith({
      db: bindings.DB,
      webhookUrl: 'https://discord.example.test/secret',
      now: new Date(scheduledTime),
    });
  });

  test('contains alert-service failures without logging the webhook URL', async () => {
    const webhookUrl = 'https://discord.example.test/do-not-log';
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    spies.alerts.mockRejectedValueOnce(new Error(webhookUrl));

    await expect(worker.scheduled(
      tick(), { ...env(), SHEETS_ALERT_WEBHOOK: webhookUrl } as never, CTX,
    )).resolves.toBeUndefined();

    expect(error.mock.calls.flat().join('\n')).toContain('[sheets-sync-alert] worker error');
    expect(error.mock.calls.flat().join('\n')).not.toContain(webhookUrl);
  });

  test('advances cron work inline when neither SELF nor public self-fetch is usable', async () => {
    const selfFetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('/internal/sheets-sync-work')) {
        throw new Error('service binding self-call unavailable');
      }
      return new Response(null, { status: 204 });
    });
    isolatedFetch.mockImplementation(async (input) => {
      if (String(input).includes('/internal/')) throw new Error('Cloudflare 1042 self-fetch blocked');
      return new Response(null, { status: 204 });
    });
    spies.enqueue.mockResolvedValueOnce({ enqueued: 1, runnable: 1 });
    spies.batch.mockResolvedValueOnce({
      attempted: 1,
      chunks: 1,
      hasMore: true,
      continuationJobId: 'job-1',
      job: { id: 'job-1', status: 'running', processedCount: 200, totalCount: 1_450 },
    });

    await worker.scheduled(tick(), { ...env(), SELF: { fetch: selfFetch } } as never, CTX);

    expect(spies.batch).toHaveBeenCalledWith(expect.objectContaining({
      db: expect.anything(), credentialsJson: '{"service":"credential"}', chunkSize: 200, maxChunks: 8,
      trigger: 'cron',
    }));
    expect(selfFetch.mock.calls.filter((call) => (
      String(call[0]).includes('/internal/sheets-sync-work')
    ))).toHaveLength(0);
    expect(sheetsCalls()).toHaveLength(0);
  });

  test('leaves work beyond eight chunks running for the next cron poll', async () => {
    spies.enqueue.mockResolvedValue({ enqueued: 0, runnable: 1 });
    spies.batch
      .mockResolvedValueOnce({
        attempted: 1,
        chunks: 8,
        hasMore: true,
        continuationJobId: 'job-1',
        job: { id: 'job-1', status: 'running', processedCount: 1_600, totalCount: 1_800 },
      })
      .mockResolvedValueOnce({
        attempted: 1,
        chunks: 1,
        hasMore: false,
        continuationJobId: null,
        job: { id: 'job-1', status: 'success', processedCount: 1_800, totalCount: 1_800 },
      });

    await worker.scheduled(tick(), env() as never, CTX);
    await worker.scheduled(tick(), env() as never, CTX);

    expect(spies.enqueue).toHaveBeenCalledTimes(2);
    expect(spies.batch).toHaveBeenCalledTimes(2);
    expect(sheetsCalls()).toHaveLength(0);
  });

  test('accepts an origin-bound signed request and drains its inline batch without continuation fetch', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const selfFetch = vi.fn(async () => new Response(null, { status: 204 }));
    const bindings = { ...env(), SELF: { fetch: selfFetch } };
    spies.batch.mockResolvedValueOnce({
      attempted: 1,
      chunks: 8,
      hasMore: false,
      continuationJobId: null,
      job: { id: 'job-1', status: 'success', processedCount: 1_450, totalCount: 1_450 },
    });

    const response = await worker.fetch(await signedSheetsRequest(), bindings as never, CTX);

    expect(response.status).toBe(204);
    expect(spies.batch).toHaveBeenCalledWith(expect.objectContaining({
      db: expect.anything(), credentialsJson: '{"service":"credential"}', chunkSize: 200, maxChunks: 8,
      trigger: 'signed_internal',
    }));
    expect(waitUntil).not.toHaveBeenCalled();
    expect(selfFetch).not.toHaveBeenCalled();
    expect(sheetsCalls()).toHaveLength(0);
    const safeLogs = log.mock.calls.flat().join('\n');
    expect(safeLogs).toContain('work request origin=https://worker.example.test verified=true self_binding=present');
    expect(safeLogs).toContain('chunks=8 processed=1450/1450 status=success has_more=false');
    expect(safeLogs).not.toContain('secret');
    expect(safeLogs).not.toContain('credential');
  });

  test('rejects an unsigned internal request without touching job state', async () => {
    const response = await worker.fetch(new Request(
      'https://worker.example.test/internal/sheets-sync-work',
      { method: 'POST' },
    ), env() as never, CTX);
    expect(response.status).toBe(401);
    expect(spies.batch).not.toHaveBeenCalled();
  });

  test('rejects a valid HMAC when the receiving request origin differs', async () => {
    const response = await worker.fetch(await signedSheetsRequest(
      'https://service-binding.internal',
      'https://worker.example.test',
    ), env() as never, CTX);

    expect(response.status).toBe(401);
    expect(spies.batch).not.toHaveBeenCalled();
  });
});

describe('SELF service binding config for other internal work', () => {
  test.each([
    ['wrangler.ks.toml', 'line-harness-ks'],
    ['wrangler.piecemaker.toml', 'line-harness-piecemaker'],
  ])('%s binds SELF to its own worker service', (fileName, expectedService) => {
    const config = readFileSync(join(__dirname, '../../', fileName), 'utf8');
    const workerName = config.match(/^name = "([^"]+)"$/m)?.[1];
    const selfBindings = config.match(/^binding = "SELF"$/gm) ?? [];

    expect(workerName).toBe(expectedService);
    expect(selfBindings).toHaveLength(1);
    expect(config).toContain([
      '[[services]]',
      'binding = "SELF"',
      `service = "${workerName}"`,
    ].join('\n'));
  });
});
