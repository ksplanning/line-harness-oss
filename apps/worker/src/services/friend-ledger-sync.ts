import {
  appendSheetsSyncAudit,
  claimNextSheetsWebhookEvent,
  claimSheetsSyncLock,
  clearSheetsSyncLedgerRowNumbers,
  deferSheetsWebhookEvent,
  failSheetsWebhookEvent,
  finishSheetsWebhookEvent,
  hasSheetsSyncAuditForWebhookEvent,
  listActiveSheetsConnectionsForSync,
  listFriendFieldDefinitions,
  listSheetsSyncAudit,
  listSheetsSyncLedger,
  recordSheetsFriendLedgerHeaders,
  releaseSheetsSyncLock,
  reserveSheetsSyncSequence,
  toJstString,
  updateSheetsSyncStatus,
  upsertSheetsSyncLedger,
  type SheetsCanonicalCellValue,
  type SheetsConnection,
  type SheetsSyncAuditDetailInput,
  type SheetsSyncAuditSource,
  type SheetsSyncLedgerEntry,
  type SheetsSyncLeaseGuard,
} from '@line-crm/db';
import {
  buildFriendLedgerColumns,
  normalizeSheetCell,
  projectFriendLedgerRow,
  resolveFriendLedgerHeaders,
  type FriendLedgerColumn,
} from './friend-ledger-columns.js';
import {
  GoogleSheetsClient,
  parseGoogleServiceAccountCredentials,
  type SheetCellValue,
  type SheetsDataUpdate,
} from './google-sheets.js';

type FriendLedgerSheetsClient = Pick<
  GoogleSheetsClient,
  'readValues' | 'updateValues' | 'appendValues' | 'batchUpdateValues'
>;

interface FriendRow {
  id: string;
  line_user_id: string;
  display_name: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
}

interface FriendState {
  id: string;
  lineUserId: string;
  displayName: string | null;
  metadataRaw: string;
  metadata: Record<string, unknown>;
  metadataValid: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FriendLedgerEditRange {
  rowStart: number;
  rowEnd: number;
  columnStart: number;
  columnEnd: number;
}

export interface FriendLedgerWebhookSnapshot {
  rowNumber: number;
  columnNumber: number;
  value: SheetCellValue;
  oldValue: SheetCellValue;
  oldValueKnown: boolean;
}

export interface FriendLedgerWebhookEventPayload {
  range: FriendLedgerEditRange;
  snapshot: FriendLedgerWebhookSnapshot;
}

export interface SyncFriendLedgerOptions {
  db: D1Database;
  connection: SheetsConnection;
  client?: FriendLedgerSheetsClient;
  credentialsJson?: string;
  source: SheetsSyncAuditSource;
  actor: string;
  now?: () => Date;
  range?: FriendLedgerEditRange;
  snapshot?: FriendLedgerWebhookSnapshot;
  webhookEventId?: string;
}

export interface FriendLedgerSyncResult {
  status: 'success' | 'warning';
  busy: boolean;
  warning: string | null;
  warnings: string[];
  appendedRows: number;
  updatedRows: number;
  importedFields: number;
  ignoredIdentityEdits: number;
}

interface RowPlan {
  friend: FriendState;
  rowNumber: number;
  ledger: SheetsSyncLedgerEntry | null;
  canonical: Record<string, SheetsCanonicalCellValue>;
  details: SheetsSyncAuditDetailInput[];
  imports: Record<string, string>;
  customCells: Record<string, { columnKey: string; columnIndex: number; observed: string }>;
  sheetUpdates: SheetsDataUpdate[];
  direction: 'to_sheets' | 'from_sheets';
  conflictResolution: 'harness_wins' | 'sheet_wins' | null;
  isAppend: boolean;
  webhookEventId?: string | null;
  auditOutcome?: 'applied' | 'skipped' | 'failed';
  auditErrorCode?: string | null;
}

interface ImportedMetadataResult {
  friend: FriendState;
  rejected: Record<string, string>;
}

const LOCK_DURATION_MS = 2 * 60_000;
const MAX_SYNC_WARNINGS = 20;
const WEBHOOK_EVENT_CLAIM_MS = 2 * 60_000;
const WEBHOOK_EVENT_RETENTION_MS = 24 * 60 * 60_000;
const WEBHOOK_EVENT_RETRY_MS = 30_000;
const MAX_WEBHOOK_EVENT_ATTEMPTS = 5;
const MAX_WEBHOOK_EVENTS_PER_DRAIN = 20;
const MAX_GOOGLE_SHEET_ROWS = 10_000_000;
const MAX_GOOGLE_SHEET_COLUMNS = 18_278;

function parseMetadata(raw: string): { value: Record<string, unknown>; valid: boolean } {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { value: {}, valid: false };
    }
    return { value: { ...(parsed as Record<string, unknown>) }, valid: true };
  } catch {
    return { value: {}, valid: false };
  }
}

