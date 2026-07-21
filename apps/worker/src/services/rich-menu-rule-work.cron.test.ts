import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const { enqueueSpy, workSpy } = vi.hoisted(() => ({
  enqueueSpy: vi.fn(async () => ({ enqueued: 0, scannedFrom: '', scannedThrough: '' })),
  workSpy: vi.fn(async () => ({ attempted: 0, queueProcessed: 0, jobsCompleted: 0 })),
}));
vi.mock('./rich-menu-rule-work.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./rich-menu-rule-work.js')>(),
  enqueueRichMenuRuleScheduleTransitions: enqueueSpy,
  processRichMenuRuleWork: workSpy,
}));

import worker from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const WORKER_ROOT = join(__dirname, '../..');
const BENIGN = /duplicate column name|already exists/i;

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
        async run() {
          const info = statement.run(...(params as never[]));
          return { meta: { changes: info.changes } };
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

function replayAll(db: Database.Database): void {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(join(DB_ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    for (const sql of readFileSync(join(DB_ROOT, 'migrations', file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/)
      .map((part) => part.trim())
      .filter(Boolean)) {
      try { db.exec(sql); } catch (error) {
        if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
  }
}

let raw: Database.Database;
let isolatedFetch: ReturnType<typeof vi.fn>;
const tick = (cron: string, scheduledTime = Date.now()) => ({ cron, scheduledTime, type: 'scheduled' }) as unknown as ScheduledEvent;
const waitUntil = vi.fn((_promise: Promise<unknown>) => undefined);
const CTX = { waitUntil } as unknown as ExecutionContext;

function env(): Record<string, unknown> {
  return {
    DB: d1(raw),
    IMAGES: {},
    ASSETS: {},
    LINE_CHANNEL_SECRET: 'secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'token',
    API_KEY: 'key',
    LIFF_URL: 'https://liff.example.test',
    LINE_CHANNEL_ID: 'channel',
    LINE_LOGIN_CHANNEL_ID: 'login-channel',
    LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
    WORKER_URL: 'https://api.example.test',
    WORKER_PUBLIC_URL: 'https://worker.example.test',
  };
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  enqueueSpy.mockReset();
  enqueueSpy.mockResolvedValue({ enqueued: 0, scannedFrom: '', scannedThrough: '' });
  workSpy.mockClear();
  waitUntil.mockClear();
  isolatedFetch = vi.fn(async () => Response.json({ attempted: 0, queueProcessed: 0, jobsCompleted: 0 }));
  vi.stubGlobal('fetch', isolatedFetch);
});

describe('scheduled rich menu rule work', () => {
  test('dispatches one isolated invocation before other five-minute work', async () => {
    await worker.scheduled(tick('*/5 * * * *'), env() as never, CTX);
    expect(isolatedFetch).toHaveBeenCalledTimes(1);
    expect(isolatedFetch).toHaveBeenCalledWith(
      'https://worker.example.test/internal/rich-menu-rule-work',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    const headers = new Headers(isolatedFetch.mock.calls[0][1]?.headers);
    expect(headers.get('x-rich-menu-timestamp')).toMatch(/^\d+$/);
    expect(headers.get('x-rich-menu-nonce')).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers.get('x-rich-menu-signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(headers.get('user-agent')).toBe('line-harness-worker/0.0.0-dev');
    expect(JSON.stringify(isolatedFetch.mock.calls[0])).not.toContain('secret');
    expect(workSpy).not.toHaveBeenCalled();
  });

  test('does not run on the six-hour tick', async () => {
    await worker.scheduled(tick('0 */6 * * *'), env() as never, CTX);
    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(workSpy).not.toHaveBeenCalled();
    expect(isolatedFetch).not.toHaveBeenCalled();
  });

  test('enqueues transitions before work on each fifteen-minute boundary', async () => {
    const scheduledTime = Date.parse('2026-07-20T00:15:00.000Z');
    await worker.scheduled(tick('*/5 * * * *', scheduledTime), env() as never, CTX);

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith(expect.anything(), new Date(scheduledTime));
    expect(enqueueSpy.mock.invocationCallOrder[0]).toBeLessThan(isolatedFetch.mock.invocationCallOrder[0]);
  });

  test('keeps draining work but skips the transition scan between fifteen-minute boundaries', async () => {
    await worker.scheduled(
      tick('*/5 * * * *', Date.parse('2026-07-20T00:05:00.000Z')),
      env() as never,
      CTX,
    );

    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(isolatedFetch).toHaveBeenCalledTimes(1);
  });

  test('keeps draining existing work when the transition scan fails', async () => {
    enqueueSpy.mockRejectedValueOnce(new Error('temporary D1 failure'));
    await worker.scheduled(
      tick('*/5 * * * *', Date.parse('2026-07-20T00:30:00.000Z')),
      env() as never,
      CTX,
    );

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(isolatedFetch).toHaveBeenCalledTimes(1);
  });

  test('the isolated endpoint rejects missing credentials without running work', async () => {
    const response = await worker.fetch(
      new Request('https://worker.example.test/internal/rich-menu-rule-work', { method: 'POST' }),
      env() as never,
      CTX,
    );

    expect(response.status).toBe(401);
    expect(workSpy).not.toHaveBeenCalled();
  });

  test('the isolated endpoint runs work with the server-side credential', async () => {
    const bindings = env();
    await worker.scheduled(tick('*/5 * * * *'), bindings as never, CTX);
    const signedHeaders = new Headers(isolatedFetch.mock.calls[0][1]?.headers);
    const response = await worker.fetch(
      new Request('https://worker.example.test/internal/rich-menu-rule-work', {
        method: 'POST',
        headers: signedHeaders,
      }),
      bindings as never,
      CTX,
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(workSpy).toHaveBeenCalledTimes(1);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  test('the isolated endpoint immediately dispatches the next safe chunk while a job is progressing', async () => {
    workSpy.mockResolvedValueOnce({ attempted: 2, queueProcessed: 0, jobsCompleted: 0 });
    const bindings = env();
    await worker.scheduled(tick('*/5 * * * *'), bindings as never, CTX);
    const signedHeaders = new Headers(isolatedFetch.mock.calls[0][1]?.headers);
    isolatedFetch.mockClear();

    const response = await worker.fetch(
      new Request('https://worker.example.test/internal/rich-menu-rule-work', {
        method: 'POST',
        headers: signedHeaders,
      }),
      bindings as never,
      CTX,
    );

    expect(response.status).toBe(204);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.calls[0][0];
    expect(isolatedFetch).toHaveBeenCalledTimes(1);
  });

  test('records the continuation dispatch failure reason', async () => {
    workSpy.mockResolvedValueOnce({ attempted: 2, queueProcessed: 0, jobsCompleted: 0 });
    const bindings = env();
    await worker.scheduled(tick('*/5 * * * *'), bindings as never, CTX);
    const signedHeaders = new Headers(isolatedFetch.mock.calls[0][1]?.headers);
    isolatedFetch.mockClear();
    isolatedFetch.mockResolvedValueOnce(new Response('blocked', { status: 403 }));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const response = await worker.fetch(
        new Request('https://worker.example.test/internal/rich-menu-rule-work', {
          method: 'POST',
          headers: signedHeaders,
        }),
        bindings as never,
        CTX,
      );

      expect(response.status).toBe(204);
      await waitUntil.mock.calls[0][0];
      expect(errorSpy).toHaveBeenCalledWith(
        '[rich-menu-rules] continuation dispatch error',
        expect.objectContaining({ message: 'isolated rich menu worker returned 403' }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('the isolated endpoint rejects an expired signed request', async () => {
    const signedAt = Date.parse('2026-07-21T10:00:00.000Z');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(signedAt);
    const bindings = env();
    await worker.scheduled(tick('*/5 * * * *', signedAt), bindings as never, CTX);
    const signedHeaders = new Headers(isolatedFetch.mock.calls[0][1]?.headers);
    clock.mockReturnValue(signedAt + 60_001);

    const response = await worker.fetch(
      new Request('https://worker.example.test/internal/rich-menu-rule-work', {
        method: 'POST',
        headers: signedHeaders,
      }),
      bindings as never,
      CTX,
    );
    clock.mockRestore();

    expect(response.status).toBe(401);
    expect(workSpy).not.toHaveBeenCalled();
  });

  test('the isolated endpoint rejects a tampered signature without running work', async () => {
    const bindings = env();
    await worker.scheduled(tick('*/5 * * * *'), bindings as never, CTX);
    const signedHeaders = new Headers(isolatedFetch.mock.calls[0][1]?.headers);
    signedHeaders.set('x-rich-menu-signature', '0'.repeat(64));

    const response = await worker.fetch(
      new Request('https://worker.example.test/internal/rich-menu-rule-work', {
        method: 'POST',
        headers: signedHeaders,
      }),
      bindings as never,
      CTX,
    );

    expect(response.status).toBe(401);
    expect(workSpy).not.toHaveBeenCalled();
  });

  test.each([
    ['non-2xx', async () => new Response('unavailable', { status: 503 }), 'isolated rich menu worker returned 503'],
    ['network rejection', async () => { throw new TypeError('network unavailable'); }, 'network unavailable'],
  ])('records %s without falling back into the shared cron budget', async (_label, implementation, message) => {
    isolatedFetch.mockImplementationOnce(implementation);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await worker.scheduled(tick('*/5 * * * *'), env() as never, CTX);

      expect(isolatedFetch).toHaveBeenCalledTimes(1);
      expect(workSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        '[rich-menu-rules] isolated dispatch error',
        expect.objectContaining({ message }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('fails closed when isolated dispatch configuration is missing', async () => {
    const missingConfig: Record<string, unknown> = env();
    delete missingConfig.WORKER_PUBLIC_URL;

    await worker.scheduled(tick('*/5 * * * *'), missingConfig as never, CTX);

    expect(isolatedFetch).not.toHaveBeenCalled();
    expect(workSpy).not.toHaveBeenCalled();
  });

  test('pins public self-fetch compatibility without changing the two cron triggers', () => {
    for (const file of ['wrangler.toml', 'wrangler.ks.toml']) {
      const config = readFileSync(join(WORKER_ROOT, file), 'utf8');
      expect(config).toContain('"global_fetch_strictly_public"');
      expect(config).toContain('crons = ["*/5 * * * *", "0 */6 * * *"]');
    }
  });
});
