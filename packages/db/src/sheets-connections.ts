import { jstNow } from './utils.js';

export type SheetsSyncDirection = 'to_sheets' | 'from_sheets' | 'bidirectional';
export type SheetsConflictPolicy = 'last_write_wins';
export type SheetsSyncStatus = 'idle' | 'running' | 'success' | 'warning' | 'error';

export interface SheetsFriendFieldMapping {
  fieldId: string;
  header: string;
}

export interface SheetsConnection {
  id: string;
  lineAccountId: string;
  formId: string;
  spreadsheetId: string;
  sheetName: string;
  syncDirection: SheetsSyncDirection;
  conflictPolicy: SheetsConflictPolicy;
  conflictClock: 'server_sequence';
  configVersion: number;
  friendFieldMappings: SheetsFriendFieldMapping[];
  friendLedgerEnabled: boolean;
  friendLedgerHeaders: string[];
  lastSyncAt: string | null;
  lastSyncStatus: SheetsSyncStatus;
  lastSyncWarning: string | null;
  lastSyncErrorCode: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface SheetsConnectionRow {
  id: string;
  line_account_id: string;
  form_id: string;
  spreadsheet_id: string;
  sheet_name: string;
  sync_direction: SheetsSyncDirection;
  conflict_policy: SheetsConflictPolicy;
  conflict_clock: 'server_sequence';
  config_version: number;
  friend_field_mappings_json: string;
  friend_ledger_enabled: number;
  friend_ledger_headers_json: string;
  last_sync_at: string | null;
  last_sync_status: SheetsSyncStatus;
  last_sync_warning: string | null;
  last_sync_error_code: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface CreateSheetsConnectionInput {
  lineAccountId: string;
  formId: string;
  spreadsheetId: string;
  sheetName: string;
  syncDirection: SheetsSyncDirection;
  friendFieldMappings?: SheetsFriendFieldMapping[];
  friendLedgerEnabled?: boolean;
}

export interface UpdateSheetsConnectionInput {
  spreadsheetId: string;
  sheetName: string;
  syncDirection: SheetsSyncDirection;
  friendFieldMappings?: SheetsFriendFieldMapping[];
  friendLedgerEnabled?: boolean;
}

export interface UpdateSheetsSyncStatusInput {
  status: SheetsSyncStatus;
  lastSyncAt: string | null;
  warning: string | null;
  errorCode: string | null;
}

export interface SheetsSyncLeaseGuard {
  token: string;
  now: string;
}

export type SheetsWebhookActorKind = 'google_email' | 'unavailable';
export type SheetsWebhookEventStatus = 'pending' | 'applied' | 'dead';

export interface SheetsWebhookEvent {
  sequence: number;
  connectionId: string;
  lineAccountId: string;
  connectionVersion: number;
  eventId: string;
  actor: string;
  actorKind: SheetsWebhookActorKind;
  occurredAt: string;
  payload: Record<string, unknown> | null;
  status: SheetsWebhookEventStatus;
  attempts: number;
  availableAt: string;
  processingToken: string | null;
  processingExpiresAt: string | null;
  receivedAt: string;
  completedAt: string | null;
  lastErrorCode: string | null;
}

interface SheetsWebhookEventRow {
  sequence: number;
  connection_id: string;
  line_account_id: string;
  connection_version: number;
  event_id: string;
  actor: string;
  actor_kind: SheetsWebhookActorKind;
  occurred_at: string;
  payload_json: string | null;
  status: SheetsWebhookEventStatus;
  attempts: number;
  available_at: string;
  processing_token: string | null;
  processing_expires_at: string | null;
  received_at: string;
  completed_at: string | null;
  last_error_code: string | null;
}

export type SheetsCanonicalCellValue = string | number | boolean | null;

export interface SheetsSyncLedgerEntry {
  connectionId: string;
  connectionVersion: number;
  recordKey: string;
  sheetRowNumber: number | null;
  rowFingerprint: string;
  canonicalSnapshot: Record<string, SheetsCanonicalCellValue>;
  harnessUpdatedAt: string | null;
  sheetObservedAt: string | null;
  lastSyncedAt: string;
  lastSyncDirection: Exclude<SheetsSyncDirection, 'bidirectional'>;
  lastAppliedSequence: number;
  version: number;
}

interface SheetsSyncLedgerRow {
  connection_id: string;
  connection_version: number;
  record_key: string;
  sheet_row_number: number | null;
  row_fingerprint: string;
  canonical_snapshot_json: string;
  harness_updated_at: string | null;
  sheet_observed_at: string | null;
  last_synced_at: string;
  last_sync_direction: Exclude<SheetsSyncDirection, 'bidirectional'>;
  last_applied_sequence: number;
  version: number;
}

export type SheetsSyncAuditSource = 'webhook' | 'polling' | 'manual';
export type SheetsSyncAuditChangeKind = 'custom_field' | 'identity_sync' | 'identity_ignored' | 'conflict';

export interface SheetsSyncAuditDetailInput {
  id: string;
  actor: string;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  source: SheetsSyncAuditSource;
  changeKind: SheetsSyncAuditChangeKind;
}

export interface SheetsSyncAuditDetail extends SheetsSyncAuditDetailInput {
  createdAt: string;
}

export interface AppendSheetsSyncAuditInput {
  id: string;
  connectionId: string;
  connectionVersion: number;
  applySequence: number;
  recordKey: string | null;
  sheetRowNumber: number | null;
  direction: Exclude<SheetsSyncDirection, 'bidirectional'>;
  action: 'append' | 'read' | 'update' | 'conflict';
  outcome: 'applied' | 'skipped' | 'failed';
  conflictResolution: 'harness_wins' | 'sheet_wins' | 'same_sequence' | null;
  harnessUpdatedAt: string | null;
  sheetObservedAt: string | null;
  beforeFingerprint: string | null;
  afterFingerprint: string | null;
  errorCode: string | null;
  webhookEventId?: string | null;
  details: SheetsSyncAuditDetailInput[];
}

export interface SheetsSyncAuditEntry extends Omit<AppendSheetsSyncAuditInput, 'details'> {
  lineAccountId: string;
  formId: string;
  spreadsheetId: string;
  sheetName: string;
  createdAt: string;
  details: SheetsSyncAuditDetail[];
}

interface SheetsSyncAuditRow {
  id: string;
  connection_id: string;
  connection_version: number;
  apply_sequence: number;
  line_account_id: string;
  form_id: string;
  spreadsheet_id: string;
  sheet_name: string;
  record_key: string | null;
  sheet_row_number: number | null;
  direction: Exclude<SheetsSyncDirection, 'bidirectional'>;
  action: SheetsSyncAuditEntry['action'];
  outcome: SheetsSyncAuditEntry['outcome'];
  conflict_resolution: SheetsSyncAuditEntry['conflictResolution'];
  harness_updated_at: string | null;
  sheet_observed_at: string | null;
  before_fingerprint: string | null;
  after_fingerprint: string | null;
  error_code: string | null;
  webhook_event_id: string | null;
  created_at: string;
}

interface SheetsSyncAuditDetailRow {
  id: string;
  audit_id: string;
  actor: string;
  column_name: string;
  old_value: string | null;
  new_value: string | null;
  source: SheetsSyncAuditSource;
  change_kind: SheetsSyncAuditChangeKind;
  created_at: string;
}

function parseFriendFieldMappings(value: string): SheetsFriendFieldMapping[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const fieldId = (entry as { fieldId?: unknown }).fieldId;
      const header = (entry as { header?: unknown }).header;
      return typeof fieldId === 'string' && fieldId && typeof header === 'string' && header
        ? [{ fieldId, header }]
        : [];
    });
  } catch {
    return [];
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      : [];
  } catch {
    return [];
  }
}

