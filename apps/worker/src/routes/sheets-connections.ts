import { Hono } from 'hono';
import { extractGoogleSpreadsheetId } from '@line-crm/shared';
import {
  enqueueSheetsWebhookEvent,
  getActiveSheetsConnectionById,
  getSheetsConnection,
  listFriendFieldDefinitions,
  listSheetsConnections,
  replaceSheetsConnection,
  softDeleteSheetsConnection,
  toJstString,
  updateSheetsConnection,
  type SheetsSyncDirection,
  type SheetsSyncTarget,
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
  type FriendLedgerWebhookEventPayload,
} from '../services/friend-ledger-sync.js';
import { drainFormResultsWebhookEvents } from '../services/form-results-sync.js';
import {
  getLatestSheetsSyncJob,
  recordSheetsSyncDispatchError,
  startSheetsSyncJob,
} from '../services/sheets-sync-jobs.js';
import { dispatchSheetsSyncWork } from '../services/sheets-sync-dispatch.js';
import {
  deriveSheetsWebhookSecret,
  verifySheetsWebhookSignature,
} from '../services/sheets-webhook-signature.js';
import type { Env } from '../index.js';

export const sheetsConnections = new Hono<Env>();

const BASE_PATH = '/api/integrations/google-sheets/connections';
const OWNER_MESSAGE = 'この操作にはオーナー権限が必要です（Google Sheets 連携）';
const SETUP_MESSAGE = 'Google Sheets の接続設定が未完了です。オーナー向け手順書を確認してください。';
const CONNECTION_TEST_MESSAGES: Record<GoogleSheetsErrorCategory, string> = {
  key_format: 'サービスアカウントの秘密鍵を読み取れません。Worker secret の改行と PEM 形式を確認してください。',
  auth_rejected: 'Google の認証に失敗しました。サービスアカウントの設定を確認してください。',
  sheet_permission: 'スプレッドシートの共有設定に上のアドレスを追加してください。',
  network: 'Google に接続できませんでした。時間をおいて、もう一度接続テストをしてください。',
};
const VALID_DIRECTIONS = new Set<SheetsSyncDirection>(['to_sheets', 'from_sheets', 'bidirectional']);
const IDENTITY_HEADERS = new Set(['表示名', 'userId', '登録日']);
const MAX_SELECTED_FIELDS = 50;
const MAX_SELECTED_FORM_FIELDS = 200;
const MAX_FRIEND_LEDGER_WEBHOOK_BYTES = 32 * 1024;

interface ConnectionInput {
  lineAccountId?: unknown;
  formId?: unknown;
  spreadsheetId?: unknown;
  sheetName?: unknown;
  syncDirection?: unknown;
  selectedFieldIds?: unknown;
  selectedFormFieldIds?: unknown;
  friendLedgerEnabled?: unknown;
  formResultsEnabled?: unknown;
  formResultsSheetName?: unknown;
}

