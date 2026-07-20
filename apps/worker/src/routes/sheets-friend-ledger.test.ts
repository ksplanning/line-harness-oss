import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { jstNow } from '@line-crm/db';
import { authMiddleware } from '../middleware/auth.js';
import { permissionMiddleware } from '../middleware/permission-middleware.js';
import type { Env } from '../index.js';

const service = vi.hoisted(() => ({
  syncFriendLedger: vi.fn(),
  listFriendLedgerAudit: vi.fn(),
}));

vi.mock('../services/friend-ledger-sync.js', () => service);

import { sheetsConnections } from './sheets-connections.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const OWNER = 'Bearer env-owner-key';
const WEBHOOK_SECRET = 'sheets-webhook-route-secret-at-least-32-characters';
const WEBHOOK_TIMESTAMP = '2026-07-21T03:00:00.000Z';

let raw: Database.Database;
let DB: D1Database;

function d1(db: Database.Database): D1Database {
  interface MockStatement {
    bind(...args: unknown[]): MockStatement;
    first<T>(): Promise<T | null>;
    all<T>(): Promise<{ results: T[] }>;
    run(): Promise<{ meta: { changes: number } }>;
    __exec(): { meta: { changes: number } };
  }
  const prepare = (sql: string): MockStatement => {
    const statement = db.prepare(sql);
    let params: unknown[] = [];
    const api: MockStatement = {
      bind(...args: unknown[]) { params = args; return api; },
      async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
      async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
      async run() { return api.__exec(); },
      __exec() {
        const result = statement.run(...(params as never[]));
        return { meta: { changes: result.changes } };
      },
    };
    return api;
  };
  return {
    prepare,
    async batch(statements: MockStatement[]) {
      return db.transaction((items: MockStatement[]) => items.map((item) => item.__exec()))(statements);
    },
  } as unknown as D1Database;
}

function env(overrides: Record<string, unknown> = {}): Env['Bindings'] {
  return {
    DB,
    IMAGES: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 'line-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    API_KEY: 'env-owner-key',
    LIFF_URL: 'https://liff.example.test',
    LINE_CHANNEL_ID: 'channel',
    LINE_LOGIN_CHANNEL_ID: 'login-channel',
    LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
    WORKER_URL: 'https://api.example.test',
    GOOGLE_SERVICE_ACCOUNT_JSON: '{"test":true}',
    SHEETS_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ...overrides,
  } as unknown as Env['Bindings'];
}

function app() {
  const instance = new Hono<Env>();
  instance.use('*', authMiddleware);
  instance.use('*', permissionMiddleware);
  instance.route('/', sheetsConnections);
  return instance;
}

function call(
  method: string,
  path: string,
  options: { body?: string; auth?: string; headers?: Record<string, string>; env?: Record<string, unknown> } = {},
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.auth === undefined ? {} : { Authorization: options.auth }),
    ...options.headers,
  };
  return app().request(path, { method, headers, body: options.body }, env(options.env));
}

function seedStaff(id: string, role: 'owner' | 'admin' | 'staff', apiKey: string): void {
  const now = jstNow();
  raw.prepare(
    `INSERT INTO staff_members (id, name, email, role, api_key, is_active, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, 1, ?, ?)`,
  ).run(id, id, role, apiKey, now, now);
}

function seedConnection(id: string, accountId: string, spreadsheetId: string): void {
  raw.prepare(
    `INSERT INTO sheets_connections
       (id, line_account_id, form_id, spreadsheet_id, sheet_name, sync_direction, friend_ledger_enabled)
     VALUES (?, ?, ?, ?, '友だち台帳', 'bidirectional', 1)`,
  ).run(id, accountId, `friend-ledger-${accountId}`, spreadsheetId);
}

async function hmacHex(rawBody: string, timestamp: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${rawBody}`)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

beforeEach(() => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  raw.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('acc-1', 'channel-1', 'A', 'token', 'secret'), ('acc-2', 'channel-2', 'B', 'token', 'secret')`).run();
  DB = d1(raw);
  seedConnection('conn-a', 'acc-1', 'sheet-a');
  seedConnection('conn-b', 'acc-2', 'sheet-b');
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(WEBHOOK_TIMESTAMP));
  service.syncFriendLedger.mockReset().mockResolvedValue({ status: 'success', warning: null });
  service.listFriendLedgerAudit.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  raw.close();
});

