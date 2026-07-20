import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { jstNow } from '@line-crm/db';
import { authMiddleware } from '../middleware/auth.js';
import { permissionMiddleware } from '../middleware/permission-middleware.js';
import { sheetsConnections } from './sheets-connections.js';
import type { Env } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const OWNER = 'Bearer env-owner-key';
const CONNECTION_ERRORS = {
  key_format: 'サービスアカウントの秘密鍵を読み取れません。Worker secret の改行と PEM 形式を確認してください。',
  auth_rejected: 'Google の認証に失敗しました。サービスアカウントの設定を確認してください。',
  sheet_permission: 'スプレッドシートを読み取れません。スプレッドシート ID・シート名と、サービスアカウントへの共有権限を確認してください。',
  network: 'Google に接続できませんでした。時間をおいて、もう一度接続テストをしてください。',
} as const;
const WEBHOOK_MASTER_SECRET = 'deployment-master-secret-at-least-32-characters';

let raw: Database.Database;
let DB: D1Database;
let serviceAccountJson: string;

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
    LINE_CHANNEL_SECRET: 's',
    LINE_CHANNEL_ACCESS_TOKEN: 't',
    API_KEY: 'env-owner-key',
    LIFF_URL: 'https://liff.example.test',
    LINE_CHANNEL_ID: 'c',
    LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls',
    WORKER_URL: 'https://api.example.test',
    GOOGLE_SERVICE_ACCOUNT_JSON: serviceAccountJson,
    SHEETS_WEBHOOK_SECRET: WEBHOOK_MASTER_SECRET,
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
  body?: unknown,
  auth = OWNER,
  envOverrides: Record<string, unknown> = {},
) {
  return app().request(path, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env(envOverrides));
}

function seedStaff(id: string, role: 'owner' | 'admin' | 'staff', apiKey: string): void {
  const now = jstNow();
  raw.prepare(
    `INSERT INTO staff_members (id, name, email, role, api_key, is_active, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, 1, ?, ?)`,
  ).run(id, id, role, apiKey, now, now);
}

const validInput = {
  lineAccountId: 'acc-1',
  formId: 'internal-form-1',
  spreadsheetId: '1AbCd_ef-GhIj',
  sheetName: '回答',
  syncDirection: 'bidirectional',
};

async function createOne(): Promise<string> {
  const response = await call('POST', '/api/integrations/google-sheets/connections', validInput);
  expect(response.status).toBe(201);
  return (await response.json() as { data: { id: string } }).data.id;
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const base64 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  const privateKey = `-----BEGIN PRIVATE KEY-----\n${base64.match(/.{1,64}/g)?.join('\n')}\n-----END PRIVATE KEY-----\n`;
  serviceAccountJson = JSON.stringify({
    type: 'service_account',
    client_email: 'sheets-test@example.iam.gserviceaccount.com',
    private_key: privateKey,
    token_uri: 'https://oauth2.googleapis.com/token',
  });
});