type ValidSettings = {
  spreadsheetId: string;
  sheetName: string;
  syncDirection: SheetsSyncDirection;
  selectedFieldIds?: string[];
  selectedFormFieldIds?: string[];
  friendLedgerEnabled?: boolean;
  formResultsEnabled?: boolean;
  formResultsSheetName?: string | null;
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
  if (body.friendLedgerEnabled !== undefined && typeof body.friendLedgerEnabled !== 'boolean') {
    return { ok: false, error: '友だち台帳の同期設定を正しく選択してください' };
  }
  if (body.formResultsEnabled !== undefined && typeof body.formResultsEnabled !== 'boolean') {
    return { ok: false, error: 'フォーム回答シートの同期設定を正しく選択してください' };
  }
  let formResultsSheetName: string | null | undefined;
  if (body.formResultsSheetName !== undefined) {
    formResultsSheetName = body.formResultsSheetName === null
      ? null
      : cleanString(body.formResultsSheetName);
    if (formResultsSheetName !== null) {
      if (
        !formResultsSheetName
        || formResultsSheetName.length > 200
        || /[\u0000-\u001f\u007f]/.test(formResultsSheetName)
      ) {
        return { ok: false, error: 'フォーム回答シート名を正しく選択してください' };
      }
      if (formResultsSheetName === sheetName) {
        return { ok: false, error: 'フォーム回答は友だち台帳と別のタブを選択してください' };
      }
    }
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
  let selectedFormFieldIds: string[] | undefined;
  if (body.selectedFormFieldIds !== undefined) {
    if (
      !Array.isArray(body.selectedFormFieldIds)
      || body.selectedFormFieldIds.length > MAX_SELECTED_FORM_FIELDS
    ) {
      return { ok: false, error: '同期するフォーム項目を正しく選択してください' };
    }
    selectedFormFieldIds = body.selectedFormFieldIds.map(cleanString);
    if (
      selectedFormFieldIds.some((id) => !id || id.length > 200)
      || new Set(selectedFormFieldIds).size !== selectedFormFieldIds.length
    ) {
      return { ok: false, error: '同期するフォーム項目を正しく選択してください' };
    }
  }
  return {
    ok: true,
    value: {
      spreadsheetId,
      sheetName,
      syncDirection,
      selectedFieldIds,
      selectedFormFieldIds,
      friendLedgerEnabled: body.friendLedgerEnabled as boolean | undefined,
      formResultsEnabled: body.formResultsEnabled as boolean | undefined,
      formResultsSheetName,
    },
  };
}

function validateCreate(body: ConnectionInput): ValidationResult<ValidCreate> {
  const settings = validateSettings(body);
  if (!settings.ok) return settings;
  const lineAccountId = cleanString(body.lineAccountId);
  const formId = cleanString(body.formId);
  if (!lineAccountId || lineAccountId.length > 200) {
    return { ok: false, error: 'LINE アカウントを選択してください' };
  }
  if (!formId || formId.length > 200 || /[\u0000-\u001f\u007f]/.test(formId)) {
    return { ok: false, error: 'フォーム ID を正しく入力してください' };
  }
  if ((settings.value.formResultsEnabled ?? true) && !settings.value.formResultsSheetName) {
    return { ok: false, error: 'フォーム回答シートのタブを選択してください' };
  }
  return { ok: true, value: { lineAccountId, formId, ...settings.value } };
}

function validateLineAccountId(value: unknown): ValidationResult<string> {
  const lineAccountId = cleanString(value);
  return lineAccountId && lineAccountId.length <= 200
    ? { ok: true, value: lineAccountId }
    : { ok: false, error: 'LINE アカウントを選択してください' };
}

async function getScopedInternalForm(
  db: D1Database,
  formId: string,
  lineAccountId: string,
): Promise<{ title: string } | null> {
  return db.prepare(
    `SELECT title FROM formaloo_forms
     WHERE id = ? AND deleted = 0 AND render_backend = 'internal'
       AND (line_account_id IS NULL OR line_account_id = ?)`,
  ).bind(formId, lineAccountId).first<{ title: string }>();
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

function isStrictIso8601Instant(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1
    || year > 9998
    || month < 1
    || month > 12
    || day < 1
    || day > daysInMonth[month - 1]
    || hour > 23
    || minute > 59
    || second > 59
  ) return false;
  if (match[8] !== 'Z') {
    const offsetHour = Number(match[10]);
    const offsetMinute = Number(match[11]);
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
      return false;
    }
  }
  return Number.isFinite(Date.parse(value));
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
    || !isStrictIso8601Instant(occurredAt)
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

function sheetsFailure(error: unknown): {
  category: GoogleSheetsErrorCategory;
  operation: GoogleSheetsError['operation'];
  status: number;
  detail?: string;
} {
  return error instanceof GoogleSheetsError
    ? {
        category: error.category,
        operation: error.operation,
        status: error.status,
        ...(error.detail ? { detail: error.detail } : {}),
      }
    : { category: 'network', operation: 'metadata', status: 0 };
}

// Builder guide: only the public service-account email leaves the Worker.
sheetsConnections.get(`${BASE_PATH}/setup`, (c) => {
  const denied = ownerGate(c, OWNER_MESSAGE);
  if (denied) return denied;
  c.header('Cache-Control', 'no-store');
  if (!c.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return c.json({ success: false, error: SETUP_MESSAGE }, 503);
  }
  try {
    const credentials = parseGoogleServiceAccountCredentials(c.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    return c.json({ success: true, data: { serviceAccountEmail: credentials.clientEmail } });
  } catch {
    console.error('Google Sheets setup guide failed', { category: 'key_format' });
    return c.json({ success: false, error: CONNECTION_TEST_MESSAGES.key_format }, 503);
  }
});

// Builder connection check: shared URL -> access test -> real tab titles.
sheetsConnections.post(`${BASE_PATH}/inspect`, async (c) => {
  const denied = ownerGate(c, OWNER_MESSAGE);
  if (denied) return denied;
  const body = await readJson(c);
  const lineAccountId = validateLineAccountId(body.lineAccountId);
  if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
  const formId = cleanString(body.formId);
  const spreadsheetId = extractGoogleSpreadsheetId(cleanString(body.spreadsheetUrl));
  if (!spreadsheetId) {
    return c.json({
      success: false,
      error: 'Google スプレッドシートの共有URLを貼り付けてください',
    }, 400);
  }
  if (!formId) return c.json({ success: false, error: 'フォームを確認できません' }, 400);
  const form = await getScopedInternalForm(c.env.DB, formId, lineAccountId.value);
  if (!form) return c.json({ success: false, error: 'フォームを確認できません' }, 400);
  if (!c.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return c.json({ success: false, error: SETUP_MESSAGE }, 503);
  }
  let credentials: ReturnType<typeof parseGoogleServiceAccountCredentials>;
  try {
    credentials = parseGoogleServiceAccountCredentials(c.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch {
    return c.json({ success: false, error: CONNECTION_TEST_MESSAGES.key_format }, 503);
  }
  try {
    const sheetNames = await new GoogleSheetsClient({ credentials }).listSheetTitles(spreadsheetId);
    if (sheetNames.length === 0) {
      return c.json({ success: false, error: 'スプレッドシートのタブを読み込めませんでした' }, 502);
    }
    return c.json({
      success: true,
      data: { ok: true, spreadsheetId, sheetNames },
    });
  } catch (error) {
    const failure = sheetsFailure(error);
    console.error('Google Sheets connection inspection failed', failure);
    return c.json({
      success: true,
      data: {
        ok: false,
        category: failure.category,
        message: CONNECTION_TEST_MESSAGES[failure.category],
      },
    });
  }
});

// GET /api/integrations/google-sheets/connections?lineAccountId=&formId=
sheetsConnections.get(BASE_PATH, async (c) => {
  const denied = ownerGate(c, OWNER_MESSAGE);
  if (denied) return denied;
  const lineAccountId = cleanString(c.req.query('lineAccountId'));
  const formId = cleanString(c.req.query('formId')) || undefined;
  if (!lineAccountId) return c.json({ success: false, error: 'lineAccountId is required' }, 400);
  try {
    const connections = await listSheetsConnections(c.env.DB, lineAccountId, formId);
    const data = await Promise.all(connections.map(async (connection) => {
      const [form, latestSyncJob] = await Promise.all([
        getScopedInternalForm(c.env.DB, connection.formId, lineAccountId),
        getLatestSheetsSyncJob(c.env.DB, lineAccountId, connection.id),
      ]);
      return {
        ...connection,
        formName: cleanString(form?.title) || 'フォーム名を確認できません',
        latestSyncJob,
      };
    }));
    return c.json({ success: true, data });
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
    const form = await getScopedInternalForm(
      c.env.DB,
      validated.value.formId,
      validated.value.lineAccountId,
    );
    if (!form) return c.json({ success: false, error: 'フォームを確認できません' }, 400);
    const mappings = await resolveFriendFieldMappings(c.env.DB, validated.value.selectedFieldIds ?? []);
    if (!mappings.ok) return c.json({ success: false, error: mappings.error }, 400);
    const created = await replaceSheetsConnection(c.env.DB, {
      lineAccountId: validated.value.lineAccountId,
      formId: validated.value.formId,
      spreadsheetId: validated.value.spreadsheetId,
      sheetName: validated.value.sheetName,
      syncDirection: validated.value.syncDirection,
      friendFieldMappings: mappings.value ?? [],
      friendLedgerEnabled: validated.value.friendLedgerEnabled ?? false,
      formResultsEnabled: validated.value.formResultsEnabled ?? true,
      formResultsSheetName: validated.value.formResultsSheetName ?? null,
      selectedFormFieldIds: validated.value.selectedFormFieldIds,
    });
    if (!created) {
      return c.json({
        success: false,
        error: '同期中です。少し待ってからもう一度保存してください',
      }, 409);
    }
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
    const existing = await getSheetsConnection(
      c.env.DB,
      validated.value.lineAccountId,
      c.req.param('id'),
    );
    if (!existing) return c.json({ success: false, error: '接続設定が見つかりません' }, 404);
    const formResultsEnabled = validated.value.formResultsEnabled ?? existing.formResultsEnabled;
    const formResultsSheetName = validated.value.formResultsSheetName === undefined
      ? existing.formResultsSheetName
      : validated.value.formResultsSheetName;
    if (formResultsEnabled && !formResultsSheetName) {
      return c.json({ success: false, error: 'フォーム回答シートのタブを選択してください' }, 400);
    }
    if (formResultsSheetName === validated.value.sheetName) {
      return c.json({ success: false, error: 'フォーム回答は友だち台帳と別のタブを選択してください' }, 400);
    }
    const mappings = await resolveFriendFieldMappings(c.env.DB, validated.value.selectedFieldIds);
    if (!mappings.ok) return c.json({ success: false, error: mappings.error }, 400);
    const updated = await updateSheetsConnection(c.env.DB, validated.value.lineAccountId, c.req.param('id'), {
      spreadsheetId: validated.value.spreadsheetId,
      sheetName: validated.value.sheetName,
      syncDirection: validated.value.syncDirection,
      friendFieldMappings: mappings.value,
      friendLedgerEnabled: validated.value.friendLedgerEnabled,
      formResultsEnabled: validated.value.formResultsEnabled,
      formResultsSheetName: validated.value.formResultsSheetName,
      selectedFormFieldIds: validated.value.selectedFormFieldIds,
    });
    if (!updated) {
      const current = await getSheetsConnection(c.env.DB, validated.value.lineAccountId, c.req.param('id'));
      if (current) {
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
    const sheetName = !connection.friendLedgerEnabled
      && connection.formResultsEnabled
      && connection.formResultsSheetName
      ? connection.formResultsSheetName
      : connection.sheetName;
    await client.readValues(connection.spreadsheetId, quotedA1SheetName(sheetName));
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

// POST /api/integrations/google-sheets/connections/:id/webhook-secret
// Returns only the selected connection's derived signing key. The deployment
// master remains Worker-only and is never serialized.
sheetsConnections.post(`${BASE_PATH}/:id/webhook-secret`, async (c) => {
  const denied = ownerGate(c, OWNER_MESSAGE);
  if (denied) return denied;
  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  const lineAccountId = validateLineAccountId(c.req.query('lineAccountId'));
  if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
  try {
    const connection = await getSheetsConnection(c.env.DB, lineAccountId.value, c.req.param('id'));
    if (!connection) return c.json({ success: false, error: '接続設定が見つかりません' }, 404);
    const webhookSecret = await deriveSheetsWebhookSecret(
      c.env.SHEETS_WEBHOOK_SECRET,
      connection.id,
    );
    if (!webhookSecret) {
      return c.json({ success: false, error: '通知用の秘密設定が未完了です' }, 503);
    }
    return c.json({ success: true, data: { webhookSecret } });
  } catch {
    console.error('POST Google Sheets connection webhook secret failed');
    return c.json({ success: false, error: 'Internal server error' }, 500);
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
    const targets: SheetsSyncTarget[] = [];
    if (connection.friendLedgerEnabled) targets.push('ledger');
    if (connection.formResultsEnabled && connection.formResultsSheetName) targets.push('form_results');
    if (targets.length === 0) {
      return c.json({ success: false, error: '同期するシートを選択してください' }, 409);
    }
    if (!c.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      return c.json({ success: false, error: SETUP_MESSAGE }, 503);
    }
    const jobs = await Promise.all(targets.map((target) => startSheetsSyncJob({
      db: c.env.DB,
      connection,
      source: 'manual',
      actor: c.get('staff').id,
      target,
    })));
    c.executionCtx.waitUntil(
      dispatchSheetsSyncWork(c.env).catch(async () => {
        await Promise.all(jobs.map((job) => (
          recordSheetsSyncDispatchError(c.env.DB, job.id).catch(() => undefined)
        )));
        console.error('Manual Google Sheets sync dispatch failed');
      }),
    );
    return c.json({ success: true, data: jobs[0] }, 202);
  } catch {
    console.error('Manual Google Sheets sync failed');
    return c.json({ success: false, error: '手動同期に失敗しました' }, 500);
  }
});

// GET /api/integrations/google-sheets/connections/:id/sync/latest
sheetsConnections.get(`${BASE_PATH}/:id/sync/latest`, async (c) => {
  const denied = ownerGate(c, OWNER_MESSAGE);
  if (denied) return denied;
  const lineAccountId = validateLineAccountId(c.req.query('lineAccountId'));
  if (!lineAccountId.ok) return c.json({ success: false, error: lineAccountId.error }, 400);
  try {
    const connection = await getSheetsConnection(c.env.DB, lineAccountId.value, c.req.param('id'));
    if (!connection) return c.json({ success: false, error: '接続設定が見つかりません' }, 404);
    const job = await getLatestSheetsSyncJob(c.env.DB, lineAccountId.value, connection.id);
    return c.json({ success: true, data: job });
  } catch {
    console.error('GET latest friend ledger sync job failed');
    return c.json({ success: false, error: '同期状況を確認できませんでした' }, 500);
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
  const signedConnectionId = cleanString(c.req.header('X-Sheets-Connection-Id'));
  const connectionSecret = await deriveSheetsWebhookSecret(
    c.env.SHEETS_WEBHOOK_SECRET,
    signedConnectionId,
  );
  const verified = await verifySheetsWebhookSignature({
    rawBody,
    signature,
    timestamp,
    secret: connectionSecret,
  });
  if (!verified) return c.json({ success: false, error: '署名を確認できません' }, 401);

  let payload: FriendLedgerWebhookPayload | null = null;
  try {
    payload = parseWebhookPayload(JSON.parse(rawBody) as unknown);
  } catch {
    // Invalid JSON is intentionally handled only after the signature check.
  }
  if (!payload) return c.json({ success: false, error: '通知の形式が正しくありません' }, 400);
  if (payload.connectionId !== signedConnectionId) {
    return c.json({ success: false, error: '接続IDが一致しません' }, 400);
  }
  if (payload.occurredAt !== timestamp) {
    return c.json({ success: false, error: '通知時刻が一致しません' }, 400);
  }

  try {
    const connection = await getActiveSheetsConnectionById(c.env.DB, payload.connectionId);
    const target: SheetsSyncTarget | null = connection?.friendLedgerEnabled
      && connection.sheetName === payload.sheetName
      ? 'ledger'
      : connection?.formResultsEnabled
        && connection.formResultsSheetName === payload.sheetName
        ? 'form_results'
        : null;
    if (
      !connection
      || connection.spreadsheetId !== payload.spreadsheetId
      || !target
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
        target,
      },
    );
    if (!queued) return c.json({ success: false, error: '接続設定が更新されました' }, 409);
    if (queued.status === 'pending' && c.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      const drainWebhookEvents = target === 'form_results'
        ? drainFormResultsWebhookEvents
        : drainFriendLedgerWebhookEvents;
      const work = drainWebhookEvents({
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
