import { Hono } from 'hono';
import {
  createSheetsConnection,
  enqueueSheetsWebhookEvent,
  getActiveSheetsConnectionById,
  getSheetsConnection,
  listFriendFieldDefinitions,
  listSheetsConnections,
  softDeleteSheetsConnection,
  toJstString,
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
import {
  drainFriendLedgerWebhookEvents,
  listFriendLedgerAudit,
  parseFriendLedgerWebhookEventPayload,
  syncFriendLedger,
  type FriendLedgerWebhookEventPayload,
} from '../services/friend-ledger-sync.js';
import { verifySheetsWebhookSignature } from '../services/sheets-webhook-signature.js';
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
const IDENTITY_HEADERS = new Set(['表示名', 'userId', '登録日']);
const MAX_SELECTED_FIELDS = 50;
const MAX_FRIEND_LEDGER_WEBHOOK_BYTES = 32 * 1024;

interface ConnectionInput {
  lineAccountId?: unknown;
  formId?: unknown;
  spreadsheetId?: unknown;
  sheetName?: unknown;
  syncDirection?: unknown;
  selectedFieldIds?: unknown;
}

type ValidSettings = {
  spreadsheetId: string;
  sheetName: string;
  syncDirection: SheetsSyncDirection;
  selectedFieldIds?: string[];
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
  let selectedFieldIds: string[] | undefined;
  if (body.selectedFieldIds !== undefined) {
    if (!Array.isArray(body.selectedFieldIds) || body.selectedFieldIds.length > MAX_SELECTED_FIELDS) {
      return { ok: false, error: '同期するカスタムフィールドを正しく選択してください' };
    }
    selectedFieldIds = body.selectedFieldIds.map(cleanString);
    if (
      selectedFieldIds.some((id) => !id || id.length > 200)
      || new Set(selectedFieldIds).size !== selectedFieldIds.length
    ) {
      return { ok: false, error: '同期するカスタムフィールドを正しく選択してください' };
    }
  }
  return { ok: true, value: { spreadsheetId, sheetName, syncDirection, selectedFieldIds } };
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

interface FriendLedgerWebhookPayload extends FriendLedgerWebhookEventPayload {
  version: 2;
  eventId: string;
  occurredAt: string;
  connectionId: string;
  spreadsheetId: string;
  sheetName: string;
  actor: string;
  actorKind: 'google_email' | 'unavailable';
}

const MAX_GOOGLE_SHEET_ROWS = 10_000_000;
const MAX_GOOGLE_SHEET_COLUMNS = 18_278;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function parseWebhookPayload(value: unknown): FriendLedgerWebhookPayload | null {
  if (!isPlainObject(value) || !isPlainObject(value.range)) return null;
  const rawRange = value.range;
  const connectionId = cleanString(value.connectionId);
  const spreadsheetId = cleanString(value.spreadsheetId);
  const sheetName = cleanString(value.sheetName);
  const actor = cleanString(value.actor) || 'google_sheets_editor';
  const rangeValues = ['rowStart', 'rowEnd', 'columnStart', 'columnEnd'] as const;
  if (
    !connectionId || connectionId.length > 200
    || !spreadsheetId || spreadsheetId.length > 512
    || !sheetName || sheetName.length > 200
    || actor.length > 320
    || rangeValues.some((key) => !Number.isSafeInteger(rawRange[key]) || Number(rawRange[key]) < 1)
  ) return null;
  const range = {
    rowStart: Number(rawRange.rowStart),
    rowEnd: Number(rawRange.rowEnd),
    columnStart: Number(rawRange.columnStart),
    columnEnd: Number(rawRange.columnEnd),
  };
  if (
    range.rowStart > range.rowEnd
    || range.columnStart > range.columnEnd
    || range.rowEnd > MAX_GOOGLE_SHEET_ROWS
    || range.columnEnd > MAX_GOOGLE_SHEET_COLUMNS
  ) return null;
  if (value.version !== 2) return null;
  const eventId = cleanString(value.eventId);
  const occurredAt = cleanString(value.occurredAt);
  const actorKind = value.actorKind;
  const eventPayload = parseFriendLedgerWebhookEventPayload({ range, snapshot: value.snapshot });
  if (
    !eventPayload
    || !/^[A-Za-z0-9_-]{16,200}$/.test(eventId)
    || !Number.isFinite(Date.parse(occurredAt))
    || (actorKind !== 'google_email' && actorKind !== 'unavailable')
  ) return null;
  const hasGoogleEmail = actorKind === 'google_email'
    && /^[^@\s]+@[^@\s]+$/.test(actor);
  return {
    version: 2,
    eventId,
    occurredAt,
    connectionId,
    spreadsheetId,
    sheetName,
    range: eventPayload.range,
    snapshot: eventPayload.snapshot,
    actor: hasGoogleEmail ? actor : 'google_sheets_editor_unavailable',
    actorKind: hasGoogleEmail ? 'google_email' : 'unavailable',
  };
}

async function resolveFriendFieldMappings(
  db: D1Database,
  selectedFieldIds: string[] | undefined,
): Promise<ValidationResult<{ fieldId: string; header: string }[] | undefined>> {
  if (selectedFieldIds === undefined) return { ok: true, value: undefined };
  const selected = new Set(selectedFieldIds);
  const definitions = await listFriendFieldDefinitions(db, { activeOnly: true });
  const mappings = definitions
    .filter((definition) => selected.has(definition.id))
    .map((definition) => ({ fieldId: definition.id, header: definition.name }));
  if (mappings.length !== selected.size || mappings.some((mapping) => IDENTITY_HEADERS.has(mapping.header))) {
    return { ok: false, error: '選択したカスタムフィールドを同期できません。項目の状態を確認してください' };
  }
  return { ok: true, value: mappings };
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
    const mappings = await resolveFriendFieldMappings(c.env.DB, validated.value.selectedFieldIds ?? []);
    if (!mappings.ok) return c.json({ success: false, error: mappings.error }, 400);
    const created = await createSheetsConnection(c.env.DB, {
      lineAccountId: validated.value.lineAccountId,
      formId: validated.value.formId,
      spreadsheetId: validated.value.spreadsheetId,
      sheetName: validated.value.sheetName,
      syncDirection: validated.value.syncDirection,
      friendFieldMappings: mappings.value ?? [],
      friendLedgerEnabled: true,
    });
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
    const mappings = await resolveFriendFieldMappings(c.env.DB, validated.value.selectedFieldIds);
    if (!mappings.ok) return c.json({ success: false, error: mappings.error }, 400);
    const updated = await updateSheetsConnection(c.env.DB, validated.value.lineAccountId, c.req.param('id'), {
      spreadsheetId: validated.value.spreadsheetId,
      sheetName: validated.value.sheetName,
      syncDirection: validated.value.syncDirection,
      friendFieldMappings: mappings.value,
      friendLedgerEnabled: true,
    });
    if (!updated) {
      const existing = await getSheetsConnection(c.env.DB, validated.value.lineAccountId, c.req.param('id'));
      if (existing) {
        return c.json({ success: false, error: '同期中です。少し待ってからもう一度保存してください' }, 409);
      }
      return c.json({ success: false, error: '接続設定が見つかりません' }, 404);
    }
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
    if (!deleted) {
      const existing = await getSheetsConnection(c.env.DB, lineAccountId.value, c.req.param('id'));
      if (existing) {
        return c.json({ success: false, error: '同期中です。少し待ってからもう一度削除してください' }, 409);
      }
      return c.json({ success: false, error: '接続設定が見つかりません' }, 404);
    }
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

// POST /api/integrations/google-sheets/connections/:id/sync
sheetsConnections.post(`${BASE_PATH}/:id/sync`, async (c) => {
  const denied = ownerGate(c, OWNER_MESSAGE);
  if (denied) return denied;
  const lineAccountId = validateLineAccountId(c.req.query('lineAccountId'));
  if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
  try {
    const connection = await getSheetsConnection(c.env.DB, lineAccountId.value, c.req.param('id'));
    if (!connection) return c.json({ success: false, error: '接続設定が見つかりません' }, 404);
    if (!connection.friendLedgerEnabled) {
      return c.json({ success: false, error: '友だち台帳の同期設定を保存してください' }, 409);
    }
    if (!c.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      return c.json({ success: false, error: SETUP_MESSAGE }, 503);
    }
    const result = await syncFriendLedger({
      db: c.env.DB,
      connection,
      credentialsJson: c.env.GOOGLE_SERVICE_ACCOUNT_JSON,
      source: 'manual',
      actor: c.get('staff').id,
    });
    return c.json({ success: true, data: result });
  } catch {
    console.error('Manual friend ledger sync failed');
    return c.json({ success: false, error: '手動同期に失敗しました' }, 500);
  }
});

// GET /api/integrations/google-sheets/connections/:id/audit
sheetsConnections.get(`${BASE_PATH}/:id/audit`, async (c) => {
  const denied = ownerGate(c, OWNER_MESSAGE);
  if (denied) return denied;
  const lineAccountId = validateLineAccountId(c.req.query('lineAccountId'));
  if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
  try {
    const connection = await getSheetsConnection(c.env.DB, lineAccountId.value, c.req.param('id'));
    if (!connection) return c.json({ success: false, error: '接続設定が見つかりません' }, 404);
    const audit = await listFriendLedgerAudit({
      db: c.env.DB,
      lineAccountId: lineAccountId.value,
      connectionId: connection.id,
      limit: 50,
    });
    return c.json({ success: true, data: audit });
  } catch {
    console.error('GET friend ledger audit failed');
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// v2 signs one exact cell snapshot and durably accepts it before attempting sync.
sheetsConnections.post('/integrations/google-sheets/friend-ledger/webhook', async (c) => {
  const declaredLength = Number(c.req.header('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FRIEND_LEDGER_WEBHOOK_BYTES) {
    return c.json({ success: false, error: '通知サイズが大きすぎます' }, 413);
  }
  const rawBody = await c.req.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_FRIEND_LEDGER_WEBHOOK_BYTES) {
    return c.json({ success: false, error: '通知サイズが大きすぎます' }, 413);
  }
  const signature = c.req.header('X-Sheets-Signature') ?? '';
  const timestamp = c.req.header('X-Sheets-Timestamp') ?? '';
  const verified = await verifySheetsWebhookSignature({
    rawBody,
    signature,
    timestamp,
    secret: c.env.SHEETS_WEBHOOK_SECRET,
  });
  if (!verified) return c.json({ success: false, error: '署名を確認できません' }, 401);

  let payload: FriendLedgerWebhookPayload | null = null;
  try {
    payload = parseWebhookPayload(JSON.parse(rawBody) as unknown);
  } catch {
    // Invalid JSON is intentionally handled only after the signature check.
  }
  if (!payload) return c.json({ success: false, error: '通知の形式が正しくありません' }, 400);
  if (payload.occurredAt !== timestamp) {
    return c.json({ success: false, error: '通知時刻が一致しません' }, 400);
  }

  try {
    const connection = await getActiveSheetsConnectionById(c.env.DB, payload.connectionId);
    if (
      !connection
      || !connection.friendLedgerEnabled
      || connection.spreadsheetId !== payload.spreadsheetId
      || connection.sheetName !== payload.sheetName
    ) return c.json({ success: false, error: '接続設定が見つかりません' }, 404);
    const acceptedAt = toJstString(new Date());
    const queued = await enqueueSheetsWebhookEvent(
      c.env.DB,
      connection.lineAccountId,
      connection.id,
      connection.configVersion,
      {
        eventId: payload.eventId,
        actor: payload.actor,
        actorKind: payload.actorKind,
        occurredAt: payload.occurredAt,
        payload: { range: payload.range, snapshot: payload.snapshot },
        receivedAt: acceptedAt,
      },
    );
    if (!queued) return c.json({ success: false, error: '接続設定が更新されました' }, 409);
    if (queued.status === 'pending' && c.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      const work = drainFriendLedgerWebhookEvents({
        db: c.env.DB,
        connection,
        credentialsJson: c.env.GOOGLE_SERVICE_ACCOUNT_JSON,
        maxEvents: 1,
      }).catch(() => undefined);
      try {
        c.executionCtx.waitUntil(work);
      } catch {
        await work;
      }
    }
    return c.json({ success: true }, 202);
  } catch {
    console.error('Friend ledger webhook sync failed');
    return c.json({ success: false, error: '同期通知を処理できませんでした' }, 500);
  }
});
