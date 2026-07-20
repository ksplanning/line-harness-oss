import { Hono } from 'hono';
import {
  createSheetsConnection,
  getSheetsConnection,
  listSheetsConnections,
  softDeleteSheetsConnection,
  updateSheetsConnection,
  type SheetsSyncDirection,
} from '@line-crm/db';
import { ownerGate } from '../lib/owner-gate.js';
import {
  GoogleSheetsClient,
  GoogleSheetsError,
  parseGoogleServiceAccountCredentials,
  type GoogleSheetsErrorCategory,
} from '../services/google-sheets.js';
import type { Env } from '../index.js';

export const sheetsConnections = new Hono<Env>();

const BASE_PATH = '/api/integrations/google-sheets/connections';
const OWNER_MESSAGE = 'この操作にはオーナー権限が必要です（Google Sheets 連携）';
const SETUP_MESSAGE = 'Google Sheets の接続設定が未完了です。オーナー向け手順書を確認してください。';
const CONNECTION_TEST_MESSAGES: Record<GoogleSheetsErrorCategory, string> = {
  key_format: 'サービスアカウントの秘密鍵を読み取れません。Worker secret の改行と PEM 形式を確認してください。',
  auth_rejected: 'Google の認証に失敗しました。サービスアカウントの設定を確認してください。',
  sheet_permission: 'スプレッドシートを読み取れません。スプレッドシート ID・シート名と、サービスアカウントへの共有権限を確認してください。',
  network: 'Google に接続できませんでした。時間をおいて、もう一度接続テストをしてください。',
};
const VALID_DIRECTIONS = new Set<SheetsSyncDirection>(['to_sheets', 'from_sheets', 'bidirectional']);

interface ConnectionInput {
  lineAccountId?: unknown;
  formId?: unknown;
  spreadsheetId?: unknown;
  sheetName?: unknown;
  syncDirection?: unknown;
}

type ValidSettings = {
  spreadsheetId: string;
  sheetName: string;
  syncDirection: SheetsSyncDirection;
};

type ValidCreate = ValidSettings & {
  lineAccountId: string;
  formId: string;
};

type ValidScopedSettings = ValidSettings & { lineAccountId: string };

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function validateSettings(body: ConnectionInput): ValidationResult<ValidSettings> {
  const spreadsheetId = cleanString(body.spreadsheetId);
  const sheetName = cleanString(body.sheetName);
  const syncDirection = cleanString(body.syncDirection) as SheetsSyncDirection;
  if (!spreadsheetId || spreadsheetId.length > 512 || !/^[A-Za-z0-9_-]+$/.test(spreadsheetId)) {
    return { ok: false, error: 'スプレッドシート ID を正しく入力してください' };
  }
  if (!sheetName || sheetName.length > 200 || /[\u0000-\u001f\u007f]/.test(sheetName)) {
    return { ok: false, error: 'シート名を正しく入力してください' };
  }
  if (!VALID_DIRECTIONS.has(syncDirection)) {
    return { ok: false, error: '同期方向を選択してください' };
  }
  return { ok: true, value: { spreadsheetId, sheetName, syncDirection } };
}

function validateCreate(body: ConnectionInput): ValidationResult<ValidCreate> {
  const settings = validateSettings(body);
  if (!settings.ok) return settings;
  const lineAccountId = cleanString(body.lineAccountId);
  const formId = cleanString(body.formId);
  if (!lineAccountId || lineAccountId.length > 200) {
    return { ok: false, error: 'LINE アカウントを選択してください' };
  }
  // W1/migration 113 と独立させるため formId は今は opaque。存在確認は W4 本体で接続する。
  if (!formId || formId.length > 200 || /[\u0000-\u001f\u007f]/.test(formId)) {
    return { ok: false, error: 'フォーム ID を正しく入力してください' };
  }
  return { ok: true, value: { lineAccountId, formId, ...settings.value } };
}

function validateLineAccountId(value: unknown): ValidationResult<string> {
  const lineAccountId = cleanString(value);
  return lineAccountId && lineAccountId.length <= 200
    ? { ok: true, value: lineAccountId }
    : { ok: false, error: 'LINE アカウントを選択してください' };
}

function validateScopedSettings(body: ConnectionInput): ValidationResult<ValidScopedSettings> {
  const settings = validateSettings(body);
  if (!settings.ok) return settings;
  const lineAccountId = validateLineAccountId(body.lineAccountId);
  if (!lineAccountId.ok) return lineAccountId;
  return { ok: true, value: { lineAccountId: lineAccountId.value, ...settings.value } };
}

async function readJson(c: Parameters<typeof ownerGate>[0]): Promise<Record<string, unknown>> {
  return c.req.json<Record<string, unknown>>().catch(() => ({}));
}

function quotedA1SheetName(sheetName: string): string {
  return `'${sheetName.replace(/'/g, "''")}'!A1:A1`;
}

