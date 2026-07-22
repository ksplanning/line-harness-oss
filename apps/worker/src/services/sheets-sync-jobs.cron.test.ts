import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  enqueue: vi.fn(async () => ({ enqueued: 0, runnable: 0 })),
  process: vi.fn(async () => ({ attempted: 0, hasMore: false, continuationJobId: null, job: null })),
  dispatchFailed: vi.fn(async () => undefined),
}));

vi.mock('./sheets-sync-jobs.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./sheets-sync-jobs.js')>(),
  enqueueSheetsSyncPollingJobs: spies.enqueue,
  processNextSheetsSyncJob: spies.process,
  recordSheetsSyncDispatchError: spies.dispatchFailed,
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

beforeEach(() => {
  raw = new Database(':memory:');
  raw.exec(readFileSync(join(DB_ROOT, 'bootstrap.sql'), 'utf8'));
  spies.enqueue.mockReset().mockResolvedValue({ enqueued: 0, runnable: 0 });
  spies.process.mockReset().mockResolvedValue({
    attempted: 0, hasMore: false, continuationJobId: null, job: null,
  });
  spies.dispatchFailed.mockReset().mockResolvedValue(undefined);
  waitUntil.mockClear();
  isolatedFetch = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', isolatedFetch);
});

describe('scheduled Sheets sync work', () => {
  test('enqueues cron work and self-dispatches one signed isolated invocation with the worker User-Agent', async () => {
    spies.enqueue.mockResolvedValueOnce({ enqueued: 1, runnable: 1 });
    await worker.scheduled(tick(), env() as never, CTX);

    expect(spies.enqueue).toHaveBeenCalledWith(expect.anything(), 10);
    expect(sheetsCalls()).toHaveLength(1);
    const [url, init] = sheetsCalls()[0];
    expect(url).toBe('https://worker.example.test/internal/sheets-sync-work');
    const headers = new Headers(init?.headers);
    expect(headers.get('user-agent')).toBe('line-harness-worker/0.0.0-dev');
    expect(headers.get('x-sheets-sync-timestamp')).toMatch(/^\d+$/);
    expect(headers.get('x-sheets-sync-nonce')).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers.get('x-sheets-sync-signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify([url, init])).not.toContain('secret');
    expect(JSON.stringify([url, init])).not.toContain('credential');
  });

  test('persists a safe job error when the cron entry dispatch cannot start', async () => {
    spies.enqueue.mockResolvedValueOnce({ enqueued: 2, runnable: 2 });
    isolatedFetch.mockImplementation(async (input) => (
      String(input).endsWith('/internal/sheets-sync-work')
        ? new Response('blocked', { status: 503 })
        : new Response(null, { status: 204 })
    ));

    await worker.scheduled(tick(), env() as never, CTX);

    expect(spies.dispatchFailed).toHaveBeenCalledWith(expect.anything());
  });

  test('runs exactly one bounded chunk and immediately dispatches its continuation', async () => {
    spies.enqueue.mockResolvedValueOnce({ enqueued: 1, runnable: 1 });
    const bindings = env();
    await worker.scheduled(tick(), bindings as never, CTX);
    const signed = new Headers(sheetsCalls()[0][1]?.headers);
    isolatedFetch.mockClear();
    spies.process.mockResolvedValueOnce({
      attempted: 1,
      hasMore: true,
      continuationJobId: 'job-1',
      job: { id: 'job-1', status: 'running', processedCount: 200, totalCount: 1450 },
    });

    const response = await worker.fetch(new Request(
      'https://worker.example.test/internal/sheets-sync-work',
      { method: 'POST', headers: signed },
    ), bindings as never, CTX);

    expect(response.status).toBe(204);
    expect(spies.process).toHaveBeenCalledWith(expect.objectContaining({
      db: expect.anything(), credentialsJson: '{"service":"credential"}', chunkSize: 200,
    }));
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0][0];
    expect(sheetsCalls()).toHaveLength(1);
  });

  test('rejects an unsigned internal request without touching job state', async () => {
    const response = await worker.fetch(new Request(
      'https://worker.example.test/internal/sheets-sync-work',
      { method: 'POST' },
    ), env() as never, CTX);
    expect(response.status).toBe(401);
    expect(spies.process).not.toHaveBeenCalled();
  });

  test('stores a safe job error when continuation dispatch fails after durable progress', async () => {
    spies.enqueue.mockResolvedValueOnce({ enqueued: 1, runnable: 1 });
    const bindings = env();
    await worker.scheduled(tick(), bindings as never, CTX);
    const signed = new Headers(sheetsCalls()[0][1]?.headers);
    isolatedFetch.mockClear();
    isolatedFetch.mockResolvedValueOnce(new Response('blocked', { status: 403 }));
    spies.process.mockResolvedValueOnce({
      attempted: 1,
      hasMore: true,
      continuationJobId: 'job-1',
      job: { id: 'job-1', status: 'running', processedCount: 200, totalCount: 1450 },
    });

    const response = await worker.fetch(new Request(
      'https://worker.example.test/internal/sheets-sync-work',
      { method: 'POST', headers: signed },
    ), bindings as never, CTX);
    expect(response.status).toBe(204);
    await waitUntil.mock.calls[0][0];
    expect(spies.dispatchFailed).toHaveBeenCalledWith(expect.anything(), 'job-1');
  });
});