beforeEach(() => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  raw.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('acc-1', 'channel-1', 'A', 'token', 'secret'), ('acc-2', 'channel-2', 'B', 'token', 'secret')`).run();
  DB = d1(raw);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  raw.close();
});

describe('Sheets connections CRUD API', () => {
  test('all CRUD and connection-test endpoints are owner-only', async () => {
    seedStaff('staff-1', 'staff', 'staff-key');
    const auth = 'Bearer staff-key';
    expect((await call('GET', '/api/integrations/google-sheets/connections?lineAccountId=acc-1', undefined, auth)).status).toBe(403);
    expect((await call('POST', '/api/integrations/google-sheets/connections', validInput, auth)).status).toBe(403);
    expect((await call('PATCH', '/api/integrations/google-sheets/connections/id', validInput, auth)).status).toBe(403);
    expect((await call('DELETE', '/api/integrations/google-sheets/connections/id', undefined, auth)).status).toBe(403);
    expect((await call('POST', '/api/integrations/google-sheets/connections/id/test', undefined, auth)).status).toBe(403);
    expect((await call('POST', '/api/integrations/google-sheets/connections/id/webhook-secret?lineAccountId=acc-1', undefined, auth)).status).toBe(403);
  });

  test('create → list → patch → delete round-trip is account-scoped and soft-deleted', async () => {
    const id = await createOne();
    const list = await call('GET', '/api/integrations/google-sheets/connections?lineAccountId=acc-1');
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ data: [{ id, ...validInput, conflictPolicy: 'last_write_wins' }] });
    const other = await call('GET', '/api/integrations/google-sheets/connections?lineAccountId=acc-2');
    expect((await other.json() as { data: unknown[] }).data).toEqual([]);

    const updated = await call('PATCH', `/api/integrations/google-sheets/connections/${id}`, {
      lineAccountId: 'acc-1', spreadsheetId: 'New_sheet-ID', sheetName: '集計', syncDirection: 'from_sheets',
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ data: { id, spreadsheetId: 'New_sheet-ID', sheetName: '集計', syncDirection: 'from_sheets' } });

    expect((await call('DELETE', `/api/integrations/google-sheets/connections/${id}?lineAccountId=acc-1`)).status).toBe(200);
    expect((await call('PATCH', `/api/integrations/google-sheets/connections/${id}`, {
      lineAccountId: 'acc-1', spreadsheetId: 'x', sheetName: 'x', syncDirection: 'to_sheets',
    })).status).toBe(404);
    expect(raw.prepare('SELECT is_active, deleted_at FROM sheets_connections WHERE id=?').get(id))
      .toMatchObject({ is_active: 0, deleted_at: expect.any(String) });
  });

  test('validates account/form/spreadsheet/sheet/direction and rejects a duplicate active form', async () => {
    const cases = [
      { ...validInput, lineAccountId: 'missing' },
      { ...validInput, formId: '' },
      { ...validInput, spreadsheetId: 'https://docs.google.com/spreadsheets/d/id/edit' },
      { ...validInput, sheetName: '' },
      { ...validInput, syncDirection: 'sideways' },
    ];
    for (const input of cases) {
      expect((await call('POST', '/api/integrations/google-sheets/connections', input)).status).toBe(400);
    }
    await createOne();
    expect((await call('POST', '/api/integrations/google-sheets/connections', validInput)).status).toBe(409);
  });

  test('snapshots only selected active custom-field headings and rejects unsafe selections', async () => {
    raw.prepare(`INSERT INTO friend_field_definitions
      (id, name, default_value, display_order, is_active)
      VALUES
      ('field-plan', '利用プラン', '', 1, 1),
      ('field-note', '担当メモ', '', 2, 1),
      ('field-old', '旧項目', '', 3, 0),
      ('field-identity', 'userId', '', 4, 1)`).run();

    const created = await call('POST', '/api/integrations/google-sheets/connections', {
      ...validInput,
      selectedFieldIds: ['field-note', 'field-plan'],
    });
    expect(created.status).toBe(201);
    const body = await created.json() as { data: { id: string; friendFieldMappings: unknown[] } };
    expect(body.data.friendFieldMappings).toEqual([
      { fieldId: 'field-plan', header: '利用プラン' },
      { fieldId: 'field-note', header: '担当メモ' },
    ]);
    expect(body.data).toMatchObject({ friendLedgerEnabled: true });

    const unsafeCases = [
      ['field-old'],
      ['missing'],
      ['field-identity'],
      ['field-plan', 'field-plan'],
    ];
    for (const selectedFieldIds of unsafeCases) {
      const response = await call('PATCH', `/api/integrations/google-sheets/connections/${body.data.id}`, {
        lineAccountId: 'acc-1',
        spreadsheetId: validInput.spreadsheetId,
        sheetName: validInput.sheetName,
        syncDirection: validInput.syncDirection,
        selectedFieldIds,
      });
      expect(response.status).toBe(400);
    }
  });

  test('asks the owner to retry settings changes while a sync holds the target lock', async () => {
    const id = await createOne();
    raw.prepare(`UPDATE sheets_connections
      SET sync_lock_token='running-sync', sync_lock_expires_at='2099-01-01T00:00:00+09:00'
      WHERE id=?`).run(id);

    const patch = await call('PATCH', `/api/integrations/google-sheets/connections/${id}`, {
      lineAccountId: 'acc-1', spreadsheetId: 'new-sheet', sheetName: '台帳', syncDirection: 'to_sheets',
    });
    const remove = await call('DELETE', `/api/integrations/google-sheets/connections/${id}?lineAccountId=acc-1`);

    expect(patch.status).toBe(409);
    expect(remove.status).toBe(409);
    expect(raw.prepare('SELECT spreadsheet_id, is_active FROM sheets_connections WHERE id=?').get(id))
      .toEqual({ spreadsheet_id: validInput.spreadsheetId, is_active: 1 });
  });

  test('issues distinct no-store webhook keys only within the selected LINE account', async () => {
    const firstId = await createOne();
    const secondCreated = await call('POST', '/api/integrations/google-sheets/connections', {
      ...validInput,
      lineAccountId: 'acc-2',
      formId: 'internal-form-2',
      spreadsheetId: 'Second_sheet-ID',
    });
    expect(secondCreated.status).toBe(201);
    const secondId = (await secondCreated.json() as { data: { id: string } }).data.id;

    const crossed = await call(
      'POST',
      `/api/integrations/google-sheets/connections/${firstId}/webhook-secret?lineAccountId=acc-2`,
    );
    const first = await call(
      'POST',
      `/api/integrations/google-sheets/connections/${firstId}/webhook-secret?lineAccountId=acc-1`,
    );
    const second = await call(
      'POST',
      `/api/integrations/google-sheets/connections/${secondId}/webhook-secret?lineAccountId=acc-2`,
    );

    expect(crossed.status).toBe(404);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('no-store');
    expect(second.headers.get('Cache-Control')).toBe('no-store');
    const firstSecret = (await first.json() as { data: { webhookSecret: string } }).data.webhookSecret;
    const secondSecret = (await second.json() as { data: { webhookSecret: string } }).data.webhookSecret;
    expect(firstSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(secondSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(firstSecret).not.toBe(secondSecret);

    const listed = await call('GET', '/api/integrations/google-sheets/connections?lineAccountId=acc-1');
    const listedText = await listed.text();
    expect(listedText).not.toContain(firstSecret);
    expect(listedText).not.toContain('webhookSecret');

    const missingMaster = await call(
      'POST',
      `/api/integrations/google-sheets/connections/${firstId}/webhook-secret?lineAccountId=acc-1`,
      undefined,
      OWNER,
      { SHEETS_WEBHOOK_SECRET: undefined },
    );
    expect(missingMaster.status).toBe(503);
  });
});

describe('Sheets connection test API', () => {
  test('saved connection performs exactly one Sheets read and returns no cell values', async () => {
    const id = await createOne();
    const apiCalls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'ACCESS', expires_in: 3600 }), { status: 200 });
      }
      apiCalls.push(url);
      return new Response(JSON.stringify({ range: '回答!A1', values: [['SENTINEL_CELL_VALUE']] }), { status: 200 });
    }));

    const response = await call('POST', `/api/integrations/google-sheets/connections/${id}/test?lineAccountId=acc-1`);
    expect(response.status).toBe(200);
    const responseText = await response.text();
    expect(responseText).toBe('{"success":true,"data":{"ok":true}}');
    const body = JSON.parse(responseText);
    expect(body).toEqual({ success: true, data: { ok: true } });
    expect(apiCalls).toHaveLength(1);
    expect(apiCalls[0]).toContain('/spreadsheets/1AbCd_ef-GhIj/values/');
    expect(apiCalls[0]).toContain('A1%3AA1');
    expect(JSON.stringify(body)).not.toContain('SENTINEL_CELL_VALUE');
  });

  test('missing/invalid secret fails closed without echoing credentials', async () => {
    const id = await createOne();
    const missing = await call('POST', `/api/integrations/google-sheets/connections/${id}/test?lineAccountId=acc-1`, undefined, OWNER, {
      GOOGLE_SERVICE_ACCOUNT_JSON: undefined,
    });
    expect(missing.status).toBe(503);
    const sentinel = 'SENTINEL_PRIVATE_KEY';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const invalid = await call('POST', `/api/integrations/google-sheets/connections/${id}/test?lineAccountId=acc-1`, undefined, OWNER, {
      GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ private_key: sentinel }),
    });
    expect(invalid.status).toBe(503);
    expect(await invalid.json()).toEqual({
      success: false,
      error: CONNECTION_ERRORS.key_format,
      category: 'key_format',
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(sentinel);
  });

  test('不正 PEM は鍵形式エラーを安全な人間語で返す', async () => {
    const id = await createOne();
    const sentinel = 'NOT-BASE64!';
    const parsed = JSON.parse(serviceAccountJson) as Record<string, unknown>;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await call(
      'POST',
      `/api/integrations/google-sheets/connections/${id}/test?lineAccountId=acc-1`,
      undefined,
      OWNER,
      {
        GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
          ...parsed,
          private_key: `-----BEGIN PRIVATE KEY-----\n${sentinel}\n-----END PRIVATE KEY-----`,
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { ok: false, category: 'key_format', message: CONNECTION_ERRORS.key_format },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith('Google Sheets connection test failed', {
      category: 'key_format', operation: 'token', status: 0,
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(sentinel);
  });

  test('OAuth token 拒否は認証エラーを返し Google response body を隠す', async () => {
    const id = await createOne();
    const sentinel = 'SENTINEL_TOKEN_BODY';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: sentinel }), { status: 401 })));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await call('POST', `/api/integrations/google-sheets/connections/${id}/test?lineAccountId=acc-1`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      success: true,
      data: { ok: false, category: 'auth_rejected', message: CONNECTION_ERRORS.auth_rejected },
    });
    expect(JSON.stringify(body)).not.toContain(sentinel);
    expect(consoleError).toHaveBeenCalledWith('Google Sheets connection test failed', {
      category: 'auth_rejected', operation: 'token', status: 401,
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(sentinel);
  });

  test('Sheets API の 403 はシート権限エラーを返し response body を隠す', async () => {
    const id = await createOne();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (String(input) === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'ACCESS', expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'SENTINEL_GOOGLE_BODY' }), { status: 403 });
    }));
    const response = await call('POST', `/api/integrations/google-sheets/connections/${id}/test?lineAccountId=acc-1`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      success: true,
      data: { ok: false, category: 'sheet_permission', message: CONNECTION_ERRORS.sheet_permission },
    });
    expect(JSON.stringify(body)).not.toContain('SENTINEL_GOOGLE_BODY');
    expect(consoleError).toHaveBeenCalledWith('Google Sheets connection test failed', {
      category: 'sheet_permission', operation: 'read', status: 403,
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('SENTINEL_GOOGLE_BODY');
  });

  test('fetch 例外は安全な短い detail を API 応答とログへ返す', async () => {
    const id = await createOne();
    const cause = 'Network connection lost';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError(cause); }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await call('POST', `/api/integrations/google-sheets/connections/${id}/test?lineAccountId=acc-1`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      success: true,
      data: {
        ok: false,
        category: 'network',
        message: CONNECTION_ERRORS.network,
        detail: `TypeError: ${cause}`,
      },
    });
    expect(consoleError).toHaveBeenCalledWith('Google Sheets connection test failed', {
      category: 'network', operation: 'token', status: 0, detail: `TypeError: ${cause}`,
    });
  });

  test('database failure is a 500 instead of a misleading not-found response', async () => {
    const brokenDb = {
      prepare(sql: string) {
        if (/sheets_connections/i.test(sql)) throw new Error('SENTINEL_DB_FAILURE');
        return DB.prepare(sql);
      },
    } as unknown as D1Database;
    const response = await call(
      'POST',
      '/api/integrations/google-sheets/connections/any-id/test?lineAccountId=acc-1',
      undefined,
      OWNER,
      { DB: brokenDb },
    );

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('SENTINEL_DB_FAILURE');
  });

  test('patch/delete/test cannot cross the selected LINE account boundary', async () => {
    const id = await createOne();
    const patch = await call('PATCH', `/api/integrations/google-sheets/connections/${id}`, {
      lineAccountId: 'acc-2', spreadsheetId: 'wrong', sheetName: 'wrong', syncDirection: 'to_sheets',
    });
    expect(patch.status).toBe(404);
    expect((raw.prepare('SELECT spreadsheet_id FROM sheets_connections WHERE id=?').get(id) as { spreadsheet_id: string }).spreadsheet_id)
      .toBe(validInput.spreadsheetId);

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect((await call('POST', `/api/integrations/google-sheets/connections/${id}/test?lineAccountId=acc-2`)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await call('DELETE', `/api/integrations/google-sheets/connections/${id}?lineAccountId=acc-2`)).status).toBe(404);
    expect(raw.prepare('SELECT is_active FROM sheets_connections WHERE id=?').get(id)).toEqual({ is_active: 1 });
  });
});