function parseCanonicalSnapshot(value: string): Record<string, SheetsCanonicalCellValue> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const snapshot: Record<string, SheetsCanonicalCellValue> = {};
    for (const [key, cell] of Object.entries(parsed)) {
      if (cell === null || ['string', 'number', 'boolean'].includes(typeof cell)) {
        snapshot[key] = cell as SheetsCanonicalCellValue;
      }
    }
    return snapshot;
  } catch {
    return {};
  }
}

function serializeLedger(row: SheetsSyncLedgerRow): SheetsSyncLedgerEntry {
  return {
    connectionId: row.connection_id,
    connectionVersion: row.connection_version,
    recordKey: row.record_key,
    sheetRowNumber: row.sheet_row_number,
    rowFingerprint: row.row_fingerprint,
    canonicalSnapshot: parseCanonicalSnapshot(row.canonical_snapshot_json),
    harnessUpdatedAt: row.harness_updated_at,
    sheetObservedAt: row.sheet_observed_at,
    lastSyncedAt: row.last_synced_at,
    lastSyncDirection: row.last_sync_direction,
    lastAppliedSequence: row.last_applied_sequence,
    version: row.version,
  };
}

function serializeAuditDetail(row: SheetsSyncAuditDetailRow): SheetsSyncAuditDetail {
  return {
    id: row.id,
    actor: row.actor,
    fieldName: row.column_name,
    oldValue: row.old_value,
    newValue: row.new_value,
    source: row.source,
    changeKind: row.change_kind,
    createdAt: row.created_at,
  };
}

function serializeAudit(
  row: SheetsSyncAuditRow,
  details: SheetsSyncAuditDetail[],
): SheetsSyncAuditEntry {
  return {
    id: row.id,
    connectionId: row.connection_id,
    connectionVersion: row.connection_version,
    applySequence: row.apply_sequence,
    lineAccountId: row.line_account_id,
    formId: row.form_id,
    spreadsheetId: row.spreadsheet_id,
    sheetName: row.sheet_name,
    recordKey: row.record_key,
    sheetRowNumber: row.sheet_row_number,
    direction: row.direction,
    action: row.action,
    outcome: row.outcome,
    conflictResolution: row.conflict_resolution,
    harnessUpdatedAt: row.harness_updated_at,
    sheetObservedAt: row.sheet_observed_at,
    beforeFingerprint: row.before_fingerprint,
    afterFingerprint: row.after_fingerprint,
    errorCode: row.error_code,
    webhookEventId: row.webhook_event_id,
    createdAt: row.created_at,
    details,
  };
}

function boundedLimit(limit: number, fallback = 100): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(100, Math.trunc(limit)));
}

