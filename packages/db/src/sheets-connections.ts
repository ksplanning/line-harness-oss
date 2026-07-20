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
         friend_field_mappings_json, friend_ledger_enabled, last_sync_at, last_sync_status,
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
  const update = db.prepare(
    `UPDATE sheets_connections
     SET spreadsheet_id = ?, sheet_name = ?, sync_direction = ?,
         friend_field_mappings_json = COALESCE(?, friend_field_mappings_json),
         friend_ledger_enabled = COALESCE(?, friend_ledger_enabled),
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
    input.friendFieldMappings === undefined ? null : JSON.stringify(input.friendFieldMappings),
    input.friendLedgerEnabled === undefined ? null : input.friendLedgerEnabled ? 1 : 0,
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
): Promise<number | null> {
  const row = await db.prepare(
    `UPDATE sheets_connections
     SET next_sync_sequence = next_sync_sequence + 1
     WHERE id = ? AND line_account_id = ? AND config_version = ?
       AND is_active = 1 AND deleted_at IS NULL
     RETURNING next_sync_sequence - 1 AS sequence`,
  ).bind(id, lineAccountId, configVersion).first<{ sequence: number }>();
  return row?.sequence ?? null;
}

export async function updateSheetsSyncStatus(
  db: D1Database,
  lineAccountId: string,
  id: string,
  input: UpdateSheetsSyncStatusInput,
): Promise<SheetsConnection | null> {
  const result = await db.prepare(
    `UPDATE sheets_connections
     SET last_sync_at = ?, last_sync_status = ?, last_sync_warning = ?,
         last_sync_error_code = ?
     WHERE id = ? AND line_account_id = ? AND is_active = 1 AND deleted_at IS NULL`,
  ).bind(
    input.lastSyncAt,
    input.status,
    input.warning,
    input.errorCode,
    id,
    lineAccountId,
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
    `${ACTIVE_SELECT} AND friend_ledger_enabled = 1 ORDER BY updated_at ASC, id ASC LIMIT ?`,
  ).bind(boundedLimit(limit)).all<SheetsConnectionRow>();
  return result.results.map(serialize);
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

export async function upsertSheetsSyncLedger(
  db: D1Database,
  lineAccountId: string,
  entry: Omit<SheetsSyncLedgerEntry, 'version'>,
): Promise<boolean> {
  const result = await db.prepare(
    `INSERT INTO sheets_sync_ledger
       (connection_id, connection_version, record_key, sheet_row_number,
        row_fingerprint, canonical_snapshot_json, harness_updated_at,
        sheet_observed_at, last_synced_at, last_sync_direction,
        last_applied_sequence)
     SELECT c.id, c.config_version, ?, ?, ?, ?, ?, ?, ?, ?, ?
     FROM sheets_connections c
     WHERE c.id = ? AND c.line_account_id = ? AND c.config_version = ?
       AND c.is_active = 1 AND c.deleted_at IS NULL
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
       version = sheets_sync_ledger.version + 1`,
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
  ).run();
  return (result.meta.changes ?? 0) === 1;
}

export async function appendSheetsSyncAudit(
  db: D1Database,
  lineAccountId: string,
  entry: AppendSheetsSyncAuditInput,
): Promise<boolean> {
  const parent = db.prepare(
    `INSERT INTO sheets_sync_audit_log
       (id, connection_id, connection_version, apply_sequence, line_account_id,
        form_id, spreadsheet_id, sheet_name, record_key, sheet_row_number,
        direction, action, outcome, conflict_resolution, harness_updated_at,
        sheet_observed_at, before_fingerprint, after_fingerprint, error_code)
     SELECT ?, c.id, c.config_version, ?, c.line_account_id, c.form_id,
            c.spreadsheet_id, c.sheet_name, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     FROM sheets_connections c
     WHERE c.id = ? AND c.line_account_id = ? AND c.config_version = ?
       AND c.is_active = 1 AND c.deleted_at IS NULL`,
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
    entry.connectionId,
    lineAccountId,
    entry.connectionVersion,
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
  const [result] = await db.batch([parent, ...details]);
  return (result.meta.changes ?? 0) === 1;
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
            created_at
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
