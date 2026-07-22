import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  getConnection: vi.fn(),
  startJob: vi.fn(),
  batch: vi.fn(),
}));

vi.mock('@line-crm/db', async (importOriginal) => ({
  ...await importOriginal<typeof import('@line-crm/db')>(),
  getSheetsConnection: spies.getConnection,
}));

vi.mock('../services/sheets-sync-jobs.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/sheets-sync-jobs.js')>(),
  startSheetsSyncJob: spies.startJob,
  processSheetsSyncJobBatch: spies.batch,
}));

import { sheetsConnections } from './sheets-connections.js';
import type { Env } from '../index.js';

const pending: Promise<unknown>[] = [];
const waitUntil = vi.fn((promise: Promise<unknown>) => {
  pending.push(promise);
});
const CTX = { waitUntil } as unknown as ExecutionContext;

function testApp(): Hono<Env> {
  const instance = new Hono<Env>();
  instance.use('*', async (c, next) => {
    c.set('staff', { id: 'owner-1', name: 'Owner', role: 'owner' });
    await next();
  });
  instance.route('/', sheetsConnections);
  return instance;
}

function bindings(selfFetch: ReturnType<typeof vi.fn>): Env['Bindings'] {
  return {
    DB: {} as D1Database,
    IMAGES: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    SELF: { fetch: selfFetch } as Fetcher,
    LINE_CHANNEL_SECRET: 'secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'token',
    API_KEY: 'key',
    LIFF_URL: 'https://liff.example.test',
    LINE_CHANNEL_ID: 'channel',
    LINE_LOGIN_CHANNEL_ID: 'login-channel',
    LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
    WORKER_URL: 'https://api.example.test',
    ADMIN_ORIGIN: 'https://admin.example.test',
    GOOGLE_SERVICE_ACCOUNT_JSON: '{"service":"credential"}',
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  pending.length = 0;
  waitUntil.mockClear();
  spies.getConnection.mockReset().mockResolvedValue({
    id: 'connection-1',
    lineAccountId: 'acc-1',
    configVersion: 1,
    friendLedgerEnabled: true,
    formResultsEnabled: false,
    formResultsSheetName: null,
  });
  spies.startJob.mockReset().mockResolvedValue({
    id: 'job-1',
    status: 'running',
    processedCount: 0,
    totalCount: 1_450,
  });
  spies.batch.mockReset().mockResolvedValue({
    attempted: 1,
    chunks: 8,
    hasMore: false,
    continuationJobId: null,
    job: {
      id: 'job-1', status: 'success', processedCount: 1_450, totalCount: 1_450,
    },
  });
});

describe('manual Sheets sync inline runner', () => {
  test('returns 202, advances the durable job in waitUntil, and never self-fetches', async () => {
    const selfFetch = vi.fn(async () => {
      throw new Error('SELF.fetch must not be used by Sheets sync');
    });

    const response = await testApp().fetch(new Request(
      'https://worker.example.test/api/integrations/google-sheets/connections/connection-1/sync?lineAccountId=acc-1',
      { method: 'POST' },
    ), bindings(selfFetch), CTX);

    expect(response.status).toBe(202);
    expect(spies.startJob).toHaveBeenCalledWith(expect.objectContaining({
      source: 'manual', actor: 'owner-1', target: 'ledger',
    }));
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await Promise.all(pending);
    expect(spies.batch).toHaveBeenCalledWith(expect.objectContaining({
      db: expect.anything(),
      credentialsJson: '{"service":"credential"}',
      adminOrigin: 'https://admin.example.test',
      chunkSize: 200,
      maxChunks: 8,
      trigger: 'manual',
    }));
    expect(selfFetch).not.toHaveBeenCalled();
  });
});
