import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import * as sheetsConnectionDb from './sheets-connections.js';

const {
  createSheetsConnection,
  getSheetsConnection,
  listSheetsConnections,
  replaceSheetsConnection,
  reserveSheetsSyncSequence,
  softDeleteSheetsConnection,
  updateSheetsConnection,
} = sheetsConnectionDb;

type FriendFieldMapping = { fieldId: string; header: string };
type FormAnswerHeader = { fieldId: string; header: string };
type SheetsSyncStatus = 'idle' | 'running' | 'success' | 'warning' | 'error';
type CanonicalCellValue = string | number | boolean | null;

interface FriendLedgerConnectionContract {
  id: string;
  lineAccountId: string;
  formId: string;
  spreadsheetId: string;
  sheetName: string;
  syncDirection: 'to_sheets' | 'from_sheets' | 'bidirectional';
  conflictPolicy: 'last_write_wins';
  conflictClock: 'server_sequence';
  configVersion: number;
  friendFieldMappings: FriendFieldMapping[];
  friendLedgerEnabled: boolean;
  friendLedgerHeaders: string[];
  formAnswerHeaders: FormAnswerHeader[];
  selectedFormFieldIds: string[] | null;
  lastSyncAt: string | null;
  lastSyncStatus: SheetsSyncStatus;
  lastSyncWarning: string | null;
  lastSyncErrorCode: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface SheetsSyncLedgerContract {
  connectionId: string;
  connectionVersion: number;
  recordKey: string;
  sheetRowNumber: number | null;
  rowFingerprint: string;
  canonicalSnapshot: Record<string, CanonicalCellValue>;
  harnessUpdatedAt: string | null;
  sheetObservedAt: string | null;
  lastSyncedAt: string;
  lastSyncDirection: 'to_sheets' | 'from_sheets';
  lastAppliedSequence: number;
  version: number;
}

interface SheetsSyncAuditDetailContract {
  id: string;
  actor: string;
  fieldName: string;
  oldValue: string | null;
  newValue: string | null;
  source: 'webhook' | 'polling' | 'manual';
  changeKind: 'custom_field' | 'identity_sync' | 'identity_ignored' | 'conflict';
  createdAt?: string;
}

interface SheetsSyncAuditContract {
  id: string;
  connectionId: string;
  connectionVersion: number;
  applySequence: number;
  lineAccountId: string;
  formId: string;
  spreadsheetId: string;
  sheetName: string;
  recordKey: string | null;
  sheetRowNumber: number | null;
  direction: 'to_sheets' | 'from_sheets';
  action: 'append' | 'read' | 'update' | 'conflict';
  outcome: 'applied' | 'skipped' | 'failed';
  conflictResolution: 'harness_wins' | 'sheet_wins' | 'same_sequence' | null;
  harnessUpdatedAt: string | null;
  sheetObservedAt: string | null;
  beforeFingerprint: string | null;
  afterFingerprint: string | null;
  errorCode: string | null;
  webhookEventId?: string | null;
  createdAt: string;
  details: SheetsSyncAuditDetailContract[];
}

interface FriendLedgerDbContract {
  getActiveSheetsConnectionById(
    db: D1Database,
    id: string,
  ): Promise<FriendLedgerConnectionContract | null>;
  createSheetsConnection(
    db: D1Database,
    input: {
      lineAccountId: string;
      formId: string;
      spreadsheetId: string;
      sheetName: string;
      syncDirection: 'to_sheets' | 'from_sheets' | 'bidirectional';
      friendFieldMappings?: FriendFieldMapping[];
      friendLedgerEnabled?: boolean;
      selectedFormFieldIds?: string[] | null;
    },
  ): Promise<FriendLedgerConnectionContract>;
  updateSheetsConnection(
    db: D1Database,
    lineAccountId: string,
    id: string,
    input: {
      spreadsheetId: string;
      sheetName: string;
      syncDirection: 'to_sheets' | 'from_sheets' | 'bidirectional';
      friendFieldMappings?: FriendFieldMapping[];
      friendLedgerEnabled?: boolean;
      selectedFormFieldIds?: string[] | null;
    },
  ): Promise<FriendLedgerConnectionContract | null>;
  updateSheetsSyncStatus(
    db: D1Database,
    lineAccountId: string,
    id: string,
    input: {
      status: SheetsSyncStatus;
      lastSyncAt: string | null;
      warning: string | null;
      errorCode: string | null;
    },
    lease?: { token: string; now: string },
  ): Promise<FriendLedgerConnectionContract | null>;
  listActiveSheetsConnectionsForSync(
    db: D1Database,
    limit: number,
  ): Promise<FriendLedgerConnectionContract[]>;
  recordSheetsFriendLedgerHeaders(
    db: D1Database,
    lineAccountId: string,
    id: string,
    configVersion: number,
    headers: string[],
    lease?: { token: string; now: string },
  ): Promise<boolean>;
  recordSheetsFormAnswerHeaders(
    db: D1Database,
    lineAccountId: string,
    id: string,
    configVersion: number,
    headers: FormAnswerHeader[],
    lease: { token: string; now: string },
  ): Promise<boolean>;
  enqueueSheetsWebhookEvent(
    db: D1Database,
    lineAccountId: string,
    connectionId: string,
    connectionVersion: number,
    input: {
      eventId: string;
      actor: string;
      actorKind: 'google_email' | 'unavailable';
      occurredAt: string;
      payload: Record<string, unknown>;
      receivedAt: string;
    },
  ): Promise<{ sequence: number; status: 'pending' | 'applied' | 'dead'; enqueued: boolean } | null>;
  claimNextSheetsWebhookEvent(
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
  ): Promise<{
    eventId: string;
    actor: string;
    payload: Record<string, unknown> | null;
    attempts: number;
    processingToken: string | null;
  } | null>;
  finishSheetsWebhookEvent(
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
  ): Promise<boolean>;
  expireSheetsWebhookEvents(
    db: D1Database,
    input: { now: string; discardBefore: string; maxAttempts: number; limit: number },
  ): Promise<number>;
  purgeSheetsWebhookEventTombstones(
    db: D1Database,
    input: { completedBefore: string; limit: number },
  ): Promise<number>;
  claimSheetsSyncLock(
    db: D1Database,
    lineAccountId: string,
    id: string,
    token: string,
    now: string,
    expiresAt: string,
    configVersion?: number,
  ): Promise<boolean>;
  releaseSheetsSyncLock(
    db: D1Database,
    lineAccountId: string,
    id: string,
    token: string,
  ): Promise<boolean>;
  clearSheetsSyncLedgerRowNumbers(
    db: D1Database,
    lineAccountId: string,
    connectionId: string,
    connectionVersion: number,
    recordKeys: string[],
    lease?: { token: string; now: string },
  ): Promise<boolean>;
  listSheetsSyncLedger(
    db: D1Database,
    lineAccountId: string,
    connectionId: string,
  ): Promise<SheetsSyncLedgerContract[]>;
  upsertSheetsSyncLedger(
    db: D1Database,
    lineAccountId: string,
    entry: Omit<SheetsSyncLedgerContract, 'version'>,
    lease?: { token: string; now: string },
  ): Promise<boolean>;
  appendSheetsSyncAudit(
    db: D1Database,
    lineAccountId: string,
    entry: Omit<
      SheetsSyncAuditContract,
      'lineAccountId' | 'formId' | 'spreadsheetId' | 'sheetName' | 'createdAt'
    >,
    lease?: { token: string; now: string },
  ): Promise<boolean>;
  commitSheetsSyncRow(
    db: D1Database,
    lineAccountId: string,
    input: {
      audit: Omit<
        SheetsSyncAuditContract,
        'lineAccountId' | 'formId' | 'spreadsheetId' | 'sheetName' | 'createdAt'
      >;
      ledger: Omit<SheetsSyncLedgerContract, 'version'>;
    },
    lease?: { token: string; now: string },
  ): Promise<boolean>;
  listSheetsSyncAudit(
    db: D1Database,
    lineAccountId: string,
    connectionId: string,
    options?: { limit?: number },
  ): Promise<SheetsSyncAuditContract[]>;
}

// The cast lets the landed 114 module load and keeps its existing tests green
// while these RED tests describe the additive 119 exports that do not exist yet.
const friendLedgerDb = sheetsConnectionDb as unknown as FriendLedgerDbContract;

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');

function d1(db: Database.Database): D1Database {
  type MockStatement = D1PreparedStatement & { __exec: () => { meta: { changes: number } } };
  const prepare = (sql: string): MockStatement => {
    const statement = db.prepare(sql);
    let params: unknown[] = [];
    const api = {
      bind(...args: unknown[]) { params = args; return api; },
      async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
      async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
      async run() { return api.__exec(); },
      __exec() {
        const result = statement.run(...(params as never[]));
        return { meta: { changes: result.changes } };
      },
    } as unknown as MockStatement;
    return api;
  };
  return {
    prepare,
    async batch(statements: MockStatement[]) {
      return db.transaction((items: MockStatement[]) => items.map((item) => item.__exec()))(statements);
    },
  } as unknown as D1Database;
}

let raw: Database.Database;
let db: D1Database;

beforeEach(() => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  raw.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('acc-1', 'channel-1', 'A', 'token', 'secret'), ('acc-2', 'channel-2', 'B', 'token', 'secret')`).run();
  db = d1(raw);
});

describe('Sheets connections DB helper', () => {
  test('create/get/list maps settings and scopes the list by LINE account/form', async () => {
    const first = await createSheetsConnection(db, {
      lineAccountId: 'acc-1', formId: 'form-1', spreadsheetId: 'sheet-1',
      sheetName: '回答', syncDirection: 'bidirectional',
    });
    await createSheetsConnection(db, {
      lineAccountId: 'acc-1', formId: 'form-2', spreadsheetId: 'sheet-2',
      sheetName: '回答2', syncDirection: 'to_sheets',
    });
    await createSheetsConnection(db, {
      lineAccountId: 'acc-2', formId: 'form-1', spreadsheetId: 'sheet-3',
      sheetName: '回答3', syncDirection: 'from_sheets',
    });

    expect(await getSheetsConnection(db, 'acc-1', first.id)).toMatchObject({
      id: first.id,
      lineAccountId: 'acc-1',
      formId: 'form-1',
      spreadsheetId: 'sheet-1',
      sheetName: '回答',
      syncDirection: 'bidirectional',
      conflictPolicy: 'last_write_wins',
      conflictClock: 'server_sequence',
      configVersion: 1,
      isActive: true,
    });
    expect((await listSheetsConnections(db, 'acc-1')).map((item) => item.formId).sort()).toEqual(['form-1', 'form-2']);
    expect((await listSheetsConnections(db, 'acc-1', 'form-2')).map((item) => item.formId)).toEqual(['form-2']);
    expect(await getSheetsConnection(db, 'acc-2', first.id)).toBeNull();
  });

  test('advances settings generation while preserving same-sheet ownership and resets it after a target move', async () => {
    const created = await createSheetsConnection(db, {
      lineAccountId: 'acc-1', formId: 'form-1', spreadsheetId: 'sheet-old',
      sheetName: '旧', syncDirection: 'to_sheets',
    });
    raw.prepare(`INSERT INTO sheets_sync_ledger
      (connection_id, connection_version, record_key, row_fingerprint, last_synced_at,
       last_sync_direction, last_applied_sequence)
      VALUES (?, 1, 'record-1', 'fingerprint-1', '2026-07-20T00:00:00+09:00', 'to_sheets', 1)`).run(created.id);

    const directionOnly = await updateSheetsConnection(db, 'acc-1', created.id, {
      spreadsheetId: 'sheet-old', sheetName: '旧', syncDirection: 'bidirectional',
    });
    expect(directionOnly?.configVersion).toBe(2);
    expect(raw.prepare(`SELECT record_key, connection_version FROM sheets_sync_ledger
      WHERE connection_id=?`).get(created.id)).toEqual({
      record_key: 'record-1', connection_version: 2,
    });

    const updated = await updateSheetsConnection(db, 'acc-1', created.id, {
      spreadsheetId: 'sheet-new', sheetName: '新', syncDirection: 'from_sheets',
    });
    expect(updated).toMatchObject({
      id: created.id,
      lineAccountId: 'acc-1',
      formId: 'form-1',
      spreadsheetId: 'sheet-new',
      sheetName: '新',
      syncDirection: 'from_sheets',
      configVersion: 3,
    });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM sheets_sync_ledger WHERE connection_id=?').get(created.id))
      .toEqual({ count: 0 });
    expect(await updateSheetsConnection(db, 'acc-2', created.id, {
      spreadsheetId: 'wrong-account', sheetName: 'x', syncDirection: 'bidirectional',
    })).toBeNull();
    expect(await updateSheetsConnection(db, 'acc-1', 'missing', {
      spreadsheetId: 'x', sheetName: 'x', syncDirection: 'bidirectional',
    })).toBeNull();
  });

  test('soft delete hides the connection while retaining its row for audit history', async () => {
    const created = await createSheetsConnection(db, {
      lineAccountId: 'acc-1', formId: 'form-1', spreadsheetId: 'sheet-1',
      sheetName: '回答', syncDirection: 'bidirectional',
    });
    raw.prepare(`INSERT INTO sheets_sync_ledger
      (connection_id, connection_version, record_key, row_fingerprint, last_synced_at,
       last_sync_direction, last_applied_sequence)
      VALUES (?, 1, 'record-1', 'fingerprint-1', '2026-07-20T00:00:00+09:00', 'to_sheets', 1)`).run(created.id);
    expect(await softDeleteSheetsConnection(db, 'acc-2', created.id)).toBe(false);
    expect(await softDeleteSheetsConnection(db, 'acc-1', created.id)).toBe(true);
    expect(await getSheetsConnection(db, 'acc-1', created.id)).toBeNull();
    expect(await listSheetsConnections(db, 'acc-1')).toEqual([]);
    expect(raw.prepare('SELECT is_active, deleted_at FROM sheets_connections WHERE id=?').get(created.id))
      .toMatchObject({ is_active: 0, deleted_at: expect.any(String) });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM sheets_sync_ledger WHERE connection_id=?').get(created.id))
      .toEqual({ count: 0 });
    expect(await softDeleteSheetsConnection(db, 'acc-1', created.id)).toBe(false);
  });

  test('replaces one form connection with a new row and leaves a locked connection untouched', async () => {
    const first = await createSheetsConnection(db, {
      lineAccountId: 'acc-1', formId: 'replace-form', spreadsheetId: 'sheet-old',
      sheetName: '旧回答', syncDirection: 'bidirectional',
    });
    const replacement = await replaceSheetsConnection(db, {
      lineAccountId: 'acc-1', formId: 'replace-form', spreadsheetId: 'sheet-new',
      sheetName: '新回答', syncDirection: 'to_sheets', selectedFormFieldIds: ['name'],
    });

    expect(replacement).toMatchObject({
      formId: 'replace-form', spreadsheetId: 'sheet-new', sheetName: '新回答',
      selectedFormFieldIds: ['name'], isActive: true,
    });
    expect(replacement?.id).not.toBe(first.id);
    expect(raw.prepare(`SELECT is_active, deleted_at FROM sheets_connections WHERE id=?`).get(first.id))
      .toMatchObject({ is_active: 0, deleted_at: expect.any(String) });
    expect(await listSheetsConnections(db, 'acc-1', 'replace-form')).toHaveLength(1);

    raw.prepare(`UPDATE sheets_connections
      SET sync_lock_token='running', sync_lock_expires_at='2099-01-01T00:00:00+09:00'
      WHERE id=?`).run(replacement!.id);
    await expect(replaceSheetsConnection(db, {
      lineAccountId: 'acc-1', formId: 'replace-form', spreadsheetId: 'blocked-sheet',
      sheetName: 'ブロック', syncDirection: 'bidirectional',
    })).resolves.toBeNull();
    expect((await listSheetsConnections(db, 'acc-1', 'replace-form'))[0].id).toBe(replacement!.id);
  });

  test('reserves a monotonic server sequence only for the active connection generation', async () => {
    const created = await createSheetsConnection(db, {
      lineAccountId: 'acc-1', formId: 'form-1', spreadsheetId: 'sheet-1',
      sheetName: '回答', syncDirection: 'bidirectional',
    });

    await expect(reserveSheetsSyncSequence(db, 'acc-1', created.id, 1)).resolves.toBe(1);
    await expect(reserveSheetsSyncSequence(db, 'acc-1', created.id, 1)).resolves.toBe(2);
    await expect(reserveSheetsSyncSequence(db, 'acc-2', created.id, 1)).resolves.toBeNull();
    await expect(reserveSheetsSyncSequence(db, 'acc-1', created.id, 2)).resolves.toBeNull();
  });

  test('serializes immutable friend-field header snapshots on create and settings update', async () => {
    const initialMappings = [
      { fieldId: 'field-contract', header: '契約状況' },
      { fieldId: 'field-plan', header: '利用プラン' },
    ];
    const created = await friendLedgerDb.createSheetsConnection(db, {
      lineAccountId: 'acc-1',
      formId: 'friends',
      spreadsheetId: 'sheet-friends',
      sheetName: '友だち台帳',
      syncDirection: 'bidirectional',
      friendFieldMappings: initialMappings,
      friendLedgerEnabled: true,
    });

    expect(created).toMatchObject({
      friendFieldMappings: initialMappings,
      friendLedgerEnabled: true,
      friendLedgerHeaders: [],
      formAnswerHeaders: [],
      lastSyncAt: null,
      lastSyncStatus: 'idle',
      lastSyncWarning: null,
      lastSyncErrorCode: null,
    });
    expect(raw.prepare('SELECT friend_field_mappings_json FROM sheets_connections WHERE id = ?').get(created.id))
      .toEqual({ friend_field_mappings_json: JSON.stringify(initialMappings) });
    await friendLedgerDb.recordSheetsFriendLedgerHeaders(
      db,
      'acc-1',
      created.id,
      1,
      ['表示名', 'userId', '登録日', '契約状況', '利用プラン'],
    );

    const renamedSnapshot = [{ fieldId: 'field-contract', header: '契約状況（選択時）' }];
    const updated = await friendLedgerDb.updateSheetsConnection(db, 'acc-1', created.id, {
      spreadsheetId: 'sheet-friends',
      sheetName: '友だち台帳',
      syncDirection: 'from_sheets',
      friendFieldMappings: renamedSnapshot,
    });
    expect(updated).toMatchObject({
      friendFieldMappings: renamedSnapshot,
      syncDirection: 'from_sheets',
      configVersion: 2,
      friendLedgerHeaders: ['表示名', 'userId', '登録日'],
    });
    expect(raw.prepare('SELECT friend_field_mappings_json FROM sheets_connections WHERE id = ?').get(created.id))
      .toEqual({ friend_field_mappings_json: JSON.stringify(renamedSnapshot) });

    const movedTarget = await friendLedgerDb.updateSheetsConnection(db, 'acc-1', created.id, {
      spreadsheetId: 'sheet-new',
      sheetName: '新台帳',
      syncDirection: 'from_sheets',
      friendFieldMappings: renamedSnapshot,
    });
    expect(movedTarget).toMatchObject({
      spreadsheetId: 'sheet-new',
      sheetName: '新台帳',
      configVersion: 3,
      friendLedgerHeaders: [],
    });
  });

  test('stores an explicit form-field selection while legacy connections remain all-fields', async () => {
    const legacy = await friendLedgerDb.createSheetsConnection(db, {
      lineAccountId: 'acc-1',
      formId: 'legacy-form',
      spreadsheetId: 'legacy-sheet',
      sheetName: '回答',
      syncDirection: 'bidirectional',
    });
    expect(legacy.selectedFormFieldIds).toBeNull();

    const selected = await friendLedgerDb.createSheetsConnection(db, {
      lineAccountId: 'acc-1',
      formId: 'selected-form',
      spreadsheetId: 'selected-sheet',
      sheetName: '回答',
      syncDirection: 'bidirectional',
      selectedFormFieldIds: ['field-name', 'field-plan'],
    });
    expect(selected.selectedFormFieldIds).toEqual(['field-name', 'field-plan']);
    expect(raw.prepare(`SELECT selected_form_field_ids_json FROM sheets_connections
      WHERE id=?`).get(selected.id)).toEqual({
      selected_form_field_ids_json: '["field-name","field-plan"]',
    });

    const emptySelection = await friendLedgerDb.updateSheetsConnection(db, 'acc-1', selected.id, {
      spreadsheetId: selected.spreadsheetId,
      sheetName: selected.sheetName,
      syncDirection: selected.syncDirection,
      selectedFormFieldIds: [],
    });
    expect(emptySelection?.selectedFormFieldIds).toEqual([]);

    const preserved = await friendLedgerDb.updateSheetsConnection(db, 'acc-1', selected.id, {
      spreadsheetId: selected.spreadsheetId,
      sheetName: selected.sheetName,
      syncDirection: 'to_sheets',
    });
    expect(preserved?.selectedFormFieldIds).toEqual([]);
  });

  test('records form-answer header snapshots only under the active lease and resets them only after a target move', async () => {
    const created = await friendLedgerDb.createSheetsConnection(db, {
      lineAccountId: 'acc-1',
      formId: 'form-answers',
      spreadsheetId: 'sheet-answers',
      sheetName: '回答',
      syncDirection: 'bidirectional',
      friendLedgerEnabled: true,
    });
    const lease = {
      token: 'answer-header-owner',
      now: '2026-07-21T12:00:00+09:00',
    };
    await expect(friendLedgerDb.claimSheetsSyncLock(
      db,
      'acc-1',
      created.id,
      lease.token,
      lease.now,
      '2026-07-21T12:05:00+09:00',
      created.configVersion,
    )).resolves.toBe(true);
    const headers = [
      { fieldId: 'field-name', header: 'お名前' },
      { fieldId: 'field-plan', header: '希望プラン' },
    ];

    await expect(friendLedgerDb.recordSheetsFormAnswerHeaders(
      db, 'acc-2', created.id, created.configVersion, headers, lease,
    )).resolves.toBe(false);
    await expect(friendLedgerDb.recordSheetsFormAnswerHeaders(
      db, 'acc-1', created.id, created.configVersion + 1, headers, lease,
    )).resolves.toBe(false);
    await expect(friendLedgerDb.recordSheetsFormAnswerHeaders(
      db, 'acc-1', created.id, created.configVersion, headers, { ...lease, token: 'other-owner' },
    )).resolves.toBe(false);
    await expect(friendLedgerDb.recordSheetsFormAnswerHeaders(
      db, 'acc-1', created.id, created.configVersion, headers, lease,
    )).resolves.toBe(true);
    await expect(friendLedgerDb.getActiveSheetsConnectionById(db, created.id)).resolves.toMatchObject({
      formAnswerHeaders: headers,
    });

    await friendLedgerDb.releaseSheetsSyncLock(db, 'acc-1', created.id, lease.token);
    const sameTarget = await friendLedgerDb.updateSheetsConnection(db, 'acc-1', created.id, {
      spreadsheetId: 'sheet-answers',
      sheetName: '回答',
      syncDirection: 'to_sheets',
    });
    expect(sameTarget).toMatchObject({ formAnswerHeaders: headers });

    const movedTarget = await friendLedgerDb.updateSheetsConnection(db, 'acc-1', created.id, {
      spreadsheetId: 'sheet-answers',
      sheetName: '新回答',
      syncDirection: 'to_sheets',
    });
    expect(movedTarget).toMatchObject({ formAnswerHeaders: [] });

    await expect(friendLedgerDb.claimSheetsSyncLock(
      db,
      'acc-1',
      created.id,
      lease.token,
      lease.now,
      '2026-07-21T12:05:00+09:00',
      movedTarget!.configVersion,
    )).resolves.toBe(true);
    await expect(friendLedgerDb.recordSheetsFormAnswerHeaders(
      db, 'acc-1', created.id, movedTarget!.configVersion, headers, lease,
    )).resolves.toBe(true);
    await friendLedgerDb.releaseSheetsSyncLock(db, 'acc-1', created.id, lease.token);
    const movedSpreadsheet = await friendLedgerDb.updateSheetsConnection(db, 'acc-1', created.id, {
      spreadsheetId: 'sheet-moved',
      sheetName: '新回答',
      syncDirection: 'to_sheets',
    });
    expect(movedSpreadsheet).toMatchObject({ formAnswerHeaders: [] });
  });

  test('updates observable sync status without changing settings generation and remains tenant-scoped', async () => {
    const created = await createSheetsConnection(db, {
      lineAccountId: 'acc-1', formId: 'friends', spreadsheetId: 'sheet-friends',
      sheetName: '友だち台帳', syncDirection: 'bidirectional',
    });
    const syncedAt = '2026-07-21T10:00:00+09:00';

    await expect(friendLedgerDb.updateSheetsSyncStatus(db, 'acc-2', created.id, {
      status: 'error', lastSyncAt: syncedAt, warning: null, errorCode: 'wrong_tenant',
    })).resolves.toBeNull();
    await expect(friendLedgerDb.updateSheetsSyncStatus(db, 'acc-1', created.id, {
      status: 'warning',
      lastSyncAt: syncedAt,
      warning: '見出し「契約状況」が見つかりません',
      errorCode: 'header_renamed',
    })).resolves.toMatchObject({
      configVersion: 1,
      lastSyncAt: syncedAt,
      lastSyncStatus: 'warning',
      lastSyncWarning: '見出し「契約状況」が見つかりません',
      lastSyncErrorCode: 'header_renamed',
    });

    const cleared = await friendLedgerDb.updateSheetsSyncStatus(db, 'acc-1', created.id, {
      status: 'success', lastSyncAt: '2026-07-21T10:05:00+09:00', warning: null, errorCode: null,
    });
    expect(cleared).toMatchObject({
      configVersion: 1,
      lastSyncStatus: 'success',
      lastSyncWarning: null,
      lastSyncErrorCode: null,
    });
  });

  test('preserves the first error time through retries and keeps an alert pending until success is reported', async () => {
    const created = await createSheetsConnection(db, {
      lineAccountId: 'acc-1', formId: 'friends-alert', spreadsheetId: 'sheet-alert',
      sheetName: '障害監視', syncDirection: 'bidirectional',
    });
    const startedAt = '2026-07-23T10:00:00.000+09:00';
    const alertedAt = '2026-07-23T10:15:00.000+09:00';
    const recoveredAt = '2026-07-23T10:25:00.000+09:00';

    await friendLedgerDb.updateSheetsSyncStatus(db, 'acc-1', created.id, {
      status: 'error', lastSyncAt: startedAt, warning: '接続に失敗しました', errorCode: 'failed',
    });
    await friendLedgerDb.updateSheetsSyncStatus(db, 'acc-1', created.id, {
      status: 'running', lastSyncAt: '2026-07-23T10:05:00.000+09:00', warning: null, errorCode: null,
    });
    await friendLedgerDb.updateSheetsSyncStatus(db, 'acc-1', created.id, {
      status: 'error', lastSyncAt: '2026-07-23T10:10:00.000+09:00',
      warning: '接続に失敗しました', errorCode: 'failed',
    });
    const alertState = () => raw.prepare(`SELECT sync_error_started_at, sync_alerted_at,
      sync_alert_claimed_at, sync_recovery_pending_at
      FROM sheets_connections WHERE id = ?`).get(created.id);
    expect(alertState()).toEqual({
      sync_error_started_at: startedAt,
      sync_alerted_at: null,
      sync_alert_claimed_at: null,
      sync_recovery_pending_at: null,
    });

    raw.prepare('UPDATE sheets_connections SET sync_alerted_at = ? WHERE id = ?')
      .run(alertedAt, created.id);
    await friendLedgerDb.updateSheetsSyncStatus(db, 'acc-1', created.id, {
      status: 'running', lastSyncAt: '2026-07-23T10:20:00.000+09:00', warning: null, errorCode: null,
    });
    expect(alertState()).toEqual({
      sync_error_started_at: startedAt,
      sync_alerted_at: alertedAt,
      sync_alert_claimed_at: null,
      sync_recovery_pending_at: null,
    });

    await friendLedgerDb.updateSheetsSyncStatus(db, 'acc-1', created.id, {
      status: 'success', lastSyncAt: recoveredAt, warning: null, errorCode: null,
    });
    expect(alertState()).toEqual({
      sync_error_started_at: null,
      sync_alerted_at: alertedAt,
      sync_alert_claimed_at: null,
      sync_recovery_pending_at: recoveredAt,
    });

    await friendLedgerDb.updateSheetsSyncStatus(db, 'acc-1', created.id, {
      status: 'error', lastSyncAt: '2026-07-23T10:30:00.000+09:00',
      warning: '別の同期失敗です', errorCode: 'failed_again',
    });
    expect(alertState()).toEqual({
      sync_error_started_at: '2026-07-23T10:30:00.000+09:00',
      sync_alerted_at: null,
      sync_alert_claimed_at: null,
      sync_recovery_pending_at: recoveredAt,
    });

    await friendLedgerDb.updateSheetsSyncStatus(db, 'acc-1', created.id, {
      status: 'warning', lastSyncAt: '2026-07-23T10:35:00.000+09:00',
      warning: '一部を同期できませんでした', errorCode: 'partial',
    });
    expect(alertState()).toEqual({
      sync_error_started_at: null,
      sync_alerted_at: null,
      sync_alert_claimed_at: null,
      sync_recovery_pending_at: null,
    });
  });

  test('lists all active connections across accounts with a hard caller-supplied bound', async () => {
    const first = await createSheetsConnection(db, {
      lineAccountId: 'acc-1', formId: 'friends-a', spreadsheetId: 'sheet-a',
      sheetName: '台帳A', syncDirection: 'bidirectional', friendLedgerEnabled: true,
    });
    const removed = await createSheetsConnection(db, {
      lineAccountId: 'acc-1', formId: 'friends-removed', spreadsheetId: 'sheet-removed',
      sheetName: '削除', syncDirection: 'to_sheets', friendLedgerEnabled: true,
    });
    const second = await createSheetsConnection(db, {
      lineAccountId: 'acc-2', formId: 'friends-b', spreadsheetId: 'sheet-b',
      sheetName: '台帳B', syncDirection: 'from_sheets', friendLedgerEnabled: true,
    });
    const foundationOnly = await createSheetsConnection(db, {
      lineAccountId: 'acc-1', formId: 'foundation-only', spreadsheetId: 'sheet-foundation',
      sheetName: '回答', syncDirection: 'bidirectional',
    });
    await softDeleteSheetsConnection(db, 'acc-1', removed.id);

    const all = await friendLedgerDb.listActiveSheetsConnectionsForSync(db, 100);
    expect(all.map((item) => item.id).sort()).toEqual([first.id, second.id].sort());
    expect(all.map((item) => item.id)).not.toContain(foundationOnly.id);
    expect(new Set(all.map((item) => item.lineAccountId))).toEqual(new Set(['acc-1', 'acc-2']));
    await expect(friendLedgerDb.listActiveSheetsConnectionsForSync(db, 1))
      .resolves.toHaveLength(1);

    await friendLedgerDb.updateSheetsSyncStatus(db, 'acc-1', first.id, {
      status: 'success', lastSyncAt: '2026-07-21T10:10:00+09:00', warning: null, errorCode: null,
    });
    await friendLedgerDb.updateSheetsSyncStatus(db, 'acc-2', second.id, {
      status: 'success', lastSyncAt: '2026-07-21T10:00:00+09:00', warning: null, errorCode: null,
    });
    await expect(friendLedgerDb.listActiveSheetsConnectionsForSync(db, 1))
      .resolves.toEqual([expect.objectContaining({ id: second.id })]);
  });

  test('resolves an active connection by signed webhook id without exposing a soft-deleted target', async () => {
    const created = await createSheetsConnection(db, {
      lineAccountId: 'acc-1', formId: 'friends', spreadsheetId: 'sheet-friends',
      sheetName: '友だち台帳', syncDirection: 'bidirectional',
    });

    await expect(friendLedgerDb.getActiveSheetsConnectionById(db, created.id)).resolves.toMatchObject({
      id: created.id,
      lineAccountId: 'acc-1',
      spreadsheetId: 'sheet-friends',
      isActive: true,
    });
    await softDeleteSheetsConnection(db, 'acc-1', created.id);
    await expect(friendLedgerDb.getActiveSheetsConnectionById(db, created.id)).resolves.toBeNull();
  });

  test('claims and completes each signed webhook event once under its owning connection', async () => {
    const created = await createSheetsConnection(db, {
      lineAccountId: 'acc-1', formId: 'friends-events', spreadsheetId: 'sheet-friends',
      sheetName: '友だち台帳', syncDirection: 'bidirectional', friendLedgerEnabled: true,
    });
    const input = {
      eventId: 'event-0000000001',
      actor: 'editor@example.test',
      actorKind: 'google_email' as const,
      occurredAt: '2026-07-21T10:00:00+09:00',
      payload: { range: { rowStart: 2, rowEnd: 2, columnStart: 4, columnEnd: 4 } },
      receivedAt: '2026-07-21T10:00:01+09:00',
    };

    await expect(friendLedgerDb.enqueueSheetsWebhookEvent(db, 'acc-2', created.id, 1, input))
      .resolves.toBeNull();
    const enqueued = await friendLedgerDb.enqueueSheetsWebhookEvent(db, 'acc-1', created.id, 1, input);
    expect(enqueued).toMatchObject({ sequence: 1, status: 'pending', enqueued: true });
    await expect(friendLedgerDb.enqueueSheetsWebhookEvent(db, 'acc-1', created.id, 1, input))
      .resolves.toEqual({ sequence: 1, status: 'pending', enqueued: false });
    const claimInput = {
      token: 'claim-token-1',
      now: '2026-07-21T10:00:01+09:00',
      expiresAt: '2026-07-21T10:02:01+09:00',
      discardBefore: '2026-07-20T10:00:01+09:00',
      maxAttempts: 5,
    };
    await expect(friendLedgerDb.claimNextSheetsWebhookEvent(
      db, 'acc-2', created.id, 1, claimInput,
    )).resolves.toBeNull();
    await expect(friendLedgerDb.claimNextSheetsWebhookEvent(
      db, 'acc-1', created.id, 1, claimInput,
    )).resolves.toEqual(expect.objectContaining({
      eventId: input.eventId,
      actor: input.actor,
      payload: input.payload,
      attempts: 0,
      processingToken: claimInput.token,
    }));
    await friendLedgerDb.enqueueSheetsWebhookEvent(db, 'acc-1', created.id, 1, {
      ...input,
      eventId: 'event-0000000002',
    });
    await expect(friendLedgerDb.claimNextSheetsWebhookEvent(
      db, 'acc-1', created.id, 1, { ...claimInput, token: 'claim-token-2' },
    )).resolves.toBeNull();
    const reclaimed = {
      ...claimInput,
      token: 'claim-token-2',
      now: '2026-07-21T10:02:02+09:00',
      expiresAt: '2026-07-21T10:04:02+09:00',
    };
    await expect(friendLedgerDb.claimNextSheetsWebhookEvent(
      db, 'acc-1', created.id, 1, reclaimed,
    )).resolves.toEqual(expect.objectContaining({ processingToken: reclaimed.token }));
    await expect(friendLedgerDb.finishSheetsWebhookEvent(
      db, 'acc-2', created.id, 1, input.eventId,
      {
        processingToken: claimInput.token,
        status: 'applied', completedAt: '2026-07-21T10:00:02+09:00', errorCode: null,
      },
    )).resolves.toBe(false);
    await expect(friendLedgerDb.finishSheetsWebhookEvent(
      db, 'acc-1', created.id, 1, input.eventId,
      {
        processingToken: 'wrong-token',
        status: 'applied', completedAt: '2026-07-21T10:00:02+09:00', errorCode: null,
      },
    )).resolves.toBe(false);
    await expect(friendLedgerDb.finishSheetsWebhookEvent(
      db, 'acc-1', created.id, 1, input.eventId,
      {
        processingToken: reclaimed.token,
        status: 'applied', completedAt: '2026-07-21T10:00:02+09:00', errorCode: null,
      },
    )).resolves.toBe(true);
    await expect(friendLedgerDb.enqueueSheetsWebhookEvent(db, 'acc-1', created.id, 1, input))
      .resolves.toEqual({ sequence: 1, status: 'applied', enqueued: false });
    expect(raw.prepare(`SELECT status, payload_json, actor, actor_kind, attempts, processing_token
      FROM sheets_sync_webhook_events
      WHERE connection_id=? AND event_id=?`).get(created.id, input.eventId)).toEqual({
      status: 'applied', payload_json: null, actor: 'redacted', actor_kind: 'unavailable',
      attempts: 0, processing_token: null,
    });

    await friendLedgerDb.updateSheetsConnection(db, 'acc-1', created.id, {
      spreadsheetId: 'sheet-friends',
      sheetName: '友だち台帳',
      syncDirection: 'to_sheets',
      friendLedgerEnabled: true,
    });
    expect(raw.prepare(`SELECT status, payload_json, actor, last_error_code
      FROM sheets_sync_webhook_events WHERE connection_id=? AND event_id=?`)
      .get(created.id, 'event-0000000002')).toEqual({
      status: 'dead', payload_json: null, actor: 'redacted', last_error_code: 'connection_changed',
    });
  });

  test('expires old webhook PII globally but never fences an unexpired event claim', async () => {
    const created = await createSheetsConnection(db, {
      lineAccountId: 'acc-1', formId: 'friends-expiry', spreadsheetId: 'sheet-friends',
      sheetName: '友だち台帳', syncDirection: 'bidirectional', friendLedgerEnabled: true,
    });
    const event = {
      eventId: 'event-expiry-000001',
      actor: 'editor-expiry@example.test',
      actorKind: 'google_email' as const,
      occurredAt: '2026-07-21T09:59:00+09:00',
      payload: { snapshot: { value: 'private-cell-value' } },
      receivedAt: '2026-07-21T09:59:01+09:00',
    };
    await friendLedgerDb.enqueueSheetsWebhookEvent(db, 'acc-1', created.id, 1, event);
    await friendLedgerDb.claimNextSheetsWebhookEvent(db, 'acc-1', created.id, 1, {
      token: 'long-running-claim',
      now: '2026-07-21T10:00:00+09:00',
      expiresAt: '2026-07-21T10:02:00+09:00',
      discardBefore: '2026-07-20T10:00:00+09:00',
      maxAttempts: 5,
    });
    raw.prepare(`UPDATE sheets_sync_webhook_events SET received_at='2026-07-19T10:00:01+09:00'
      WHERE event_id=?`).run(event.eventId);

    await expect(friendLedgerDb.expireSheetsWebhookEvents(db, {
      now: '2026-07-21T10:01:00+09:00',
      discardBefore: '2026-07-20T10:01:00+09:00',
      maxAttempts: 5,
      limit: 100,
    })).resolves.toBe(0);
    expect(raw.prepare(`SELECT status, actor FROM sheets_sync_webhook_events
      WHERE event_id=?`).get(event.eventId)).toEqual({
      status: 'pending', actor: event.actor,
    });

    await expect(friendLedgerDb.expireSheetsWebhookEvents(db, {
      now: '2026-07-21T10:03:00+09:00',
      discardBefore: '2026-07-20T10:03:00+09:00',
      maxAttempts: 5,
      limit: 100,
    })).resolves.toBe(1);
    expect(raw.prepare(`SELECT status, actor, actor_kind, payload_json, processing_token
      FROM sheets_sync_webhook_events WHERE event_id=?`).get(event.eventId)).toEqual({
      status: 'dead', actor: 'redacted', actor_kind: 'unavailable', payload_json: null,
      processing_token: null,
    });
    await expect(friendLedgerDb.purgeSheetsWebhookEventTombstones(db, {
      completedBefore: '2026-07-21T10:04:00+09:00',
      limit: 100,
    })).resolves.toBe(1);
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sheets_sync_webhook_events
      WHERE event_id=?`).get(event.eventId)).toEqual({ count: 0 });
  });

  test('claims an expiring sync lock atomically and releases only the owning tenant/token', async () => {
    const created = await createSheetsConnection(db, {
      lineAccountId: 'acc-1', formId: 'friends', spreadsheetId: 'sheet-friends',
      sheetName: '友だち台帳', syncDirection: 'bidirectional',
    });

    await expect(friendLedgerDb.claimSheetsSyncLock(
      db, 'acc-1', created.id, 'lock-owner',
      '2026-07-21T10:00:00+09:00', '2026-07-21T10:05:00+09:00',
    )).resolves.toBe(true);
    await expect(friendLedgerDb.claimSheetsSyncLock(
      db, 'acc-1', created.id, 'lock-racer',
      '2026-07-21T10:01:00+09:00', '2026-07-21T10:06:00+09:00',
    )).resolves.toBe(false);
    await expect(friendLedgerDb.releaseSheetsSyncLock(db, 'acc-2', created.id, 'lock-owner'))
      .resolves.toBe(false);
    await expect(friendLedgerDb.releaseSheetsSyncLock(db, 'acc-1', created.id, 'wrong-token'))
      .resolves.toBe(false);

    // A crashed worker cannot hold the connection forever: a later caller may
    // atomically replace an expired token, while the stale owner cannot release it.
    await expect(friendLedgerDb.claimSheetsSyncLock(
      db, 'acc-1', created.id, 'lock-after-expiry',
      '2026-07-21T10:05:01+09:00', '2026-07-21T10:10:01+09:00',
    )).resolves.toBe(true);
    await expect(friendLedgerDb.releaseSheetsSyncLock(db, 'acc-1', created.id, 'lock-owner'))
      .resolves.toBe(false);
    await expect(friendLedgerDb.releaseSheetsSyncLock(db, 'acc-1', created.id, 'lock-after-expiry'))
      .resolves.toBe(true);
    expect(raw.prepare(`SELECT sync_lock_token, sync_lock_expires_at FROM sheets_connections
      WHERE id = ?`).get(created.id)).toEqual({ sync_lock_token: null, sync_lock_expires_at: null });
  });

  test('rejects guarded state mutations after lease ownership changes or expires', async () => {
    const created = await createSheetsConnection(db, {
      lineAccountId: 'acc-1', formId: 'friends-guard', spreadsheetId: 'sheet-friends',
      sheetName: '友だち台帳', syncDirection: 'bidirectional',
    });
    await friendLedgerDb.claimSheetsSyncLock(
      db, 'acc-1', created.id, 'current-worker',
      '2026-07-21T10:00:00+09:00', '2026-07-21T10:05:00+09:00', 1,
    );
    const status = {
      status: 'success' as const,
      lastSyncAt: '2026-07-21T10:01:00+09:00',
      warning: null,
      errorCode: null,
    };

    await expect(friendLedgerDb.updateSheetsSyncStatus(
      db, 'acc-1', created.id, status,
      { token: 'stale-worker', now: '2026-07-21T10:01:00+09:00' },
    )).resolves.toBeNull();
    await expect(friendLedgerDb.recordSheetsFriendLedgerHeaders(
      db, 'acc-1', created.id, 1, ['表示名', 'userId'],
      { token: 'stale-worker', now: '2026-07-21T10:01:00+09:00' },
    )).resolves.toBe(false);
    const guardedReserve = reserveSheetsSyncSequence as unknown as (
      ...args: [D1Database, string, string, number, { token: string; now: string }]
    ) => Promise<number | null>;
    await expect(guardedReserve(
      db, 'acc-1', created.id, 1,
      { token: 'stale-worker', now: '2026-07-21T10:01:00+09:00' },
    )).resolves.toBeNull();
    await expect(guardedReserve(
      db, 'acc-1', created.id, 1,
      { token: 'current-worker', now: '2026-07-21T10:05:01+09:00' },
    )).resolves.toBeNull();
    await expect(guardedReserve(
      db, 'acc-1', created.id, 1,
      { token: 'current-worker', now: '2026-07-21T10:01:00+09:00' },
    )).resolves.toBe(1);
    await expect(friendLedgerDb.recordSheetsFriendLedgerHeaders(
      db, 'acc-1', created.id, 1, ['表示名', 'userId'],
      { token: 'current-worker', now: '2026-07-21T10:01:00+09:00' },
    )).resolves.toBe(true);
    await expect(friendLedgerDb.getActiveSheetsConnectionById(db, created.id))
      .resolves.toMatchObject({ friendLedgerHeaders: ['表示名', 'userId'] });
  });

  test('binds a sync lock to the captured settings generation and blocks target changes while held', async () => {
    const created = await createSheetsConnection(db, {
      lineAccountId: 'acc-1', formId: 'friends-lock', spreadsheetId: 'sheet-before',
      sheetName: '台帳', syncDirection: 'bidirectional',
    });
    const acquiredAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();

    await expect(friendLedgerDb.claimSheetsSyncLock(
      db, 'acc-1', created.id, 'stale-generation',
      acquiredAt, expiresAt, 2,
    )).resolves.toBe(false);
    await expect(friendLedgerDb.claimSheetsSyncLock(
      db, 'acc-1', created.id, 'current-generation',
      acquiredAt, expiresAt, 1,
    )).resolves.toBe(true);
    await expect(updateSheetsConnection(db, 'acc-1', created.id, {
      spreadsheetId: 'sheet-after', sheetName: '台帳', syncDirection: 'to_sheets',
    })).resolves.toBeNull();
    await expect(softDeleteSheetsConnection(db, 'acc-1', created.id)).resolves.toBe(false);
    await friendLedgerDb.releaseSheetsSyncLock(db, 'acc-1', created.id, 'current-generation');
    await expect(updateSheetsConnection(db, 'acc-1', created.id, {
      spreadsheetId: 'sheet-after', sheetName: '台帳', syncDirection: 'to_sheets',
    })).resolves.toMatchObject({ spreadsheetId: 'sheet-after', configVersion: 2 });
  });

  test('upserts and lists canonical ledger snapshots only through the owning tenant and active generation', async () => {
    const created = await createSheetsConnection(db, {
      lineAccountId: 'acc-1', formId: 'friends', spreadsheetId: 'sheet-friends',
      sheetName: '友だち台帳', syncDirection: 'bidirectional',
    });
    const initial: Parameters<FriendLedgerDbContract['upsertSheetsSyncLedger']>[2] = {
      connectionId: created.id,
      connectionVersion: 1,
      recordKey: 'friend-ayako',
      sheetRowNumber: 2,
      rowFingerprint: 'fingerprint-1',
      canonicalSnapshot: { 'ユーザーID': 'U-ayako', '表示名': 'あやこ', '契約状況': '未' },
      harnessUpdatedAt: '2026-07-21T10:00:00+09:00',
      sheetObservedAt: '2026-07-21T10:00:01+09:00',
      lastSyncedAt: '2026-07-21T10:00:02+09:00',
      lastSyncDirection: 'to_sheets',
      lastAppliedSequence: 1,
    };

    await expect(friendLedgerDb.upsertSheetsSyncLedger(db, 'acc-2', initial)).resolves.toBe(false);
    await expect(friendLedgerDb.upsertSheetsSyncLedger(db, 'acc-1', { ...initial, connectionVersion: 2 }))
      .resolves.toBe(false);
    await expect(friendLedgerDb.upsertSheetsSyncLedger(db, 'acc-1', initial)).resolves.toBe(true);
    await expect(friendLedgerDb.listSheetsSyncLedger(db, 'acc-2', created.id)).resolves.toEqual([]);
    await expect(friendLedgerDb.listSheetsSyncLedger(db, 'acc-1', created.id)).resolves.toEqual([
      { ...initial, version: 1 },
    ]);

    const next = {
      ...initial,
      rowFingerprint: 'fingerprint-2',
      canonicalSnapshot: { ...initial.canonicalSnapshot, '契約状況': '済' },
      sheetObservedAt: '2026-07-21T10:05:01+09:00',
      lastSyncedAt: '2026-07-21T10:05:02+09:00',
      lastSyncDirection: 'from_sheets' as const,
      lastAppliedSequence: 2,
    };
    await expect(friendLedgerDb.upsertSheetsSyncLedger(db, 'acc-1', next)).resolves.toBe(true);
    await expect(friendLedgerDb.listSheetsSyncLedger(db, 'acc-1', created.id)).resolves.toEqual([
      { ...next, version: 2 },
    ]);
    expect(raw.prepare(`SELECT canonical_snapshot_json FROM sheets_sync_ledger
      WHERE connection_id = ? AND record_key = ?`).get(created.id, 'friend-ayako'))
      .toEqual({ canonical_snapshot_json: JSON.stringify(next.canonicalSnapshot) });

    await expect(friendLedgerDb.upsertSheetsSyncLedger(db, 'acc-1', {
      ...initial,
      rowFingerprint: 'stale-fingerprint',
      lastAppliedSequence: 1,
    })).resolves.toBe(false);
    await expect(friendLedgerDb.listSheetsSyncLedger(db, 'acc-1', created.id)).resolves.toEqual([
      { ...next, version: 2 },
    ]);
  });

  test('clears row positions only for the owning active generation before a safe reorder', async () => {
    const created = await createSheetsConnection(db, {
      lineAccountId: 'acc-1', formId: 'friends-reorder', spreadsheetId: 'sheet-friends',
      sheetName: '友だち台帳', syncDirection: 'bidirectional', friendLedgerEnabled: true,
    });
    for (const [recordKey, row] of [['friend-a', 2], ['friend-b', 3]] as const) {
      await friendLedgerDb.upsertSheetsSyncLedger(db, 'acc-1', {
        connectionId: created.id, connectionVersion: 1, recordKey, sheetRowNumber: row,
        rowFingerprint: `fingerprint-${recordKey}`, canonicalSnapshot: {}, harnessUpdatedAt: null,
        sheetObservedAt: null, lastSyncedAt: '2026-07-21T10:00:00+09:00',
        lastSyncDirection: 'to_sheets', lastAppliedSequence: row,
      });
    }

    await expect(friendLedgerDb.clearSheetsSyncLedgerRowNumbers(db, 'acc-2', created.id, 1, ['friend-a']))
      .resolves.toBe(false);
    await expect(friendLedgerDb.clearSheetsSyncLedgerRowNumbers(db, 'acc-1', created.id, 2, ['friend-a']))
      .resolves.toBe(false);
    await expect(friendLedgerDb.clearSheetsSyncLedgerRowNumbers(db, 'acc-1', created.id, 1, ['friend-a']))
      .resolves.toBe(true);
    expect(raw.prepare('SELECT sheet_row_number FROM sheets_sync_ledger WHERE connection_id=?').all(created.id))
      .toEqual([{ sheet_row_number: null }, { sheet_row_number: 3 }]);
  });

  test('appends and lists parent audit events with immutable per-column details under tenant scope', async () => {
    const created = await createSheetsConnection(db, {
      lineAccountId: 'acc-1', formId: 'friends', spreadsheetId: 'sheet-friends',
      sheetName: '友だち台帳', syncDirection: 'bidirectional',
    });
    const firstAudit: Parameters<FriendLedgerDbContract['appendSheetsSyncAudit']>[2] = {
      id: 'audit-1',
      connectionId: created.id,
      connectionVersion: 1,
      applySequence: 1,
      recordKey: 'friend-ayako',
      sheetRowNumber: 2,
      direction: 'from_sheets',
      action: 'update',
      outcome: 'applied',
      conflictResolution: null,
      harnessUpdatedAt: '2026-07-21T10:00:00+09:00',
      sheetObservedAt: '2026-07-21T10:00:01+09:00',
      beforeFingerprint: 'before-1',
      afterFingerprint: 'after-1',
      errorCode: null,
      webhookEventId: 'event-audit-000001',
      details: [{
        id: 'detail-1',
        actor: 'editor@example.com',
        fieldName: '契約状況',
        oldValue: '未',
        newValue: '済',
        source: 'webhook',
        changeKind: 'custom_field',
      }],
    };

    await expect(friendLedgerDb.appendSheetsSyncAudit(db, 'acc-2', firstAudit)).resolves.toBe(false);
    await expect(friendLedgerDb.appendSheetsSyncAudit(db, 'acc-1', firstAudit)).resolves.toBe(true);
    const secondAudit: Parameters<FriendLedgerDbContract['appendSheetsSyncAudit']>[2] = {
      ...firstAudit,
      id: 'audit-2',
      applySequence: 2,
      action: 'conflict',
      outcome: 'skipped',
      errorCode: 'identity_read_only',
      webhookEventId: null,
      details: [{
        id: 'detail-2',
        actor: 'system_poll',
        fieldName: 'ユーザーID',
        oldValue: 'U-ayako',
        newValue: 'tampered',
        source: 'polling',
        changeKind: 'identity_ignored',
      }],
    };
    await expect(friendLedgerDb.appendSheetsSyncAudit(db, 'acc-1', secondAudit)).resolves.toBe(true);

    await expect(friendLedgerDb.listSheetsSyncAudit(db, 'acc-2', created.id)).resolves.toEqual([]);
    const latest = await friendLedgerDb.listSheetsSyncAudit(db, 'acc-1', created.id, { limit: 1 });
    expect(latest).toHaveLength(1);
    expect(latest[0]).toMatchObject({
      id: 'audit-2',
      connectionId: created.id,
      lineAccountId: 'acc-1',
      formId: 'friends',
      spreadsheetId: 'sheet-friends',
      sheetName: '友だち台帳',
      errorCode: 'identity_read_only',
      webhookEventId: null,
      details: [{
        id: 'detail-2',
        actor: 'system_poll',
        fieldName: 'ユーザーID',
        oldValue: 'U-ayako',
        newValue: 'tampered',
        source: 'polling',
        changeKind: 'identity_ignored',
      }],
    });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM sheets_sync_audit_log').get()).toEqual({ count: 2 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM sheets_sync_audit_details').get()).toEqual({ count: 2 });
  });

  test('commits a row audit and its canonical ledger baseline atomically', async () => {
    const created = await createSheetsConnection(db, {
      lineAccountId: 'acc-1', formId: 'friends-atomic', spreadsheetId: 'sheet-friends',
      sheetName: '友だち台帳', syncDirection: 'bidirectional', friendLedgerEnabled: true,
    });
    const audit = {
      id: 'audit-atomic',
      connectionId: created.id,
      connectionVersion: 1,
      applySequence: 1,
      recordKey: 'friend-atomic',
      sheetRowNumber: 2,
      direction: 'from_sheets' as const,
      action: 'update' as const,
      outcome: 'applied' as const,
      conflictResolution: null,
      harnessUpdatedAt: '2026-07-21T10:00:00+09:00',
      sheetObservedAt: '2026-07-21T10:00:01+09:00',
      beforeFingerprint: null,
      afterFingerprint: 'fingerprint-atomic',
      errorCode: null,
      details: [],
    };
    const ledger = {
      connectionId: created.id,
      connectionVersion: 1,
      recordKey: 'friend-atomic',
      sheetRowNumber: 2,
      rowFingerprint: 'fingerprint-atomic',
      canonicalSnapshot: { 'custom:field': '済' },
      harnessUpdatedAt: audit.harnessUpdatedAt,
      sheetObservedAt: audit.sheetObservedAt,
      lastSyncedAt: audit.sheetObservedAt,
      lastSyncDirection: 'from_sheets' as const,
      lastAppliedSequence: 1,
    };

    await expect(friendLedgerDb.commitSheetsSyncRow(db, 'acc-1', { audit, ledger })).resolves.toBe(true);
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sheets_sync_audit_log
      WHERE id='audit-atomic'`).get()).toEqual({ count: 1 });
    expect(raw.prepare(`SELECT canonical_snapshot_json FROM sheets_sync_ledger
      WHERE record_key='friend-atomic'`).get()).toEqual({
      canonical_snapshot_json: JSON.stringify(ledger.canonicalSnapshot),
    });

    await expect(friendLedgerDb.commitSheetsSyncRow(db, 'acc-1', {
      audit: { ...audit, id: 'audit-must-rollback', applySequence: 2 },
      ledger: {
        ...ledger,
        lastAppliedSequence: 2,
        canonicalSnapshot: [] as unknown as Record<string, CanonicalCellValue>,
      },
    })).rejects.toThrow(/CHECK constraint failed/i);
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sheets_sync_audit_log
      WHERE id='audit-must-rollback'`).get()).toEqual({ count: 0 });

    await expect(friendLedgerDb.upsertSheetsSyncLedger(db, 'acc-1', {
      ...ledger,
      lastAppliedSequence: 3,
    })).resolves.toBe(true);
    await expect(friendLedgerDb.commitSheetsSyncRow(db, 'acc-1', {
      audit: { ...audit, id: 'audit-older-ledger', applySequence: 2 },
      ledger: { ...ledger, lastAppliedSequence: 2 },
    })).resolves.toBe(false);
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sheets_sync_audit_log
      WHERE id='audit-older-ledger'`).get()).toEqual({ count: 0 });
    expect(raw.prepare(`SELECT last_applied_sequence FROM sheets_sync_ledger
      WHERE record_key='friend-atomic'`).get()).toEqual({ last_applied_sequence: 3 });

    await expect(friendLedgerDb.commitSheetsSyncRow(db, 'acc-1', {
      audit: { ...audit, id: 'audit-wrong-lease', applySequence: 4 },
      ledger: { ...ledger, lastAppliedSequence: 4 },
    }, {
      token: 'not-the-owner',
      now: '2026-07-21T12:00:00+09:00',
    })).resolves.toBe(false);
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sheets_sync_audit_log
      WHERE id='audit-wrong-lease'`).get()).toEqual({ count: 0 });
    expect(raw.prepare(`SELECT last_applied_sequence FROM sheets_sync_ledger
      WHERE record_key='friend-atomic'`).get()).toEqual({ last_applied_sequence: 3 });

    await expect(friendLedgerDb.commitSheetsSyncRow(db, 'acc-1', {
      audit: { ...audit, id: 'audit-mismatch', afterFingerprint: 'different' },
      ledger,
    })).rejects.toThrow('sheets_sync_row_commit_mismatch');
  });
});