// GET /api/integrations/google-sheets/connections?lineAccountId=&formId=
sheetsConnections.get(BASE_PATH, async (c) => {
  const denied = ownerGate(c, OWNER_MESSAGE);
  if (denied) return denied;
  const lineAccountId = cleanString(c.req.query('lineAccountId'));
  const formId = cleanString(c.req.query('formId')) || undefined;
  if (!lineAccountId) return c.json({ success: false, error: 'lineAccountId is required' }, 400);
  try {
    const connections = await listSheetsConnections(c.env.DB, lineAccountId, formId);
    return c.json({ success: true, data: connections });
  } catch {
    console.error('GET Google Sheets connections failed');
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/integrations/google-sheets/connections
sheetsConnections.post(BASE_PATH, async (c) => {
  const denied = ownerGate(c, OWNER_MESSAGE);
  if (denied) return denied;
  const validated = validateCreate(await readJson(c));
  if (!validated.ok) return c.json({ success: false, error: validated.error }, 400);
  try {
    const account = await c.env.DB.prepare('SELECT 1 AS ok FROM line_accounts WHERE id = ? AND is_active = 1')
      .bind(validated.value.lineAccountId)
      .first<{ ok: number }>();
    if (!account) return c.json({ success: false, error: 'LINE アカウントが見つかりません' }, 400);
    const created = await createSheetsConnection(c.env.DB, validated.value);
    return c.json({ success: true, data: created }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/UNIQUE constraint failed/i.test(message)) {
      return c.json({ success: false, error: 'このフォームには接続設定がすでにあります' }, 409);
    }
    console.error('POST Google Sheets connection failed');
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PATCH /api/integrations/google-sheets/connections/:id
sheetsConnections.patch(`${BASE_PATH}/:id`, async (c) => {
  const denied = ownerGate(c, OWNER_MESSAGE);
  if (denied) return denied;
  const validated = validateScopedSettings(await readJson(c));
  if (!validated.ok) return c.json({ success: false, error: validated.error }, 400);
  try {
    const { lineAccountId, ...settings } = validated.value;
    const updated = await updateSheetsConnection(c.env.DB, lineAccountId, c.req.param('id'), settings);
    if (!updated) return c.json({ success: false, error: '接続設定が見つかりません' }, 404);
    return c.json({ success: true, data: updated });
  } catch {
    console.error('PATCH Google Sheets connection failed');
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/integrations/google-sheets/connections/:id (soft delete)
sheetsConnections.delete(`${BASE_PATH}/:id`, async (c) => {
  const denied = ownerGate(c, OWNER_MESSAGE);
  if (denied) return denied;
  const lineAccountId = validateLineAccountId(c.req.query('lineAccountId'));
  if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
  try {
    const deleted = await softDeleteSheetsConnection(c.env.DB, lineAccountId.value, c.req.param('id'));
    if (!deleted) return c.json({ success: false, error: '接続設定が見つかりません' }, 404);
    return c.json({ success: true, data: null });
  } catch {
    console.error('DELETE Google Sheets connection failed');
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/integrations/google-sheets/connections/:id/test
// Exactly one A1 read. Cell contents and Google response bodies are never returned/logged.
sheetsConnections.post(`${BASE_PATH}/:id/test`, async (c) => {
  const denied = ownerGate(c, OWNER_MESSAGE);
  if (denied) return denied;
  const lineAccountId = validateLineAccountId(c.req.query('lineAccountId'));
  if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
  let connection: Awaited<ReturnType<typeof getSheetsConnection>>;
  try {
    connection = await getSheetsConnection(c.env.DB, lineAccountId.value, c.req.param('id'));
  } catch {
    console.error('GET Google Sheets connection for test failed');
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
  if (!connection) return c.json({ success: false, error: '接続設定が見つかりません' }, 404);
  if (!c.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return c.json({ success: false, error: SETUP_MESSAGE }, 503);
  }
  let credentials: ReturnType<typeof parseGoogleServiceAccountCredentials>;
  try {
    credentials = parseGoogleServiceAccountCredentials(c.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch {
    const category = 'key_format' as const;
    console.error('Google Sheets connection test failed', { category, operation: 'token', status: 0 });
    return c.json({
      success: false,
      error: CONNECTION_TEST_MESSAGES[category],
      category,
    }, 503);
  }
  try {
    const client = new GoogleSheetsClient({ credentials });
    await client.readValues(connection.spreadsheetId, quotedA1SheetName(connection.sheetName));
    return c.json({ success: true, data: { ok: true } });
  } catch (error) {
    const failure: {
      category: GoogleSheetsErrorCategory;
      operation: GoogleSheetsError['operation'];
      status: number;
      detail?: string;
    } = error instanceof GoogleSheetsError
      ? {
          category: error.category,
          operation: error.operation,
          status: error.status,
          ...(error.detail ? { detail: error.detail } : {}),
        }
      : { category: 'network' as const, operation: 'read' as const, status: 0 };
    console.error('Google Sheets connection test failed', failure);
    return c.json({
      success: true,
      data: {
        ok: false,
        category: failure.category,
        message: CONNECTION_TEST_MESSAGES[failure.category],
        ...(failure.detail ? { detail: failure.detail } : {}),
      },
    });
  }
});