function serializeFriend(row: FriendRow): FriendState {
  const parsedMetadata = parseMetadata(row.metadata);
  return {
    id: row.id,
    lineUserId: row.line_user_id,
    displayName: row.display_name,
    metadataRaw: row.metadata,
    metadata: parsedMetadata.value,
    metadataValid: parsedMetadata.valid,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function quoteSheetName(sheetName: string): string {
  return `'${sheetName.replace(/'/g, "''")}'`;
}

function columnLabel(index: number): string {
  let value = index + 1;
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function cellRange(sheetName: string, rowNumber: number, columnIndex: number): string {
  const cell = `${columnLabel(columnIndex)}${rowNumber}`;
  return `${quoteSheetName(sheetName)}!${cell}:${cell}`;
}

function blockRange(sheetName: string, rowNumber: number, width: number): string {
  return `${quoteSheetName(sheetName)}!A${rowNumber}:${columnLabel(Math.max(0, width - 1))}${rowNumber}`;
}

function horizontalRange(
  sheetName: string,
  rowNumber: number,
  startColumnIndex: number,
  width: number,
): string {
  const start = columnLabel(startColumnIndex);
  const end = columnLabel(startColumnIndex + Math.max(0, width - 1));
  return `${quoteSheetName(sheetName)}!${start}${rowNumber}:${end}${rowNumber}`;
}

function appendedStartRow(response: { updates?: Record<string, unknown> }, fallback: number): number {
  const updatedRange = response.updates?.updatedRange;
  if (typeof updatedRange !== 'string') return fallback;
  const match = /![A-Z]+(\d+)(?::|$)/i.exec(updatedRange.replace(/\$/g, ''));
  const row = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(row) && row >= 2 ? row : fallback;
}

function cleanActor(actor: string, source: SheetsSyncAuditSource): string {
  const cleaned = actor.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 320);
  return cleaned || (source === 'polling' ? 'system_poll' : 'unknown_editor');
}

function canonicalValue(value: unknown): SheetsCanonicalCellValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  return normalizeSheetCell(value);
}

function isSheetCellValue(value: unknown): value is SheetCellValue {
  return value === null
    || typeof value === 'string'
    || typeof value === 'number'
    || typeof value === 'boolean';
}

function isPositiveCellIndex(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

export function parseFriendLedgerWebhookEventPayload(
  value: unknown,
): FriendLedgerWebhookEventPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  if (!object.range || typeof object.range !== 'object' || Array.isArray(object.range)) return null;
  if (!object.snapshot || typeof object.snapshot !== 'object' || Array.isArray(object.snapshot)) return null;
  const range = object.range as Record<string, unknown>;
  const snapshot = object.snapshot as Record<string, unknown>;
  if (
    !isPositiveCellIndex(range.rowStart)
    || !isPositiveCellIndex(range.rowEnd)
    || !isPositiveCellIndex(range.columnStart)
    || !isPositiveCellIndex(range.columnEnd)
    || Number(range.rowEnd) > MAX_GOOGLE_SHEET_ROWS
    || Number(range.columnEnd) > MAX_GOOGLE_SHEET_COLUMNS
    || range.rowStart !== range.rowEnd
    || range.columnStart !== range.columnEnd
    || !isPositiveCellIndex(snapshot.rowNumber)
    || !isPositiveCellIndex(snapshot.columnNumber)
    || snapshot.rowNumber !== range.rowStart
    || snapshot.columnNumber !== range.columnStart
    || !isSheetCellValue(snapshot.value)
    || !isSheetCellValue(snapshot.oldValue)
    || typeof snapshot.oldValueKnown !== 'boolean'
    || (typeof snapshot.value === 'string' && snapshot.value.length > 50_000)
    || (typeof snapshot.oldValue === 'string' && snapshot.oldValue.length > 50_000)
  ) return null;
  return {
    range: {
      rowStart: range.rowStart,
      rowEnd: range.rowEnd,
      columnStart: range.columnStart,
      columnEnd: range.columnEnd,
    },
    snapshot: {
      rowNumber: snapshot.rowNumber,
      columnNumber: snapshot.columnNumber,
      value: snapshot.value,
      oldValue: snapshot.oldValue,
      oldValueKnown: snapshot.oldValueKnown,
    },
  };
}

async function fingerprint(snapshot: Record<string, SheetsCanonicalCellValue>): Promise<string> {
  const keys = Object.keys(snapshot).sort();
  const stable = JSON.stringify(keys.map((key) => [key, snapshot[key]]));
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function listFriends(db: D1Database, lineAccountId: string): Promise<FriendState[]> {
  const result = await db.prepare(
    `SELECT id, line_user_id, display_name, metadata, created_at, updated_at
     FROM friends
     WHERE line_account_id = ?
     ORDER BY created_at ASC, id ASC`,
  ).bind(lineAccountId).all<FriendRow>();
  return result.results.map(serializeFriend);
}

async function saveImportedMetadata(
  db: D1Database,
  connection: SheetsConnection,
  friend: FriendState,
  imports: Record<string, string>,
  nextUpdatedAt: () => string,
  renewLease: () => Promise<SheetsSyncLeaseGuard>,
): Promise<ImportedMetadataResult> {
  if (Object.keys(imports).length === 0) return { friend, rejected: {} };
  const originalValues = Object.fromEntries(
    Object.keys(imports).map((header) => [header, normalizeSheetCell(friend.metadata[header])]),
  );
  const pending = { ...imports };
  const rejected: Record<string, string> = {};
  let current = friend;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lease = await renewLease();
    const candidateUpdatedAt = nextUpdatedAt();
    const updatedAt = candidateUpdatedAt > current.updatedAt
      ? candidateUpdatedAt
      : current.updatedAt;
    const merged = { ...current.metadata, ...pending };
    const nextRaw = JSON.stringify(merged);
    const result = await db.prepare(
      `UPDATE friends
       SET metadata = ?, updated_at = ?
       WHERE id = ? AND line_account_id = ? AND metadata IS ?
         AND EXISTS (
           SELECT 1 FROM sheets_connections c
           WHERE c.id = ? AND c.line_account_id = ? AND c.config_version = ?
             AND c.sync_lock_token = ? AND c.sync_lock_expires_at IS NOT NULL
             AND julianday(c.sync_lock_expires_at) > julianday(?)
             AND c.is_active = 1 AND c.deleted_at IS NULL
         )`,
    ).bind(
      nextRaw,
      updatedAt,
      current.id,
      connection.lineAccountId,
      current.metadataRaw,
      connection.id,
      connection.lineAccountId,
      connection.configVersion,
      lease.token,
      lease.now,
    ).run();
    if ((result.meta.changes ?? 0) === 1) {
      return {
        friend: { ...current, metadataRaw: nextRaw, metadata: merged, updatedAt },
        rejected,
      };
    }
    await renewLease();
    const latest = await db.prepare(
      `SELECT id, line_user_id, display_name, metadata, created_at, updated_at
       FROM friends WHERE id = ? AND line_account_id = ?`,
    ).bind(current.id, connection.lineAccountId).first<FriendRow>();
    if (!latest) throw new Error('friend_missing_during_sync');
    current = serializeFriend(latest);
    for (const header of Object.keys(pending)) {
      const latestValue = normalizeSheetCell(current.metadata[header]);
      if (latestValue !== originalValues[header]) {
        rejected[header] = latestValue;
        delete pending[header];
      }
    }
    if (Object.keys(pending).length === 0) return { friend: current, rejected };
  }
  throw new Error('friend_metadata_concurrent_update');
}

function warningText(code: string, header: string): string {
  if (code === 'duplicate_header') return `見出し「${header}」が重複しています`;
  if (code === 'configured_header_collision') return `設定した見出し「${header}」が保護列と重複しています`;
  return `見出し「${header}」が見つかりません`;
}

function projectedWithDefaults(
  friend: FriendState,
  connection: SheetsConnection,
  defaults: Map<string, string>,
): Record<string, string> {
  const metadata = { ...friend.metadata };
  for (const mapping of connection.friendFieldMappings) {
    if (metadata[mapping.header] === undefined && defaults.has(mapping.fieldId)) {
      metadata[mapping.header] = defaults.get(mapping.fieldId);
    }
  }
  return projectFriendLedgerRow({
    id: friend.id,
    lineUserId: friend.lineUserId,
    displayName: friend.displayName,
    registeredAt: friend.createdAt,
    metadata,
  }, connection.friendFieldMappings);
}

function rowForProjection(
  width: number,
  projection: Record<string, string>,
  columns: FriendLedgerColumn[],
  indexByKey: Record<string, number>,
): SheetCellValue[] {
  const row: SheetCellValue[] = Array.from({ length: width }, () => '');
  for (const column of columns) {
    const index = indexByKey[column.key];
    if (index !== undefined) row[index] = projection[column.key] ?? '';
  }
  return row;
}

function detail(
  actor: string,
  fieldName: string,
  oldValue: string | null,
  newValue: string | null,
  source: SheetsSyncAuditSource,
  changeKind: SheetsSyncAuditDetailInput['changeKind'],
): SheetsSyncAuditDetailInput {
  return {
    id: `gsad_${crypto.randomUUID()}`,
    actor,
    fieldName,
    oldValue,
    newValue,
    source,
    changeKind,
  };
}

async function persistPlan(
  db: D1Database,
  connection: SheetsConnection,
  plan: RowPlan,
  now: string,
  renewLease: () => Promise<SheetsSyncLeaseGuard>,
): Promise<void> {
  const nextFingerprint = await fingerprint(plan.canonical);
  const changed = plan.isAppend
    || plan.details.length > 0
    || plan.ledger?.rowFingerprint !== nextFingerprint
    || plan.ledger?.sheetRowNumber !== plan.rowNumber;
  const needsBaseline = !plan.ledger;
  if (!changed && !needsBaseline) return;
  const lease = await renewLease();
  const sequence = await reserveSheetsSyncSequence(
    db,
    connection.lineAccountId,
    connection.id,
    connection.configVersion,
    lease,
  );
  if (sequence === null) throw new Error('stale_sheets_connection_generation');
  const auditWritten = await appendSheetsSyncAudit(db, connection.lineAccountId, {
    id: `gsa_${crypto.randomUUID()}`,
    connectionId: connection.id,
    connectionVersion: connection.configVersion,
    applySequence: sequence,
    recordKey: plan.friend.id,
    sheetRowNumber: plan.rowNumber,
    direction: plan.direction,
    action: plan.isAppend ? 'append' : plan.conflictResolution ? 'conflict' : changed ? 'update' : 'read',
    outcome: plan.auditOutcome ?? (changed || plan.isAppend ? 'applied' : 'skipped'),
    conflictResolution: plan.conflictResolution,
    harnessUpdatedAt: plan.friend.updatedAt,
    sheetObservedAt: now,
    beforeFingerprint: plan.ledger?.rowFingerprint ?? null,
    afterFingerprint: nextFingerprint,
    errorCode: plan.auditErrorCode ?? (plan.details.some((entry) => entry.changeKind === 'identity_ignored')
      ? 'identity_read_only'
      : null),
    webhookEventId: plan.webhookEventId ?? null,
    details: plan.details,
  }, lease);
  if (!auditWritten) throw new Error('stale_sheets_audit_generation');
  const ledgerWritten = await upsertSheetsSyncLedger(db, connection.lineAccountId, {
    connectionId: connection.id,
    connectionVersion: connection.configVersion,
    recordKey: plan.friend.id,
    sheetRowNumber: plan.rowNumber,
    rowFingerprint: nextFingerprint,
    canonicalSnapshot: plan.canonical,
    harnessUpdatedAt: plan.friend.updatedAt,
    sheetObservedAt: now,
    lastSyncedAt: now,
    lastSyncDirection: plan.direction,
    lastAppliedSequence: sequence,
  }, lease);
  if (!ledgerWritten) throw new Error('stale_sheets_ledger_generation');
}

function makeClient(options: SyncFriendLedgerOptions): FriendLedgerSheetsClient {
  if (options.client) return options.client;
  if (!options.credentialsJson) throw new Error('google_sheets_credentials_missing');
  return new GoogleSheetsClient({
    credentials: parseGoogleServiceAccountCredentials(options.credentialsJson),
  });
}

export async function syncFriendLedger(
  options: SyncFriendLedgerOptions,
): Promise<FriendLedgerSyncResult> {
  if (!options.connection.friendLedgerEnabled) {
    const warnings = ['友だち台帳の同期設定が有効ではありません'];
    return {
      status: 'warning', busy: false, warning: warnings[0], warnings,
      appendedRows: 0, updatedRows: 0, importedFields: 0, ignoredIdentityEdits: 0,
    };
  }
  const nowFactory = options.now ?? (() => new Date());
  const started = nowFactory();
  const startedAt = toJstString(started);
  const lockToken = `gsl_${crypto.randomUUID()}`;
  const lockExpiresAt = toJstString(new Date(started.getTime() + LOCK_DURATION_MS));
  const actor = cleanActor(options.actor, options.source);
  const acquired = await claimSheetsSyncLock(
    options.db,
    options.connection.lineAccountId,
    options.connection.id,
    lockToken,
    startedAt,
    lockExpiresAt,
    options.connection.configVersion,
  );
  if (!acquired) {
    const warnings = ['別の同期処理が実行中です'];
    return {
      status: 'warning', busy: true, warning: warnings[0], warnings,
      appendedRows: 0, updatedRows: 0, importedFields: 0, ignoredIdentityEdits: 0,
    };
  }

  const renewLease = async (): Promise<SheetsSyncLeaseGuard> => {
    const leaseTime = nowFactory();
    const leaseNow = toJstString(leaseTime);
    const renewed = await claimSheetsSyncLock(
      options.db,
      options.connection.lineAccountId,
      options.connection.id,
      lockToken,
      leaseNow,
      toJstString(new Date(leaseTime.getTime() + LOCK_DURATION_MS)),
      options.connection.configVersion,
    );
    if (!renewed) throw new Error('friend_ledger_sync_lock_lost');
    return { token: lockToken, now: leaseNow };
  };

  let failure: unknown;
  try {
    const runningStatus = await updateSheetsSyncStatus(
      options.db,
      options.connection.lineAccountId,
      options.connection.id,
      {
      status: 'running',
      lastSyncAt: options.connection.lastSyncAt,
      warning: null,
      errorCode: null,
      },
      { token: lockToken, now: startedAt },
    );
    if (!runningStatus) throw new Error('friend_ledger_sync_lock_lost');
    const client = makeClient(options);
    const [allFriends, ledgerEntries, definitions, response] = await Promise.all([
      listFriends(options.db, options.connection.lineAccountId),
      listSheetsSyncLedger(options.db, options.connection.lineAccountId, options.connection.id),
      listFriendFieldDefinitions(options.db),
      client.readValues(
        options.connection.spreadsheetId,
        quoteSheetName(options.connection.sheetName),
      ),
    ]);
    await renewLease();
    const defaults = new Map(definitions.map((definition) => [definition.id, definition.defaultValue]));
    const columns = buildFriendLedgerColumns(options.connection.friendFieldMappings);
    const knownHeaders = new Set(options.connection.friendLedgerHeaders);
    const headersToRecord = [...new Set([
      ...options.connection.friendLedgerHeaders,
      ...columns.map((column) => column.header),
    ])];
    const hasUnrecordedHeaders = columns.some((column) => !knownHeaders.has(column.header));
    const ledgerByFriend = new Map(ledgerEntries.map((entry) => [entry.recordKey, entry]));
    const values = (response.values ?? []).map((row) => [...row]);
    let liveSnapshotValue: string | null = null;
    if (options.source === 'webhook' && options.snapshot) {
      const rowIndex = options.snapshot.rowNumber - 1;
      const columnIndex = options.snapshot.columnNumber - 1;
      liveSnapshotValue = normalizeSheetCell(values[rowIndex]?.[columnIndex]);
    }
    const effectiveRow = (rowNumber: number): SheetCellValue[] => {
      const row = [...(values[rowNumber - 1] ?? [])];
      if (options.source === 'webhook' && options.snapshot?.rowNumber === rowNumber) {
        row[options.snapshot.columnNumber - 1] = options.snapshot.value;
      }
      return row;
    };
    const warnings: string[] = [];
    const warningSet = new Set<string>();
    const addWarning = (message: string): void => {
      if (warningSet.has(message)) return;
      warningSet.add(message);
      if (warnings.length < MAX_SYNC_WARNINGS) warnings.push(message);
    };
    const friends = allFriends.filter((friend) => friend.metadataValid);
    if (friends.length !== allFriends.length) {
      addWarning('保存済みの friend metadata が壊れている友だちをスキップしました');
    }
    const plans: RowPlan[] = [];
    let appendedRows = 0;
    let importedFields = 0;
    let ignoredIdentityEdits = 0;
    const isNotifiedCell = (rowNumber: number, columnIndex: number): boolean => {
      if (options.source !== 'webhook' || !options.range) return true;
      return rowNumber >= options.range.rowStart
        && rowNumber <= options.range.rowEnd
        && columnIndex + 1 >= options.range.columnStart
        && columnIndex + 1 <= options.range.columnEnd;
    };
    const snapshotForCell = (
      rowNumber: number,
      columnIndex: number,
    ): { value: string; oldValue: string; oldValueKnown: boolean; liveValue: string } | null => {
      if (
        options.source !== 'webhook'
        || !options.snapshot
        || options.snapshot.rowNumber !== rowNumber
        || options.snapshot.columnNumber !== columnIndex + 1
      ) return null;
      return {
        value: normalizeSheetCell(options.snapshot.value),
        oldValue: normalizeSheetCell(options.snapshot.oldValue),
        oldValueKnown: options.snapshot.oldValueKnown,
        liveValue: liveSnapshotValue ?? '',
      };
    };

    const headerIsEmpty = values.length === 0 || !effectiveRow(1).some((cell) => normalizeSheetCell(cell));
    if (headerIsEmpty) {
      const headers = columns.map((column) => column.header);
      await renewLease();
      await client.updateValues(
        options.connection.spreadsheetId,
        blockRange(options.connection.sheetName, 1, headers.length),
        [headers],
      );
      if (hasUnrecordedHeaders) {
        const lease = await renewLease();
        const recorded = await recordSheetsFriendLedgerHeaders(
          options.db,
          options.connection.lineAccountId,
          options.connection.id,
          options.connection.configVersion,
          headersToRecord,
          lease,
        );
        if (!recorded) throw new Error('friend_ledger_sync_lock_lost');
      }
      if (friends.length > 0) {
        const rows = friends.map((friend) => {
          const projection = projectedWithDefaults(friend, options.connection, defaults);
          return columns.map((column) => projection[column.key] ?? '');
        });
        await renewLease();
        const appended = await client.appendValues(
          options.connection.spreadsheetId,
          `${quoteSheetName(options.connection.sheetName)}!A:${columnLabel(Math.max(0, headers.length - 1))}`,
          rows,
        );
        appendedRows = friends.length;
        const firstAppendedRow = appendedStartRow(appended, 2);
        for (let index = 0; index < friends.length; index += 1) {
          const friend = friends[index];
          const projection = projectedWithDefaults(friend, options.connection, defaults);
          const canonical = Object.fromEntries(
            columns.map((column) => [column.key, canonicalValue(projection[column.key] ?? '')]),
          );
          plans.push({
            friend,
            rowNumber: firstAppendedRow + index,
            ledger: null,
            canonical,
            imports: {},
            customCells: {},
            sheetUpdates: [],
            direction: 'to_sheets',
            conflictResolution: null,
            isAppend: true,
            details: columns
              .filter((column) => column.kind === 'custom')
              .map((column) => detail(actor, column.header, null, projection[column.key] ?? '', options.source, 'custom_field')),
          });
        }
      }
    } else {
      let headers = effectiveRow(1);
      let resolved = resolveFriendLedgerHeaders(headers, columns);
      if (hasUnrecordedHeaders) {
        const configuredCounts = new Map<string, number>();
        for (const column of columns) {
          configuredCounts.set(column.header, (configuredCounts.get(column.header) ?? 0) + 1);
        }
        const present = new Set(headers.map(normalizeSheetCell));
        const additions = columns
          .filter((column) => (
            !knownHeaders.has(column.header)
            && (configuredCounts.get(column.header) ?? 0) === 1
            && !present.has(column.header)
          ))
          .map((column) => column.header);
        if (additions.length > 0) {
          await renewLease();
          await client.updateValues(
            options.connection.spreadsheetId,
            horizontalRange(options.connection.sheetName, 1, headers.length, additions.length),
            [additions],
          );
          headers = [...headers, ...additions];
          values[0] = headers;
          resolved = resolveFriendLedgerHeaders(headers, columns);
        }
      }
      if (hasUnrecordedHeaders) {
        const lease = await renewLease();
        const recorded = await recordSheetsFriendLedgerHeaders(
          options.db,
          options.connection.lineAccountId,
          options.connection.id,
          options.connection.configVersion,
          headersToRecord,
          lease,
        );
        if (!recorded) throw new Error('friend_ledger_sync_lock_lost');
      }
      for (const headerWarning of resolved.warnings) {
        addWarning(warningText(headerWarning.code, headerWarning.header));
      }
      const userIdIndex = resolved.indexByKey['identity:lineUserId'];
      const positions = new Map<string, number[]>();
      if (userIdIndex !== undefined) {
        for (let index = 1; index < values.length; index += 1) {
          const userId = normalizeSheetCell(effectiveRow(index + 1)[userIdIndex]);
          if (!userId) continue;
          const rows = positions.get(userId) ?? [];
          rows.push(index + 1);
          positions.set(userId, rows);
        }
        for (const [userId, rows] of positions) {
          if (rows.length > 1) addWarning('userId が重複している行があります');
        }
      }
      const exactRowOwner = new Map<number, string>();
      for (const friend of friends) {
        const rows = positions.get(friend.lineUserId) ?? [];
        if (rows.length === 1) exactRowOwner.set(rows[0], friend.id);
      }

      for (const friend of friends) {
        const ledger = ledgerByFriend.get(friend.id) ?? null;
        const matchingRows = positions.get(friend.lineUserId) ?? [];
        if (matchingRows.length > 1) continue;
        const rowMatchedByUserId = matchingRows.length === 1;
        let rowNumber = matchingRows.length === 1 ? matchingRows[0] : null;
        const projection = projectedWithDefaults(friend, options.connection, defaults);
        if (
          !rowNumber
          && userIdIndex !== undefined
          && ledger?.sheetRowNumber
          && (values[ledger.sheetRowNumber - 1] || options.snapshot?.rowNumber === ledger.sheetRowNumber)
          && !exactRowOwner.has(ledger.sheetRowNumber)
        ) {
          const oldRow = effectiveRow(ledger.sheetRowNumber);
          const identityChecks = [
            ['identity:displayName', resolved.indexByKey['identity:displayName']],
            ['identity:registeredAt', resolved.indexByKey['identity:registeredAt']],
          ] as const;
          const available = identityChecks.filter(([, index]) => index !== undefined);
          if (
            available.length > 0
            && available.every(([key, index]) => normalizeSheetCell(oldRow[index!]) === projection[key])
          ) rowNumber = ledger.sheetRowNumber;
        }
        if (!rowNumber) {
          const priorRow = ledger?.sheetRowNumber
            ? effectiveRow(ledger.sheetRowNumber)
            : undefined;
          const priorRowIsBlank = !priorRow?.some((cell) => normalizeSheetCell(cell) !== '');
          const priorRowOwner = ledger?.sheetRowNumber
            ? exactRowOwner.get(ledger.sheetRowNumber)
            : undefined;
          const canRestoreDeletedRow = Boolean(
            ledger
            && userIdIndex !== undefined
            && (priorRowIsBlank || (priorRowOwner && priorRowOwner !== friend.id)),
          );
          if (userIdIndex === undefined || (ledger && !canRestoreDeletedRow)) {
            addWarning('userId から安全に行を特定できない友だちをスキップしました');
            continue;
          }
          const nextRow = rowForProjection(headers.length, projection, columns, resolved.indexByKey);
          await renewLease();
          const appended = await client.appendValues(
            options.connection.spreadsheetId,
            `${quoteSheetName(options.connection.sheetName)}!A:${columnLabel(Math.max(0, headers.length - 1))}`,
            [nextRow],
          );
          rowNumber = appendedStartRow(appended, values.length + appendedRows + 1);
          appendedRows += 1;
          const canonical = Object.fromEntries(
            columns.map((column) => [column.key, canonicalValue(projection[column.key] ?? '')]),
          );
          const restoredDeletedRow = Boolean(ledger && canRestoreDeletedRow);
          if (restoredDeletedRow) {
            addWarning('保護列を含む友だち行の削除を検知し、元に戻しました');
            ignoredIdentityEdits += columns.filter((column) => column.kind === 'identity').length;
          }
          plans.push({
            friend, rowNumber, ledger, canonical, imports: {}, customCells: {}, sheetUpdates: [],
            direction: 'to_sheets', conflictResolution: restoredDeletedRow ? 'harness_wins' : null, isAppend: true,
            details: columns
              .filter((column) => restoredDeletedRow || column.kind === 'custom')
              .map((column) => detail(
              actor,
              column.header,
              restoredDeletedRow ? projection[column.key] ?? '' : null,
              restoredDeletedRow ? '' : projection[column.key] ?? '',
              options.source,
              restoredDeletedRow
                ? column.kind === 'identity' ? 'identity_ignored' : 'conflict'
                : 'custom_field',
            )),
          });
          continue;
        }

        const sheetRow = effectiveRow(rowNumber);
        const details: SheetsSyncAuditDetailInput[] = [];
        const imports: Record<string, string> = {};
        const customCells: RowPlan['customCells'] = {};
        const sheetUpdates: SheetsDataUpdate[] = [];
        const canonical: Record<string, SheetsCanonicalCellValue> = {};
        let direction: RowPlan['direction'] = 'to_sheets';
        let conflictResolution: RowPlan['conflictResolution'] = null;
        let webhookEventId: string | null = null;
        let auditOutcome: RowPlan['auditOutcome'];
        let auditErrorCode: string | null | undefined;

        for (const column of columns) {
          const expected = projection[column.key] ?? '';
          const columnIndex = resolved.indexByKey[column.key];
          if (columnIndex === undefined) {
            canonical[column.key] = ledger?.canonicalSnapshot[column.key] ?? canonicalValue(expected);
            continue;
          }
          const observed = normalizeSheetCell(sheetRow[columnIndex]);
          const signedSnapshot = snapshotForCell(rowNumber, columnIndex);
          if (signedSnapshot && options.webhookEventId) webhookEventId = options.webhookEventId;
          if (column.kind === 'identity') {
            canonical[column.key] = canonicalValue(expected);
            if (observed !== expected) {
              if (!isNotifiedCell(rowNumber, columnIndex)) {
                canonical[column.key] = ledger?.canonicalSnapshot[column.key] ?? canonicalValue(expected);
                continue;
              }
              const baseline = ledger
                ? normalizeSheetCell(ledger.canonicalSnapshot[column.key])
                : observed;
              const harnessChanged = expected !== baseline;
              const sheetChanged = ledger ? observed !== baseline : false;
              sheetUpdates.push({
                range: cellRange(options.connection.sheetName, rowNumber, columnIndex),
                values: [[expected]],
              });
              if (!ledger || (harnessChanged && !sheetChanged)) {
                details.push(detail(actor, column.header, observed, expected, options.source, 'identity_sync'));
              } else {
                ignoredIdentityEdits += 1;
                const message = `保護列「${column.header}」の変更を取り込みませんでした`;
                addWarning(message);
                details.push(detail(
                  actor,
                  column.header,
                  signedSnapshot?.oldValueKnown ? signedSnapshot.oldValue : expected,
                  observed,
                  options.source,
                  'identity_ignored',
                ));
              }
            }
            continue;
          }

          customCells[column.header] = { columnKey: column.key, columnIndex, observed };

          const baseline = ledger
            ? normalizeSheetCell(ledger.canonicalSnapshot[column.key])
            : expected;
          if (!isNotifiedCell(rowNumber, columnIndex)) {
            canonical[column.key] = ledger?.canonicalSnapshot[column.key] ?? canonicalValue(expected);
            continue;
          }

          if (
            signedSnapshot?.oldValueKnown
            && ledger
            && signedSnapshot.oldValue !== baseline
            && signedSnapshot.liveValue !== signedSnapshot.value
          ) {
            canonical[column.key] = ledger.canonicalSnapshot[column.key] ?? canonicalValue(expected);
            direction = 'from_sheets';
            conflictResolution = 'sheet_wins';
            auditOutcome = 'skipped';
            auditErrorCode = 'stale_webhook_event';
            addWarning(`保護のため、古い編集通知（「${column.header}」）をスキップしました`);
            details.push(detail(
              actor,
              column.header,
              signedSnapshot.oldValue,
              signedSnapshot.value,
              options.source,
              'conflict',
            ));
            continue;
          }

          if (!rowMatchedByUserId) {
            canonical[column.key] = canonicalValue(expected);
            if (observed !== expected) {
              sheetUpdates.push({
                range: cellRange(options.connection.sheetName, rowNumber, columnIndex),
                values: [[expected]],
              });
              details.push(detail(actor, column.header, observed, expected, options.source, 'conflict'));
              direction = 'to_sheets';
              conflictResolution = 'harness_wins';
            }
            continue;
          }

          if (expected === observed) {
            canonical[column.key] = canonicalValue(expected);
            if (
              signedSnapshot?.oldValueKnown
              && signedSnapshot.oldValue !== observed
            ) {
              direction = 'from_sheets';
              details.push(detail(
                actor,
                column.header,
                signedSnapshot.oldValue,
                observed,
                options.source,
                'custom_field',
              ));
            }
            continue;
          }
          const harnessChanged = expected !== baseline;
          const sheetChanged = observed !== baseline;
          const bothChanged = harnessChanged && sheetChanged && expected !== observed;
          let importSheet = false;
          let pushHarness = false;
          if (!ledger) {
            importSheet = options.connection.syncDirection === 'from_sheets' && observed !== expected;
            pushHarness = options.connection.syncDirection !== 'from_sheets' && observed !== expected;
          } else if (bothChanged) {
            importSheet = options.connection.syncDirection !== 'to_sheets';
            pushHarness = !importSheet;
            conflictResolution = importSheet ? 'sheet_wins' : 'harness_wins';
          } else if (sheetChanged) {
            importSheet = options.connection.syncDirection !== 'to_sheets';
            pushHarness = !importSheet && observed !== expected;
          } else if (harnessChanged) {
            pushHarness = options.connection.syncDirection !== 'from_sheets';
            importSheet = !pushHarness && observed !== expected;
          }

          if (importSheet) {
            imports[column.header] = observed;
            importedFields += 1;
            direction = 'from_sheets';
            canonical[column.key] = canonicalValue(observed);
            details.push(detail(
              actor,
              column.header,
              signedSnapshot?.oldValueKnown ? signedSnapshot.oldValue : expected,
              observed,
              options.source,
              bothChanged ? 'conflict' : 'custom_field',
            ));
          } else {
            canonical[column.key] = canonicalValue(expected);
            if (pushHarness) {
              sheetUpdates.push({
                range: cellRange(options.connection.sheetName, rowNumber, columnIndex),
                values: [[expected]],
              });
              details.push(detail(
                actor, column.header, observed, expected, options.source,
                bothChanged ? 'conflict' : 'custom_field',
              ));
            }
          }
        }
        plans.push({
          friend, rowNumber, ledger, canonical, details, imports, customCells, sheetUpdates,
          direction, conflictResolution, isAppend: false, webhookEventId, auditOutcome, auditErrorCode,
        });
      }
    }

    const allSheetUpdates = plans.flatMap((plan) => plan.sheetUpdates);
    if (allSheetUpdates.length > 0) {
      await renewLease();
      await client.batchUpdateValues(options.connection.spreadsheetId, allSheetUpdates);
    }
    const updatedRowNumbers = new Set(
      plans.filter((plan) => plan.sheetUpdates.length > 0).map((plan) => plan.rowNumber),
    );
    const completedAt = toJstString(nowFactory());
    const movedPlans = plans.filter(
      (plan) => plan.ledger && plan.ledger.sheetRowNumber !== plan.rowNumber,
    );
    if (movedPlans.length > 0) {
      const lease = await renewLease();
      const cleared = await clearSheetsSyncLedgerRowNumbers(
        options.db,
        options.connection.lineAccountId,
        options.connection.id,
        options.connection.configVersion,
        movedPlans.map((plan) => plan.friend.id),
        lease,
      );
      if (!cleared) throw new Error('friend_ledger_sync_lock_lost');
      for (const plan of movedPlans) {
        if (plan.ledger) plan.ledger = { ...plan.ledger, sheetRowNumber: null };
      }
    }
    for (const plan of plans) {
      const imported = await saveImportedMetadata(
        options.db,
        options.connection,
        plan.friend,
        plan.imports,
        () => toJstString(nowFactory()),
        renewLease,
      );
      plan.friend = imported.friend;
      const rejectedUpdates: SheetsDataUpdate[] = [];
      let rejectedConvergence = false;
      for (const [header, latestValue] of Object.entries(imported.rejected)) {
        const cell = plan.customCells[header];
        if (!cell) continue;
        importedFields -= 1;
        delete plan.imports[header];
        plan.canonical[cell.columnKey] = canonicalValue(latestValue);
        plan.details = plan.details.filter((entry) => entry.fieldName !== header);
        if (latestValue === cell.observed) {
          rejectedConvergence = true;
          continue;
        }
        plan.details.push(detail(
          actor,
          header,
          cell.observed,
          latestValue,
          options.source,
          'conflict',
        ));
        rejectedUpdates.push({
          range: cellRange(options.connection.sheetName, plan.rowNumber, cell.columnIndex),
          values: [[latestValue]],
        });
        plan.direction = 'to_sheets';
        plan.conflictResolution = 'harness_wins';
      }
      if (
        rejectedConvergence
        && rejectedUpdates.length === 0
        && Object.keys(plan.imports).length === 0
      ) {
        plan.direction = 'to_sheets';
        plan.conflictResolution = null;
      }
      if (rejectedUpdates.length > 0) {
        await renewLease();
        await client.batchUpdateValues(options.connection.spreadsheetId, rejectedUpdates);
        updatedRowNumbers.add(plan.rowNumber);
      }
      await persistPlan(options.db, options.connection, plan, completedAt, renewLease);
    }

    const status = warnings.length > 0 ? 'warning' : 'success';
    const warning = warnings.length > 0 ? warnings.join(' / ') : null;
    const finalLease = await renewLease();
    const statusUpdated = await updateSheetsSyncStatus(
      options.db,
      options.connection.lineAccountId,
      options.connection.id,
      {
        status,
        lastSyncAt: completedAt,
        warning,
        errorCode: warnings.length > 0 ? 'friend_ledger_warning' : null,
      },
      finalLease,
    );
    if (!statusUpdated) throw new Error('friend_ledger_sync_lock_lost');
    return {
      status,
      busy: false,
      warning,
      warnings,
      appendedRows,
      updatedRows: updatedRowNumbers.size,
      importedFields,
      ignoredIdentityEdits,
    };
  } catch (error) {
    failure = error;
    const failedAt = toJstString(nowFactory());
    await updateSheetsSyncStatus(options.db, options.connection.lineAccountId, options.connection.id, {
      status: 'error',
      lastSyncAt: failedAt,
      warning: null,
      errorCode: 'friend_ledger_sync_failed',
    }, { token: lockToken, now: failedAt }).catch(() => null);
    throw error;
  } finally {
    const released = await releaseSheetsSyncLock(
      options.db,
      options.connection.lineAccountId,
      options.connection.id,
      lockToken,
    ).catch(() => false);
    if (!released && !failure) throw new Error('friend_ledger_lock_release_failed');
  }
}

export interface DrainFriendLedgerWebhookEventsOptions {
  db: D1Database;
  connection: SheetsConnection;
  client?: FriendLedgerSheetsClient;
  credentialsJson?: string;
  maxEvents: number;
  now?: () => Date;
}

export interface FriendLedgerWebhookDrainResult {
  attempted: number;
  applied: number;
  deferred: number;
  dead: number;
  exhausted: boolean;
}

export async function drainFriendLedgerWebhookEvents(
  options: DrainFriendLedgerWebhookEventsOptions,
): Promise<FriendLedgerWebhookDrainResult> {
  const nowFactory = options.now ?? (() => new Date());
  const limit = Math.max(1, Math.min(MAX_WEBHOOK_EVENTS_PER_DRAIN, Math.trunc(options.maxEvents)));
  const result: FriendLedgerWebhookDrainResult = {
    attempted: 0,
    applied: 0,
    deferred: 0,
    dead: 0,
    exhausted: false,
  };
  for (let index = 0; index < limit; index += 1) {
    const claimTime = nowFactory();
    const claimToken = `gswe_${crypto.randomUUID()}`;
    const event = await claimNextSheetsWebhookEvent(
      options.db,
      options.connection.lineAccountId,
      options.connection.id,
      options.connection.configVersion,
      {
        token: claimToken,
        now: toJstString(claimTime),
        expiresAt: toJstString(new Date(claimTime.getTime() + WEBHOOK_EVENT_CLAIM_MS)),
        discardBefore: toJstString(new Date(claimTime.getTime() - WEBHOOK_EVENT_RETENTION_MS)),
        maxAttempts: MAX_WEBHOOK_EVENT_ATTEMPTS,
      },
    );
    if (!event) break;
    result.attempted += 1;
    const alreadyApplied = await hasSheetsSyncAuditForWebhookEvent(
      options.db,
      options.connection.lineAccountId,
      options.connection.id,
      options.connection.configVersion,
      event.eventId,
    );
    if (alreadyApplied) {
      const finished = await finishSheetsWebhookEvent(
        options.db,
        options.connection.lineAccountId,
        options.connection.id,
        options.connection.configVersion,
        event.eventId,
        {
          processingToken: claimToken,
          status: 'applied',
          completedAt: toJstString(nowFactory()),
          errorCode: null,
        },
      );
      if (finished) result.applied += 1;
      continue;
    }
    const payload = parseFriendLedgerWebhookEventPayload(event.payload);
    if (!payload) {
      const completedAt = toJstString(nowFactory());
      const finished = await finishSheetsWebhookEvent(
        options.db,
        options.connection.lineAccountId,
        options.connection.id,
        options.connection.configVersion,
        event.eventId,
        {
          processingToken: claimToken,
          status: 'dead',
          completedAt,
          errorCode: 'invalid_webhook_event_payload',
        },
      );
      if (finished) result.dead += 1;
      continue;
    }
    try {
      const synced = await syncFriendLedger({
        db: options.db,
        connection: options.connection,
        client: options.client,
        credentialsJson: options.credentialsJson,
        source: 'webhook',
        actor: event.actorKind === 'google_email' ? event.actor : 'google_sheets_editor_unavailable',
        range: payload.range,
        snapshot: payload.snapshot,
        webhookEventId: event.eventId,
        now: nowFactory,
      });
      if (synced.busy) {
        const retryAt = new Date(nowFactory().getTime() + WEBHOOK_EVENT_RETRY_MS);
        const deferred = await deferSheetsWebhookEvent(
          options.db,
          options.connection.lineAccountId,
          options.connection.id,
          options.connection.configVersion,
          event.eventId,
          {
            processingToken: claimToken,
            availableAt: toJstString(retryAt),
            errorCode: 'friend_ledger_sync_busy',
          },
        );
        if (deferred) result.deferred += 1;
        break;
      }
      const finished = await finishSheetsWebhookEvent(
        options.db,
        options.connection.lineAccountId,
        options.connection.id,
        options.connection.configVersion,
        event.eventId,
        {
          processingToken: claimToken,
          status: 'applied',
          completedAt: toJstString(nowFactory()),
          errorCode: null,
        },
      );
      if (!finished) throw new Error('webhook_event_claim_lost');
      result.applied += 1;
    } catch {
      const failureTime = nowFactory();
      const status = await failSheetsWebhookEvent(
        options.db,
        options.connection.lineAccountId,
        options.connection.id,
        options.connection.configVersion,
        event.eventId,
        {
          processingToken: claimToken,
          availableAt: toJstString(new Date(failureTime.getTime() + WEBHOOK_EVENT_RETRY_MS)),
          completedAt: toJstString(failureTime),
          errorCode: 'friend_ledger_webhook_sync_failed',
          maxAttempts: MAX_WEBHOOK_EVENT_ATTEMPTS,
        },
      );
      if (status === 'dead') result.dead += 1;
      else result.deferred += 1;
      break;
    }
  }
  result.exhausted = result.attempted >= limit;
  return result;
}

export interface RunFriendLedgerPollingOptions {
  db: D1Database;
  credentialsJson?: string;
  maxConnections: number;
  now?: () => Date;
}

export async function runFriendLedgerPolling(
  options: RunFriendLedgerPollingOptions,
): Promise<{ attempted: number; succeeded: number; warnings: number; failed: number }> {
  if (!options.credentialsJson) return { attempted: 0, succeeded: 0, warnings: 0, failed: 0 };
  const client = new GoogleSheetsClient({
    credentials: parseGoogleServiceAccountCredentials(options.credentialsJson),
  });
  const connections = await listActiveSheetsConnectionsForSync(options.db, options.maxConnections);
  const summary = { attempted: 0, succeeded: 0, warnings: 0, failed: 0 };
  for (const connection of connections) {
    summary.attempted += 1;
    try {
      const webhookEvents = await drainFriendLedgerWebhookEvents({
        db: options.db,
        connection,
        client,
        maxEvents: 10,
        now: options.now,
      });
      if (webhookEvents.deferred > 0 || webhookEvents.exhausted) {
        summary.warnings += 1;
        continue;
      }
      const result = await syncFriendLedger({
        db: options.db,
        connection,
        client,
        source: 'polling',
        actor: 'system_poll',
        now: options.now,
      });
      if (result.status === 'warning') summary.warnings += 1;
      else summary.succeeded += 1;
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}

export async function listFriendLedgerAudit(options: {
  db: D1Database;
  lineAccountId: string;
  connectionId: string;
  limit?: number;
}) {
  const events = await listSheetsSyncAudit(
    options.db,
    options.lineAccountId,
    options.connectionId,
    { limit: options.limit },
  );
  return events.flatMap((event) => event.details.map((entry) => ({
    id: entry.id,
    auditId: event.id,
    actor: entry.actor,
    fieldName: entry.fieldName,
    oldValue: entry.oldValue,
    newValue: entry.newValue,
    source: entry.source,
    changeKind: entry.changeKind,
    conflictResolution: event.conflictResolution,
    createdAt: entry.createdAt,
  })));
}
