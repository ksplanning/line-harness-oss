import {
  appendSheetsSyncAudit,
  claimSheetsSyncLock,
  listActiveSheetsConnectionsForSync,
  listFriendFieldDefinitions,
  listSheetsSyncAudit,
  listSheetsSyncLedger,
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
  createdAt: string;
  updatedAt: string;
}

export interface FriendLedgerEditRange {
  rowStart: number;
  rowEnd: number;
  columnStart: number;
  columnEnd: number;
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
}

export interface FriendLedgerSyncResult {
  status: 'success' | 'warning';
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
  sheetUpdates: SheetsDataUpdate[];
  direction: 'to_sheets' | 'from_sheets';
  conflictResolution: 'harness_wins' | 'sheet_wins' | null;
  isAppend: boolean;
}

const LOCK_DURATION_MS = 2 * 60_000;

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ...(parsed as Record<string, unknown>) }
      : {};
  } catch {
    return {};
  }
}

function serializeFriend(row: FriendRow): FriendState {
  return {
    id: row.id,
    lineUserId: row.line_user_id,
    displayName: row.display_name,
    metadataRaw: row.metadata || '{}',
    metadata: parseMetadata(row.metadata || '{}'),
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
  lineAccountId: string,
  friend: FriendState,
  imports: Record<string, string>,
  updatedAt: string,
): Promise<FriendState> {
  if (Object.keys(imports).length === 0) return friend;
  let current = friend;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const merged = { ...current.metadata, ...imports };
    const nextRaw = JSON.stringify(merged);
    const result = await db.prepare(
      `UPDATE friends
       SET metadata = ?, updated_at = ?
       WHERE id = ? AND line_account_id = ? AND metadata IS ?`,
    ).bind(nextRaw, updatedAt, current.id, lineAccountId, current.metadataRaw).run();
    if ((result.meta.changes ?? 0) === 1) {
      return { ...current, metadataRaw: nextRaw, metadata: merged, updatedAt };
    }
    const latest = await db.prepare(
      `SELECT id, line_user_id, display_name, metadata, created_at, updated_at
       FROM friends WHERE id = ? AND line_account_id = ?`,
    ).bind(current.id, lineAccountId).first<FriendRow>();
    if (!latest) throw new Error('friend_missing_during_sync');
    current = serializeFriend(latest);
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
): Promise<void> {
  const nextFingerprint = await fingerprint(plan.canonical);
  const changed = plan.isAppend || plan.details.length > 0 || plan.ledger?.rowFingerprint !== nextFingerprint;
  const needsBaseline = !plan.ledger;
  if (!changed && !needsBaseline) return;
  const sequence = await reserveSheetsSyncSequence(
    db,
    connection.lineAccountId,
    connection.id,
    connection.configVersion,
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
    outcome: changed || plan.isAppend ? 'applied' : 'skipped',
    conflictResolution: plan.conflictResolution,
    harnessUpdatedAt: plan.friend.updatedAt,
    sheetObservedAt: now,
    beforeFingerprint: plan.ledger?.rowFingerprint ?? null,
    afterFingerprint: nextFingerprint,
    errorCode: plan.details.some((entry) => entry.changeKind === 'identity_ignored')
      ? 'identity_read_only'
      : null,
    details: plan.details,
  });
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
  });
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
      status: 'warning', warning: warnings[0], warnings,
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
      status: 'warning', warning: warnings[0], warnings,
      appendedRows: 0, updatedRows: 0, importedFields: 0, ignoredIdentityEdits: 0,
    };
  }

  let failure: unknown;
  try {
    await updateSheetsSyncStatus(options.db, options.connection.lineAccountId, options.connection.id, {
      status: 'running',
      lastSyncAt: options.connection.lastSyncAt,
      warning: null,
      errorCode: null,
    });
    const client = makeClient(options);
    const [friends, ledgerEntries, definitions, response] = await Promise.all([
      listFriends(options.db, options.connection.lineAccountId),
      listSheetsSyncLedger(options.db, options.connection.lineAccountId, options.connection.id),
      listFriendFieldDefinitions(options.db),
      client.readValues(
        options.connection.spreadsheetId,
        quoteSheetName(options.connection.sheetName),
      ),
    ]);
    const defaults = new Map(definitions.map((definition) => [definition.id, definition.defaultValue]));
    const columns = buildFriendLedgerColumns(options.connection.friendFieldMappings);
    const ledgerByFriend = new Map(ledgerEntries.map((entry) => [entry.recordKey, entry]));
    const values = (response.values ?? []).map((row) => [...row]);
    const warnings: string[] = [];
    const plans: RowPlan[] = [];
    let appendedRows = 0;
    let importedFields = 0;
    let ignoredIdentityEdits = 0;

    const headerIsEmpty = values.length === 0 || !(values[0] ?? []).some((cell) => normalizeSheetCell(cell));
    if (headerIsEmpty) {
      const headers = columns.map((column) => column.header);
      await client.updateValues(
        options.connection.spreadsheetId,
        blockRange(options.connection.sheetName, 1, headers.length),
        [headers],
      );
      if (friends.length > 0) {
        const rows = friends.map((friend) => {
          const projection = projectedWithDefaults(friend, options.connection, defaults);
          return columns.map((column) => projection[column.key] ?? '');
        });
        await client.appendValues(
          options.connection.spreadsheetId,
          `${quoteSheetName(options.connection.sheetName)}!A:${columnLabel(Math.max(0, headers.length - 1))}`,
          rows,
        );
        appendedRows = friends.length;
      }
      for (let index = 0; index < friends.length; index += 1) {
        const friend = friends[index];
        const projection = projectedWithDefaults(friend, options.connection, defaults);
        const canonical = Object.fromEntries(
          columns.map((column) => [column.key, canonicalValue(projection[column.key] ?? '')]),
        );
        plans.push({
          friend,
          rowNumber: index + 2,
          ledger: null,
          canonical,
          imports: {},
          sheetUpdates: [],
          direction: 'to_sheets',
          conflictResolution: null,
          isAppend: true,
          details: columns
            .filter((column) => column.kind === 'custom')
            .map((column) => detail(actor, column.header, null, projection[column.key] ?? '', options.source, 'custom_field')),
        });
      }
    } else {
      const headers = values[0] ?? [];
      const resolved = resolveFriendLedgerHeaders(headers, columns);
      for (const headerWarning of resolved.warnings) {
        warnings.push(warningText(headerWarning.code, headerWarning.header));
      }
      const userIdIndex = resolved.indexByKey['identity:lineUserId'];
      const positions = new Map<string, number[]>();
      if (userIdIndex !== undefined) {
        for (let index = 1; index < values.length; index += 1) {
          const userId = normalizeSheetCell(values[index]?.[userIdIndex]);
          if (!userId) continue;
          const rows = positions.get(userId) ?? [];
          rows.push(index + 1);
          positions.set(userId, rows);
        }
        for (const [userId, rows] of positions) {
          if (rows.length > 1) warnings.push(`userId「${userId}」の行が重複しています`);
        }
      }

      for (const friend of friends) {
        const ledger = ledgerByFriend.get(friend.id) ?? null;
        const matchingRows = positions.get(friend.lineUserId) ?? [];
        let rowNumber = matchingRows.length === 1 ? matchingRows[0] : null;
        if (!rowNumber && ledger?.sheetRowNumber && values[ledger.sheetRowNumber - 1]) {
          rowNumber = ledger.sheetRowNumber;
        }
        const projection = projectedWithDefaults(friend, options.connection, defaults);
        if (!rowNumber) {
          if (userIdIndex === undefined) continue;
          const nextRow = rowForProjection(headers.length, projection, columns, resolved.indexByKey);
          await client.appendValues(
            options.connection.spreadsheetId,
            `${quoteSheetName(options.connection.sheetName)}!A:${columnLabel(Math.max(0, headers.length - 1))}`,
            [nextRow],
          );
          rowNumber = values.length + appendedRows + 1;
          appendedRows += 1;
          const canonical = Object.fromEntries(
            columns.map((column) => [column.key, canonicalValue(projection[column.key] ?? '')]),
          );
          plans.push({
            friend, rowNumber, ledger: null, canonical, imports: {}, sheetUpdates: [],
            direction: 'to_sheets', conflictResolution: null, isAppend: true,
            details: columns
              .filter((column) => column.kind === 'custom')
              .map((column) => detail(actor, column.header, null, projection[column.key] ?? '', options.source, 'custom_field')),
          });
          continue;
        }

        const sheetRow = values[rowNumber - 1] ?? [];
        const details: SheetsSyncAuditDetailInput[] = [];
        const imports: Record<string, string> = {};
        const sheetUpdates: SheetsDataUpdate[] = [];
        const canonical: Record<string, SheetsCanonicalCellValue> = {};
        let direction: RowPlan['direction'] = 'to_sheets';
        let conflictResolution: RowPlan['conflictResolution'] = null;

        for (const column of columns) {
          const expected = projection[column.key] ?? '';
          const columnIndex = resolved.indexByKey[column.key];
          if (columnIndex === undefined) {
            canonical[column.key] = canonicalValue(expected);
            continue;
          }
          const observed = normalizeSheetCell(sheetRow[columnIndex]);
          if (column.kind === 'identity') {
            canonical[column.key] = canonicalValue(expected);
            if (observed !== expected) {
              sheetUpdates.push({
                range: cellRange(options.connection.sheetName, rowNumber, columnIndex),
                values: [[expected]],
              });
              const baseline = ledger
                ? normalizeSheetCell(ledger.canonicalSnapshot[column.key])
                : observed;
              const harnessChanged = expected !== baseline;
              const sheetChanged = ledger ? observed !== baseline : false;
              if (!ledger || (harnessChanged && !sheetChanged)) {
                details.push(detail(actor, column.header, observed, expected, options.source, 'identity_sync'));
              } else {
                ignoredIdentityEdits += 1;
                const message = `保護列「${column.header}」の変更を取り込みませんでした`;
                if (!warnings.includes(message)) warnings.push(message);
                details.push(detail(actor, column.header, expected, observed, options.source, 'identity_ignored'));
              }
            }
            continue;
          }

          const baseline = ledger
            ? normalizeSheetCell(ledger.canonicalSnapshot[column.key])
            : expected;
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
              actor, column.header, expected, observed, options.source,
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
          friend, rowNumber, ledger, canonical, details, imports, sheetUpdates,
          direction, conflictResolution, isAppend: false,
        });
      }
    }

    const allSheetUpdates = plans.flatMap((plan) => plan.sheetUpdates);
    if (allSheetUpdates.length > 0) {
      await client.batchUpdateValues(options.connection.spreadsheetId, allSheetUpdates);
    }
    const updatedRows = new Set(
      plans.filter((plan) => plan.sheetUpdates.length > 0).map((plan) => plan.rowNumber),
    ).size;
    const completedAt = toJstString(nowFactory());
    for (const plan of plans) {
      plan.friend = await saveImportedMetadata(
        options.db,
        options.connection.lineAccountId,
        plan.friend,
        plan.imports,
        completedAt,
      );
      await persistPlan(options.db, options.connection, plan, completedAt);
    }

    const status = warnings.length > 0 ? 'warning' : 'success';
    const warning = warnings.length > 0 ? warnings.join(' / ') : null;
    await updateSheetsSyncStatus(options.db, options.connection.lineAccountId, options.connection.id, {
      status,
      lastSyncAt: completedAt,
      warning,
      errorCode: warnings.length > 0 ? 'friend_ledger_warning' : null,
    });
    return { status, warning, warnings, appendedRows, updatedRows, importedFields, ignoredIdentityEdits };
  } catch (error) {
    failure = error;
    const failedAt = toJstString(nowFactory());
    await updateSheetsSyncStatus(options.db, options.connection.lineAccountId, options.connection.id, {
      status: 'error',
      lastSyncAt: failedAt,
      warning: null,
      errorCode: 'friend_ledger_sync_failed',
    }).catch(() => null);
    throw error;
  } finally {
    await releaseSheetsSyncLock(
      options.db,
      options.connection.lineAccountId,
      options.connection.id,
      lockToken,
    ).catch(() => {
      if (!failure) throw new Error('friend_ledger_lock_release_failed');
    });
  }
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