describe('friend ledger owner routes', () => {
  test('manual sync and audit are owner-only', async () => {
    seedStaff('staff-1', 'staff', 'staff-key');

    const sync = await call(
      'POST',
      '/api/integrations/google-sheets/connections/conn-a/sync?lineAccountId=acc-1',
      { auth: 'Bearer staff-key' },
    );
    const audit = await call(
      'GET',
      '/api/integrations/google-sheets/connections/conn-a/audit?lineAccountId=acc-1',
      { auth: 'Bearer staff-key' },
    );

    expect(sync.status).toBe(403);
    expect(audit.status).toBe(403);
    expect(service.syncFriendLedger).not.toHaveBeenCalled();
    expect(service.listFriendLedgerAudit).not.toHaveBeenCalled();
  });

  test('manual sync is scoped to the selected LINE account and records the authenticated owner as actor', async () => {
    const crossed = await call(
      'POST',
      '/api/integrations/google-sheets/connections/conn-a/sync?lineAccountId=acc-2',
      { auth: OWNER },
    );
    expect(crossed.status).toBe(404);
    expect(service.syncFriendLedger).not.toHaveBeenCalled();

    const response = await call(
      'POST',
      '/api/integrations/google-sheets/connections/conn-a/sync?lineAccountId=acc-1',
      { auth: OWNER },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { status: 'success', warning: null },
    });
    expect(service.syncFriendLedger).toHaveBeenCalledWith(expect.objectContaining({
      connection: expect.objectContaining({ id: 'conn-a', lineAccountId: 'acc-1' }),
      source: 'manual',
      actor: 'env-owner',
    }));
  });

  test('audit listing cannot cross the selected LINE account boundary', async () => {
    service.listFriendLedgerAudit.mockResolvedValueOnce([
      {
        id: 'audit-1',
        actor: 'env-owner',
        fieldName: '会員区分',
        beforeValue: '一般',
        afterValue: 'VIP',
      },
    ]);

    const crossed = await call(
      'GET',
      '/api/integrations/google-sheets/connections/conn-a/audit?lineAccountId=acc-2',
      { auth: OWNER },
    );
    expect(crossed.status).toBe(404);
    expect(service.listFriendLedgerAudit).not.toHaveBeenCalled();

    const response = await call(
      'GET',
      '/api/integrations/google-sheets/connections/conn-a/audit?lineAccountId=acc-1',
      { auth: OWNER },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: [{ id: 'audit-1', actor: 'env-owner', fieldName: '会員区分' }],
    });
    expect(service.listFriendLedgerAudit).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: 'conn-a',
      lineAccountId: 'acc-1',
    }));
  });
});

describe('POST /integrations/google-sheets/friend-ledger/webhook', () => {
  test('rejects an invalid signature before JSON parsing, DB access, or sync', async () => {
    const prepare = vi.fn(() => { throw new Error('DB must not be touched'); });
    const response = await call(
      'POST',
      '/integrations/google-sheets/friend-ledger/webhook',
      {
        body: '{',
        headers: {
          'X-Sheets-Signature': '00'.repeat(32),
          'X-Sheets-Timestamp': WEBHOOK_TIMESTAMP,
        },
        env: {
          DB: { prepare } as unknown as D1Database,
        },
      },
    );

    expect(response.status).toBe(401);
    expect(prepare).not.toHaveBeenCalled();
    expect(service.syncFriendLedger).not.toHaveBeenCalled();
  });

  test('requires both signature and timestamp headers', async () => {
    const body = JSON.stringify({ connectionId: 'conn-a' });
    const signature = await hmacHex(body, WEBHOOK_TIMESTAMP);

    expect((await call('POST', '/integrations/google-sheets/friend-ledger/webhook', {
      body,
      headers: { 'X-Sheets-Timestamp': WEBHOOK_TIMESTAMP },
    })).status).toBe(401);
    expect((await call('POST', '/integrations/google-sheets/friend-ledger/webhook', {
      body,
      headers: { 'X-Sheets-Signature': signature },
    })).status).toBe(401);
    expect(service.syncFriendLedger).not.toHaveBeenCalled();
  });

  test('accepts a signed range notification and forwards its actor to targeted sync', async () => {
    const payload = {
      version: 1,
      connectionId: 'conn-a',
      spreadsheetId: 'sheet-a',
      sheetName: '友だち台帳',
      range: { rowStart: 2, rowEnd: 2, columnStart: 4, columnEnd: 4 },
      actor: 'editor@example.test',
    };
    const body = JSON.stringify(payload);
    const signature = await hmacHex(body, WEBHOOK_TIMESTAMP);

    const response = await call(
      'POST',
      '/integrations/google-sheets/friend-ledger/webhook',
      {
        body,
        headers: {
          'X-Sheets-Signature': signature,
          'X-Sheets-Timestamp': WEBHOOK_TIMESTAMP,
        },
      },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ success: true });
    expect(service.syncFriendLedger).toHaveBeenCalledWith(expect.objectContaining({
      connection: expect.objectContaining({ id: 'conn-a', lineAccountId: 'acc-1' }),
      source: 'webhook',
      actor: 'editor@example.test',
      range: payload.range,
    }));
  });

  test('binds the signed connection id to its saved spreadsheet and tab', async () => {
    const payload = {
      version: 1,
      connectionId: 'conn-a',
      spreadsheetId: 'sheet-b',
      sheetName: '友だち台帳',
      range: { rowStart: 2, rowEnd: 2, columnStart: 4, columnEnd: 4 },
      actor: 'editor@example.test',
    };
    const body = JSON.stringify(payload);
    const response = await call('POST', '/integrations/google-sheets/friend-ledger/webhook', {
      body,
      headers: {
        'X-Sheets-Signature': await hmacHex(body, WEBHOOK_TIMESTAMP),
        'X-Sheets-Timestamp': WEBHOOK_TIMESTAMP,
      },
    });

    expect(response.status).toBe(404);
    expect(service.syncFriendLedger).not.toHaveBeenCalled();
  });
});