function serialize(row: SheetsConnectionRow): SheetsConnection {
  return {
    id: row.id,
    lineAccountId: row.line_account_id,
    formId: row.form_id,
    spreadsheetId: row.spreadsheet_id,
    sheetName: row.sheet_name,
    syncDirection: row.sync_direction,
    conflictPolicy: row.conflict_policy,
    conflictClock: row.conflict_clock,
    configVersion: row.config_version,
    friendFieldMappings: parseFriendFieldMappings(row.friend_field_mappings_json),
    friendLedgerEnabled: row.friend_ledger_enabled === 1,
    friendLedgerHeaders: parseStringArray(row.friend_ledger_headers_json),
    lastSyncAt: row.last_sync_at,
    lastSyncStatus: row.last_sync_status,
    lastSyncWarning: row.last_sync_warning,
    lastSyncErrorCode: row.last_sync_error_code,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ACTIVE_SELECT = `
  SELECT id, line_account_id, form_id, spreadsheet_id, sheet_name,
         sync_direction, conflict_policy, conflict_clock, config_version,
         friend_field_mappings_json, friend_ledger_enabled, friend_ledger_headers_json,
         last_sync_at, last_sync_status,
         last_sync_warning, last_sync_error_code,
         is_active, created_at, updated_at
  FROM sheets_connections
  WHERE is_active = 1 AND deleted_at IS NULL`;

export async function listSheetsConnections(
  db: D1Database,
  lineAccountId: string,
  formId?: string,
): Promise<SheetsConnection[]> {
  const query = formId
    ? `${ACTIVE_SELECT} AND line_account_id = ? AND form_id = ? ORDER BY updated_at DESC, id ASC`
    : `${ACTIVE_SELECT} AND line_account_id = ? ORDER BY updated_at DESC, id ASC`;
  const statement = db.prepare(query);
  const result = formId
    ? await statement.bind(lineAccountId, formId).all<SheetsConnectionRow>()
    : await statement.bind(lineAccountId).all<SheetsConnectionRow>();
  return result.results.map(serialize);
}

export async function getSheetsConnection(
  db: D1Database,
  lineAccountId: string,
  id: string,
): Promise<SheetsConnection | null> {
  const row = await db.prepare(`${ACTIVE_SELECT} AND line_account_id = ? AND id = ?`)
    .bind(lineAccountId, id)
    .first<SheetsConnectionRow>();
  return row ? serialize(row) : null;
}

/**
 * Resolves an active connection when no tenant context is available yet.
 * Callers must authenticate the connection id (for example with the webhook
 * signature) before using this deliberately unscoped lookup.
 */
export async function getActiveSheetsConnectionById(
  db: D1Database,
  id: string,
): Promise<SheetsConnection | null> {
  const row = await db.prepare(`${ACTIVE_SELECT} AND id = ?`)
    .bind(id)
    .first<SheetsConnectionRow>();
  return row ? serialize(row) : null;
}

export async function createSheetsConnection(
  db: D1Database,
  input: CreateSheetsConnectionInput,
): Promise<SheetsConnection> {
  const id = `gsc_${crypto.randomUUID()}`;
  const now = jstNow();
  await db.prepare(
    `INSERT INTO sheets_connections
       (id, line_account_id, form_id, spreadsheet_id, sheet_name, sync_direction,
        conflict_policy, friend_field_mappings_json, friend_ledger_enabled,
        is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'last_write_wins', ?, ?, 1, ?, ?)`,
  ).bind(
    id,
    input.lineAccountId,
    input.formId,
    input.spreadsheetId,
    input.sheetName,
    input.syncDirection,
    JSON.stringify(input.friendFieldMappings ?? []),
    input.friendLedgerEnabled ? 1 : 0,
    now,
    now,
  ).run();
  const created = await getSheetsConnection(db, input.lineAccountId, id);
  if (!created) throw new Error('Sheets connection was not created');
  return created;
}

export async function updateSheetsConnection(
  db: D1Database,
  lineAccountId: string,
  id: string,
  input: UpdateSheetsConnectionInput,
): Promise<SheetsConnection | null> {
  const now = jstNow();
  const mappingsJson = input.friendFieldMappings === undefined
    ? null
    : JSON.stringify(input.friendFieldMappings);
  const update = db.prepare(
    `UPDATE sheets_connections
     SET spreadsheet_id = ?, sheet_name = ?, sync_direction = ?,
         friend_field_mappings_json = COALESCE(?, friend_field_mappings_json),
         friend_ledger_enabled = COALESCE(?, friend_ledger_enabled),
         friend_ledger_headers_json = CASE
           WHEN spreadsheet_id <> ? OR sheet_name <> ? THEN '[]'
           WHEN ? IS NULL THEN friend_ledger_headers_json
           ELSE COALESCE((
             SELECT json_group_array(value)
             FROM json_each(friend_ledger_headers_json)
             WHERE value IN ('表示名', 'userId', '登録日')
                OR value IN (
                  SELECT json_extract(value, '$.header') FROM json_each(?)
                )
           ), '[]')
         END,
         config_version = config_version + 1, updated_at = ?
     WHERE id = ? AND line_account_id = ? AND is_active = 1 AND deleted_at IS NULL
       AND (
         sync_lock_token IS NULL OR sync_lock_expires_at IS NULL
         OR julianday(sync_lock_expires_at) <= julianday(?)
       )`,
  ).bind(
    input.spreadsheetId,
    input.sheetName,
    input.syncDirection,
    mappingsJson,
    input.friendLedgerEnabled === undefined ? null : input.friendLedgerEnabled ? 1 : 0,
    input.spreadsheetId,
    input.sheetName,
    mappingsJson,
    mappingsJson,
    now,
    id,
    lineAccountId,
    now,
  );
  // Every accepted settings write advances the generation. D1 serializes the
  // increments, so concurrent owner tabs remain last-write-wins without a false
  // not-found response. Old workers then fail the ledger version triggers.
  const result = (await db.batch([
    update,
    db.prepare(
      `DELETE FROM sheets_sync_ledger
       WHERE connection_id = ?
         AND EXISTS (
           SELECT 1 FROM sheets_connections
           WHERE id = ? AND line_account_id = ? AND is_active = 1 AND deleted_at IS NULL
             AND (
               sync_lock_token IS NULL OR sync_lock_expires_at IS NULL
               OR julianday(sync_lock_expires_at) <= julianday(?)
             )
         )`,
    ).bind(id, id, lineAccountId, now),
  ]))[0];
  if ((result.meta.changes ?? 0) !== 1) return null;
  return getSheetsConnection(db, lineAccountId, id);
}

export async function softDeleteSheetsConnection(
  db: D1Database,
  lineAccountId: string,
  id: string,
): Promise<boolean> {
  const now = jstNow();
  const result = (await db.batch([
    db.prepare(
      `UPDATE sheets_connections
       SET is_active = 0, deleted_at = ?, updated_at = ?
       WHERE id = ? AND line_account_id = ? AND is_active = 1 AND deleted_at IS NULL
         AND (
           sync_lock_token IS NULL OR sync_lock_expires_at IS NULL
           OR julianday(sync_lock_expires_at) <= julianday(?)
         )`,
    ).bind(now, now, id, lineAccountId, now),
    db.prepare(
      `DELETE FROM sheets_sync_ledger
       WHERE connection_id = ?
         AND EXISTS (
           SELECT 1 FROM sheets_connections
           WHERE id = ? AND line_account_id = ?
             AND (
               sync_lock_token IS NULL OR sync_lock_expires_at IS NULL
               OR julianday(sync_lock_expires_at) <= julianday(?)
             )
         )`,
    ).bind(id, id, lineAccountId, now),
  ]))[0];
  return (result.meta.changes ?? 0) === 1;
}

/**
 * Atomically allocates the ordering key used by last-write-wins.
 * A stale worker must present its captured config version and receives null
 * after any settings save, so it cannot publish a write under a new target.
 */
export async function reserveSheetsSyncSequence(
  db: D1Database,
  lineAccountId: string,
  id: string,
  configVersion: number,
  lease?: SheetsSyncLeaseGuard,
): Promise<number | null> {
  const row = await db.prepare(
    `UPDATE sheets_connections
     SET next_sync_sequence = next_sync_sequence + 1
     WHERE id = ? AND line_account_id = ? AND config_version = ?
       AND is_active = 1 AND deleted_at IS NULL
       AND (
         ? IS NULL OR (
           sync_lock_token = ? AND sync_lock_expires_at IS NOT NULL
           AND julianday(sync_lock_expires_at) > julianday(?)
         )
       )
     RETURNING next_sync_sequence - 1 AS sequence`,
  ).bind(
    id,
    lineAccountId,
    configVersion,
    lease?.token ?? null,
    lease?.token ?? null,
    lease?.now ?? null,
  ).first<{ sequence: number }>();
  return row?.sequence ?? null;
}

export async function updateSheetsSyncStatus(
  db: D1Database,
  lineAccountId: string,
  id: string,
  input: UpdateSheetsSyncStatusInput,
  lease?: SheetsSyncLeaseGuard,
): Promise<SheetsConnection | null> {
  const result = await db.prepare(
    `UPDATE sheets_connections
     SET last_sync_at = ?, last_sync_status = ?, last_sync_warning = ?,
         last_sync_error_code = ?
     WHERE id = ? AND line_account_id = ? AND is_active = 1 AND deleted_at IS NULL
       AND (
         ? IS NULL OR (
           sync_lock_token = ? AND sync_lock_expires_at IS NOT NULL
           AND julianday(sync_lock_expires_at) > julianday(?)
         )
       )`,
  ).bind(
    input.lastSyncAt,
    input.status,
    input.warning,
    input.errorCode,
    id,
    lineAccountId,
    lease?.token ?? null,
    lease?.token ?? null,
    lease?.now ?? null,
  ).run();
  if ((result.meta.changes ?? 0) !== 1) return null;
  return getSheetsConnection(db, lineAccountId, id);
}

/** Lists work across all tenants for the trusted cron dispatcher. */
export async function listActiveSheetsConnectionsForSync(
  db: D1Database,
  limit: number,
): Promise<SheetsConnection[]> {
  const result = await db.prepare(
    `${ACTIVE_SELECT} AND friend_ledger_enabled = 1
     ORDER BY COALESCE(last_sync_at, '') ASC, id ASC LIMIT ?`,
  ).bind(boundedLimit(limit)).all<SheetsConnectionRow>();
  return result.results.map(serialize);
}

export async function recordSheetsFriendLedgerHeaders(
  db: D1Database,
  lineAccountId: string,
  id: string,
  configVersion: number,
  headers: string[],
  lease?: SheetsSyncLeaseGuard,
): Promise<boolean> {
  const normalized = [...new Set(headers.filter((header) => header.length > 0))];
  const result = await db.prepare(
    `UPDATE sheets_connections
     SET friend_ledger_headers_json = ?
     WHERE id = ? AND line_account_id = ? AND config_version = ?
       AND is_active = 1 AND deleted_at IS NULL
       AND (
         ? IS NULL OR (
           sync_lock_token = ? AND sync_lock_expires_at IS NOT NULL
           AND julianday(sync_lock_expires_at) > julianday(?)
         )
       )`,
  ).bind(
    JSON.stringify(normalized),
    id,
    lineAccountId,
    configVersion,
    lease?.token ?? null,
    lease?.token ?? null,
    lease?.now ?? null,
  ).run();
  return (result.meta.changes ?? 0) === 1;
}

function serializeWebhookEvent(row: SheetsWebhookEventRow): SheetsWebhookEvent {
  let payload: Record<string, unknown> | null = null;
  if (row.payload_json) {
    try {
      const parsed = JSON.parse(row.payload_json) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      payload = null;
    }
  }
  return {
    sequence: row.sequence,
    connectionId: row.connection_id,
    lineAccountId: row.line_account_id,
    connectionVersion: row.connection_version,
    eventId: row.event_id,
    actor: row.actor,
    actorKind: row.actor_kind,
    occurredAt: row.occurred_at,
    payload,
    status: row.status,
    attempts: row.attempts,
    availableAt: row.available_at,
    processingToken: row.processing_token,
    processingExpiresAt: row.processing_expires_at,
    receivedAt: row.received_at,
    completedAt: row.completed_at,
    lastErrorCode: row.last_error_code,
  };
}

export async function enqueueSheetsWebhookEvent(
  db: D1Database,
  lineAccountId: string,
  connectionId: string,
  connectionVersion: number,
  input: {
    eventId: string;
    actor: string;
    actorKind: SheetsWebhookActorKind;
    occurredAt: string;
    payload: Record<string, unknown>;
    receivedAt: string;
  },
): Promise<{ sequence: number; status: SheetsWebhookEventStatus; enqueued: boolean } | null> {
  const inserted = await db.prepare(
    `INSERT INTO sheets_sync_webhook_events
       (connection_id, line_account_id, connection_version, event_id, actor, actor_kind,
        occurred_at, payload_json, available_at, received_at)
     SELECT c.id, c.line_account_id, c.config_version, ?, ?, ?, ?, ?, ?, ?
     FROM sheets_connections c
     WHERE c.id = ? AND c.line_account_id = ? AND c.config_version = ?
       AND c.friend_ledger_enabled = 1 AND c.is_active = 1 AND c.deleted_at IS NULL
     ON CONFLICT(connection_id, event_id) DO NOTHING
     RETURNING sequence, status`,
  ).bind(
    input.eventId,
    input.actor,
    input.actorKind,
    input.occurredAt,
    JSON.stringify(input.payload),
    input.receivedAt,
    input.receivedAt,
    connectionId,
    lineAccountId,
    connectionVersion,
  ).first<{ sequence: number; status: SheetsWebhookEventStatus }>();
  if (inserted) return { ...inserted, enqueued: true };
  const duplicate = await db.prepare(
    `SELECT e.sequence, e.status
     FROM sheets_sync_webhook_events e
     JOIN sheets_connections c ON c.id = e.connection_id
     WHERE e.connection_id = ? AND e.event_id = ?
       AND e.line_account_id = ? AND c.line_account_id = ?`,
  ).bind(connectionId, input.eventId, lineAccountId, lineAccountId)
    .first<{ sequence: number; status: SheetsWebhookEventStatus }>();
  if (!duplicate) return null;
  return { ...duplicate, enqueued: false };
}

export async function claimNextSheetsWebhookEvent(
  db: D1Database,
  lineAccountId: string,
  connectionId: string,
  connectionVersion: number,
  input: {
    token: string;
    now: string;
    expiresAt: string;
    discardBefore: string;
    maxAttempts: number;
  },
): Promise<SheetsWebhookEvent | null> {
  await db.prepare(
    `UPDATE sheets_sync_webhook_events
     SET status = 'dead', payload_json = NULL, actor = 'redacted', actor_kind = 'unavailable',
         processing_token = NULL, processing_expires_at = NULL,
         completed_at = ?, last_error_code = 'webhook_event_expired'
     WHERE line_account_id = ? AND connection_id = ? AND status = 'pending'
       AND (attempts >= ? OR julianday(received_at) < julianday(?))
       AND (
         processing_token IS NULL OR processing_expires_at IS NULL
         OR julianday(processing_expires_at) <= julianday(?)
       )`,
  ).bind(
    input.now,
    lineAccountId,
    connectionId,
    input.maxAttempts,
    input.discardBefore,
    input.now,
  ).run();
  const row = await db.prepare(
    `UPDATE sheets_sync_webhook_events
     SET processing_token = ?, processing_expires_at = ?
     WHERE sequence = (
       SELECT e.sequence
       FROM sheets_sync_webhook_events e
       JOIN sheets_connections c ON c.id = e.connection_id
       WHERE e.line_account_id = ? AND e.connection_id = ?
         AND e.connection_version = ? AND e.status = 'pending'
         AND e.attempts < ? AND julianday(e.available_at) <= julianday(?)
         AND (
           e.processing_token IS NULL OR e.processing_expires_at IS NULL
           OR julianday(e.processing_expires_at) <= julianday(?)
         )
         AND NOT EXISTS (
           SELECT 1 FROM sheets_sync_webhook_events owned
           WHERE owned.line_account_id = e.line_account_id
             AND owned.connection_id = e.connection_id
             AND owned.status = 'pending' AND owned.processing_token IS NOT NULL
             AND owned.processing_expires_at IS NOT NULL
             AND julianday(owned.processing_expires_at) > julianday(?)
         )
         AND c.line_account_id = e.line_account_id
         AND c.config_version = e.connection_version
         AND c.friend_ledger_enabled = 1 AND c.is_active = 1 AND c.deleted_at IS NULL
         AND (
           c.sync_lock_token IS NULL OR c.sync_lock_expires_at IS NULL
           OR julianday(c.sync_lock_expires_at) <= julianday(?)
         )
       ORDER BY e.sequence ASC
       LIMIT 1
     )
       AND line_account_id = ? AND connection_id = ? AND connection_version = ?
       AND status = 'pending'
       AND (
         processing_token IS NULL OR processing_expires_at IS NULL
         OR julianday(processing_expires_at) <= julianday(?)
       )
     RETURNING sequence, connection_id, line_account_id, connection_version, event_id,
               actor, actor_kind, occurred_at, payload_json, status, attempts,
               available_at, processing_token, processing_expires_at, received_at,
               completed_at, last_error_code`,
  ).bind(
    input.token,
    input.expiresAt,
    lineAccountId,
    connectionId,
    connectionVersion,
    input.maxAttempts,
    input.now,
    input.now,
    input.now,
    input.now,
    lineAccountId,
    connectionId,
    connectionVersion,
    input.now,
  ).first<SheetsWebhookEventRow>();
  return row ? serializeWebhookEvent(row) : null;
}

export async function expireSheetsWebhookEvents(
  db: D1Database,
  input: { now: string; discardBefore: string; maxAttempts: number; limit: number },
): Promise<number> {
  const result = await db.prepare(
    `UPDATE sheets_sync_webhook_events
     SET status = 'dead', payload_json = NULL, actor = 'redacted', actor_kind = 'unavailable',
         processing_token = NULL, processing_expires_at = NULL,
         completed_at = ?, last_error_code = 'webhook_event_expired'
     WHERE sequence IN (
       SELECT sequence
       FROM sheets_sync_webhook_events
       WHERE status = 'pending' AND (attempts >= ? OR julianday(received_at) < julianday(?))
         AND (
           processing_token IS NULL OR processing_expires_at IS NULL
           OR julianday(processing_expires_at) <= julianday(?)
         )
       ORDER BY sequence ASC
       LIMIT ?
     )`,
  ).bind(
    input.now,
    input.maxAttempts,
    input.discardBefore,
    input.now,
    boundedLimit(input.limit, 100),
  ).run();
  return result.meta.changes ?? 0;
}

export async function purgeSheetsWebhookEventTombstones(
  db: D1Database,
  input: { completedBefore: string; limit: number },
): Promise<number> {
  const result = await db.prepare(
    `DELETE FROM sheets_sync_webhook_events
     WHERE sequence IN (
       SELECT sequence
       FROM sheets_sync_webhook_events
       WHERE status IN ('applied', 'dead')
         AND julianday(completed_at) < julianday(?)
       ORDER BY completed_at ASC, sequence ASC
       LIMIT ?
     )`,
  ).bind(input.completedBefore, boundedLimit(input.limit, 100)).run();
  return result.meta.changes ?? 0;
}

export async function finishSheetsWebhookEvent(
  db: D1Database,
  lineAccountId: string,
  connectionId: string,
  connectionVersion: number,
  eventId: string,
  input: {
    processingToken: string;
    status: 'applied' | 'dead';
    completedAt: string;
    errorCode: string | null;
  },
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE sheets_sync_webhook_events
     SET status = ?, payload_json = NULL, actor = 'redacted', actor_kind = 'unavailable',
         processing_token = NULL, processing_expires_at = NULL,
         completed_at = ?, last_error_code = ?
     WHERE connection_id = ? AND connection_version = ? AND event_id = ?
       AND line_account_id = ? AND status = 'pending' AND processing_token = ?
       AND EXISTS (
         SELECT 1 FROM sheets_connections c
         WHERE c.id = sheets_sync_webhook_events.connection_id
           AND c.line_account_id = sheets_sync_webhook_events.line_account_id
       )`,
  ).bind(
    input.status,
    input.completedAt,
    input.errorCode,
    connectionId,
    connectionVersion,
    eventId,
    lineAccountId,
    input.processingToken,
  ).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function deferSheetsWebhookEvent(
  db: D1Database,
  lineAccountId: string,
  connectionId: string,
  connectionVersion: number,
  eventId: string,
  input: {
    processingToken: string;
    availableAt: string;
    errorCode: string;
  },
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE sheets_sync_webhook_events
     SET available_at = ?, processing_token = NULL, processing_expires_at = NULL,
         last_error_code = ?
     WHERE connection_id = ? AND connection_version = ? AND event_id = ?
       AND line_account_id = ? AND status = 'pending' AND processing_token = ?
       AND EXISTS (
         SELECT 1 FROM sheets_connections c
         WHERE c.id = sheets_sync_webhook_events.connection_id
           AND c.line_account_id = sheets_sync_webhook_events.line_account_id
       )`,
  ).bind(
    input.availableAt,
    input.errorCode,
    connectionId,
    connectionVersion,
    eventId,
    lineAccountId,
    input.processingToken,
  ).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function failSheetsWebhookEvent(
  db: D1Database,
  lineAccountId: string,
  connectionId: string,
  connectionVersion: number,
  eventId: string,
  input: {
    processingToken: string;
    availableAt: string;
    completedAt: string;
    errorCode: string;
    maxAttempts: number;
  },
): Promise<SheetsWebhookEventStatus | null> {
  const row = await db.prepare(
    `UPDATE sheets_sync_webhook_events
     SET attempts = attempts + 1,
         status = CASE WHEN attempts + 1 >= ? THEN 'dead' ELSE 'pending' END,
         payload_json = CASE WHEN attempts + 1 >= ? THEN NULL ELSE payload_json END,
         actor = CASE WHEN attempts + 1 >= ? THEN 'redacted' ELSE actor END,
         actor_kind = CASE WHEN attempts + 1 >= ? THEN 'unavailable' ELSE actor_kind END,
         available_at = ?, processing_token = NULL, processing_expires_at = NULL,
         completed_at = CASE WHEN attempts + 1 >= ? THEN ? ELSE NULL END,
         last_error_code = ?
     WHERE connection_id = ? AND connection_version = ? AND event_id = ?
       AND line_account_id = ? AND status = 'pending' AND processing_token = ?
       AND EXISTS (
         SELECT 1 FROM sheets_connections c
         WHERE c.id = sheets_sync_webhook_events.connection_id
           AND c.line_account_id = sheets_sync_webhook_events.line_account_id
       )
     RETURNING status`,
  ).bind(
    input.maxAttempts,
    input.maxAttempts,
    input.maxAttempts,
    input.maxAttempts,
    input.availableAt,
    input.maxAttempts,
    input.completedAt,
    input.errorCode,
    connectionId,
    connectionVersion,
    eventId,
    lineAccountId,
    input.processingToken,
  ).first<{ status: SheetsWebhookEventStatus }>();
  return row?.status ?? null;
}

export async function claimSheetsSyncLock(
  db: D1Database,
  lineAccountId: string,
  id: string,
  token: string,
  now: string,
  expiresAt: string,
  configVersion?: number,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE sheets_connections
     SET sync_lock_token = ?, sync_lock_expires_at = ?
     WHERE id = ? AND line_account_id = ? AND is_active = 1 AND deleted_at IS NULL
       AND (? IS NULL OR config_version = ?)
       AND julianday(?) > julianday(?)
       AND (
         sync_lock_token IS NULL
         OR sync_lock_token = ?
         OR sync_lock_expires_at IS NULL
         OR julianday(sync_lock_expires_at) <= julianday(?)
       )`,
  ).bind(
    token,
    expiresAt,
    id,
    lineAccountId,
    configVersion ?? null,
    configVersion ?? null,
    expiresAt,
    now,
    token,
    now,
  ).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function releaseSheetsSyncLock(
  db: D1Database,
  lineAccountId: string,
  id: string,
  token: string,
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE sheets_connections
     SET sync_lock_token = NULL, sync_lock_expires_at = NULL
     WHERE id = ? AND line_account_id = ? AND sync_lock_token = ?
       AND is_active = 1 AND deleted_at IS NULL`,
  ).bind(id, lineAccountId, token).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function listSheetsSyncLedger(
  db: D1Database,
  lineAccountId: string,
  connectionId: string,
): Promise<SheetsSyncLedgerEntry[]> {
  const result = await db.prepare(
    `SELECT l.connection_id, l.connection_version, l.record_key, l.sheet_row_number,
            l.row_fingerprint, l.canonical_snapshot_json, l.harness_updated_at,
            l.sheet_observed_at, l.last_synced_at, l.last_sync_direction,
            l.last_applied_sequence, l.version
     FROM sheets_sync_ledger l
     JOIN sheets_connections c ON c.id = l.connection_id
     WHERE c.id = ? AND c.line_account_id = ? AND c.is_active = 1
       AND c.deleted_at IS NULL AND c.config_version = l.connection_version
     ORDER BY l.record_key ASC`,
  ).bind(connectionId, lineAccountId).all<SheetsSyncLedgerRow>();
  return result.results.map(serializeLedger);
}

/** Releases unique row slots before exact userId matches are reassigned. */
export async function clearSheetsSyncLedgerRowNumbers(
  db: D1Database,
  lineAccountId: string,
  connectionId: string,
  connectionVersion: number,
  recordKeys: string[],
  lease?: SheetsSyncLeaseGuard,
): Promise<boolean> {
  const uniqueRecordKeys = [...new Set(recordKeys)];
  if (uniqueRecordKeys.length === 0) return true;
  const result = await db.prepare(
    `UPDATE sheets_sync_ledger
     SET sheet_row_number = NULL, version = version + 1
     WHERE connection_id = ? AND connection_version = ?
       AND record_key IN (SELECT value FROM json_each(?))
       AND EXISTS (
         SELECT 1 FROM sheets_connections c
         WHERE c.id = sheets_sync_ledger.connection_id
           AND c.line_account_id = ? AND c.config_version = ?
           AND c.is_active = 1 AND c.deleted_at IS NULL
           AND (
             ? IS NULL OR (
               c.sync_lock_token = ? AND c.sync_lock_expires_at IS NOT NULL
               AND julianday(c.sync_lock_expires_at) > julianday(?)
             )
           )
       )`,
  ).bind(
    connectionId,
    connectionVersion,
    JSON.stringify(uniqueRecordKeys),
    lineAccountId,
    connectionVersion,
    lease?.token ?? null,
    lease?.token ?? null,
    lease?.now ?? null,
  ).run();
  return (result.meta.changes ?? 0) === uniqueRecordKeys.length;
}

function prepareSheetsSyncLedgerUpsert(
  db: D1Database,
  lineAccountId: string,
  entry: Omit<SheetsSyncLedgerEntry, 'version'>,
  lease?: SheetsSyncLeaseGuard,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO sheets_sync_ledger
       (connection_id, connection_version, record_key, sheet_row_number,
        row_fingerprint, canonical_snapshot_json, harness_updated_at,
        sheet_observed_at, last_synced_at, last_sync_direction,
        last_applied_sequence)
     SELECT c.id, c.config_version, ?, ?, ?, ?, ?, ?, ?, ?, ?
     FROM sheets_connections c
     WHERE c.id = ? AND c.line_account_id = ? AND c.config_version = ?
       AND c.is_active = 1 AND c.deleted_at IS NULL
       AND (
         ? IS NULL OR (
           c.sync_lock_token = ? AND c.sync_lock_expires_at IS NOT NULL
           AND julianday(c.sync_lock_expires_at) > julianday(?)
         )
       )
     ON CONFLICT(connection_id, record_key) DO UPDATE SET
       connection_version = excluded.connection_version,
       sheet_row_number = excluded.sheet_row_number,
       row_fingerprint = excluded.row_fingerprint,
       canonical_snapshot_json = excluded.canonical_snapshot_json,
       harness_updated_at = excluded.harness_updated_at,
       sheet_observed_at = excluded.sheet_observed_at,
       last_synced_at = excluded.last_synced_at,
       last_sync_direction = excluded.last_sync_direction,
       last_applied_sequence = excluded.last_applied_sequence,
       version = sheets_sync_ledger.version + 1
     WHERE excluded.last_applied_sequence > sheets_sync_ledger.last_applied_sequence`,
  ).bind(
    entry.recordKey,
    entry.sheetRowNumber,
    entry.rowFingerprint,
    JSON.stringify(entry.canonicalSnapshot),
    entry.harnessUpdatedAt,
    entry.sheetObservedAt,
    entry.lastSyncedAt,
    entry.lastSyncDirection,
    entry.lastAppliedSequence,
    entry.connectionId,
    lineAccountId,
    entry.connectionVersion,
    lease?.token ?? null,
    lease?.token ?? null,
    lease?.now ?? null,
  );
}

export async function upsertSheetsSyncLedger(
  db: D1Database,
  lineAccountId: string,
  entry: Omit<SheetsSyncLedgerEntry, 'version'>,
  lease?: SheetsSyncLeaseGuard,
): Promise<boolean> {
  const result = await prepareSheetsSyncLedgerUpsert(db, lineAccountId, entry, lease).run();
  return (result.meta.changes ?? 0) === 1;
}

function prepareSheetsSyncAuditInserts(
  db: D1Database,
  lineAccountId: string,
  entry: AppendSheetsSyncAuditInput,
  lease?: SheetsSyncLeaseGuard,
  requiredLedger?: Omit<SheetsSyncLedgerEntry, 'version'>,
): D1PreparedStatement[] {
  const parent = db.prepare(
    `INSERT INTO sheets_sync_audit_log
       (id, connection_id, connection_version, apply_sequence, line_account_id,
        form_id, spreadsheet_id, sheet_name, record_key, sheet_row_number,
        direction, action, outcome, conflict_resolution, harness_updated_at,
        sheet_observed_at, before_fingerprint, after_fingerprint, error_code,
        webhook_event_id)
     SELECT ?, c.id, c.config_version, ?, c.line_account_id, c.form_id,
            c.spreadsheet_id, c.sheet_name, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     FROM sheets_connections c
     WHERE c.id = ? AND c.line_account_id = ? AND c.config_version = ?
       AND c.is_active = 1 AND c.deleted_at IS NULL
       AND (
         ? IS NULL OR (
           c.sync_lock_token = ? AND c.sync_lock_expires_at IS NOT NULL
           AND julianday(c.sync_lock_expires_at) > julianday(?)
         )
       )
       AND (
         ? IS NULL OR EXISTS (
           SELECT 1 FROM sheets_sync_ledger l
           WHERE l.connection_id = c.id AND l.connection_version = c.config_version
             AND l.record_key = ? AND l.last_applied_sequence = ?
             AND l.row_fingerprint = ?
         )
       )`,
  ).bind(
    entry.id,
    entry.applySequence,
    entry.recordKey,
    entry.sheetRowNumber,
    entry.direction,
    entry.action,
    entry.outcome,
    entry.conflictResolution,
    entry.harnessUpdatedAt,
    entry.sheetObservedAt,
    entry.beforeFingerprint,
    entry.afterFingerprint,
    entry.errorCode,
    entry.webhookEventId ?? null,
    entry.connectionId,
    lineAccountId,
    entry.connectionVersion,
    lease?.token ?? null,
    lease?.token ?? null,
    lease?.now ?? null,
    requiredLedger?.recordKey ?? null,
    requiredLedger?.recordKey ?? null,
    requiredLedger?.lastAppliedSequence ?? null,
    requiredLedger?.rowFingerprint ?? null,
  );
  const details = entry.details.map((detail) => db.prepare(
    `INSERT INTO sheets_sync_audit_details
       (id, audit_id, actor, column_name, old_value, new_value, source, change_kind)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM sheets_sync_audit_log
       WHERE id = ? AND connection_id = ? AND line_account_id = ?
     )`,
  ).bind(
    detail.id,
    entry.id,
    detail.actor,
    detail.fieldName,
    detail.oldValue,
    detail.newValue,
    detail.source,
    detail.changeKind,
    entry.id,
    entry.connectionId,
    lineAccountId,
  ));
  return [parent, ...details];
}

export async function appendSheetsSyncAudit(
  db: D1Database,
  lineAccountId: string,
  entry: AppendSheetsSyncAuditInput,
  lease?: SheetsSyncLeaseGuard,
): Promise<boolean> {
  const [result] = await db.batch(prepareSheetsSyncAuditInserts(db, lineAccountId, entry, lease));
  return (result.meta.changes ?? 0) === 1;
}

/**
 * Publishes one row's immutable audit event and mutable ledger baseline in the
 * same D1 batch. D1 batches are transactional, so a constraint or lease failure
 * cannot leave an audit saying "applied" without the matching baseline.
 */
export async function commitSheetsSyncRow(
  db: D1Database,
  lineAccountId: string,
  input: {
    audit: AppendSheetsSyncAuditInput;
    ledger: Omit<SheetsSyncLedgerEntry, 'version'>;
  },
  lease?: SheetsSyncLeaseGuard,
): Promise<boolean> {
  const { audit, ledger } = input;
  if (
    audit.connectionId !== ledger.connectionId
    || audit.connectionVersion !== ledger.connectionVersion
    || audit.applySequence !== ledger.lastAppliedSequence
    || audit.recordKey !== ledger.recordKey
    || audit.sheetRowNumber !== ledger.sheetRowNumber
    || audit.afterFingerprint !== ledger.rowFingerprint
  ) {
    throw new Error('sheets_sync_row_commit_mismatch');
  }
  const ledgerStatement = prepareSheetsSyncLedgerUpsert(db, lineAccountId, ledger, lease);
  const auditStatements = prepareSheetsSyncAuditInserts(db, lineAccountId, audit, lease, ledger);
  const results = await db.batch([
    ledgerStatement,
    ...auditStatements,
  ]);
  const ledgerResult = results[0];
  const parent = results[1];
  return (parent.meta.changes ?? 0) === 1 && (ledgerResult.meta.changes ?? 0) === 1;
}

export async function listSheetsSyncAudit(
  db: D1Database,
  lineAccountId: string,
  connectionId: string,
  options: { limit?: number } = {},
): Promise<SheetsSyncAuditEntry[]> {
  const auditResult = await db.prepare(
    `SELECT id, connection_id, connection_version, apply_sequence, line_account_id,
            form_id, spreadsheet_id, sheet_name, record_key, sheet_row_number,
            direction, action, outcome, conflict_resolution, harness_updated_at,
            sheet_observed_at, before_fingerprint, after_fingerprint, error_code,
            webhook_event_id, created_at
     FROM sheets_sync_audit_log
     WHERE connection_id = ? AND line_account_id = ?
     ORDER BY apply_sequence DESC, created_at DESC, id DESC
     LIMIT ?`,
  ).bind(connectionId, lineAccountId, boundedLimit(options.limit ?? 100)).all<SheetsSyncAuditRow>();
  if (auditResult.results.length === 0) return [];

  const auditIds = auditResult.results.map((row) => row.id);
  const placeholders = auditIds.map(() => '?').join(', ');
  const detailResult = await db.prepare(
    `SELECT id, audit_id, actor, column_name, old_value, new_value, source,
            change_kind, created_at
     FROM sheets_sync_audit_details
     WHERE audit_id IN (${placeholders})
     ORDER BY created_at ASC, id ASC`,
  ).bind(...auditIds).all<SheetsSyncAuditDetailRow>();
  const detailsByAudit = new Map<string, SheetsSyncAuditDetail[]>();
  for (const row of detailResult.results) {
    const details = detailsByAudit.get(row.audit_id) ?? [];
    details.push(serializeAuditDetail(row));
    detailsByAudit.set(row.audit_id, details);
  }
  return auditResult.results.map((row) => serializeAudit(row, detailsByAudit.get(row.id) ?? []));
}

export async function hasSheetsSyncAuditForWebhookEvent(
  db: D1Database,
  lineAccountId: string,
  connectionId: string,
  connectionVersion: number,
  webhookEventId: string,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT 1 AS present
     FROM sheets_sync_audit_log
     WHERE line_account_id = ? AND connection_id = ? AND connection_version = ?
       AND webhook_event_id = ?
     LIMIT 1`,
  ).bind(lineAccountId, connectionId, connectionVersion, webhookEventId)
    .first<{ present: number }>();
  return row?.present === 1;
}
