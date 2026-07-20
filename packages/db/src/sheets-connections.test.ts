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
  reserveSheetsSyncSequence,
  softDeleteSheetsConnection,
  updateSheetsConnection,
} = sheetsConnectionDb;

type FriendFieldMapping = { fieldId: string; header: string };
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
  ): Promise<FriendLedgerConnectionContract | null>;
  listActiveSheetsConnectionsForSync(
    db: D1Database,
    limit: number,
  ): Promise<FriendLedgerConnectionContract[]>;
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
  listSheetsSyncLedger(
    db: D1Database,
    lineAccountId: string,
    connectionId: string,
  ): Promise<SheetsSyncLedgerContract[]>;
  upsertSheetsSyncLedger(
    db: D1Database,
    lineAccountId: string,
    entry: Omit<SheetsSyncLedgerContract, 'version'>,
  ): Promise<boolean>;
  appendSheetsSyncAudit(
    db: D1Database,
    lineAccountId: string,
    entry: Omit<
      SheetsSyncAuditContract,
      'lineAccountId' | 'formId' | 'spreadsheetId' | 'sheetName' | 'createdAt'
    >,
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

  test('every account-scoped settings save advances its generation and resets the old row ledger', async () => {
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
    expect(raw.prepare('SELECT COUNT(*) AS count FROM sheets_sync_ledger WHERE connection_id=?').get(created.id))
      .toEqual({ count: 0 });
    raw.prepare(`INSERT INTO sheets_sync_ledger
      (connection_id, connection_version, record_key, row_fingerprint, last_synced_at,
       last_sync_direction, last_applied_sequence)
      VALUES (?, 2, 'record-2', 'fingerprint-2', '2026-07-20T00:01:00+09:00', 'to_sheets', 2)`).run(created.id);

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
      lastSyncAt: null,
      lastSyncStatus: 'idle',
      lastSyncWarning: null,
      lastSyncErrorCode: null,
    });
    expect(raw.prepare('SELECT friend_field_mappings_json FROM sheets_connections WHERE id = ?').get(created.id))
      .toEqual({ friend_field_mappings_json: JSON.stringify(initialMappings) });

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
    });
    expect(raw.prepare('SELECT friend_field_mappings_json FROM sheets_connections WHERE id = ?').get(created.id))
      .toEqual({ friend_field_mappings_json: JSON.stringify(renamedSnapshot) });
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

  test('binds a sync lock to the captured settings generation and blocks target changes while held', async () => {
    const created = await createSheetsConnection(db, {
      lineAccountId: 'acc-1', formId: 'friends-lock', spreadsheetId: 'sheet-before',
      sheetName: '台帳', syncDirection: 'bidirectional',
    });

    await expect(friendLedgerDb.claimSheetsSyncLock(
      db, 'acc-1', created.id, 'stale-generation',
      '2026-07-21T10:00:00+09:00', '2026-07-21T10:05:00+09:00', 2,
    )).resolves.toBe(false);
    await expect(friendLedgerDb.claimSheetsSyncLock(
      db, 'acc-1', created.id, 'current-generation',
      '2026-07-21T10:00:00+09:00', '2026-07-21T10:05:00+09:00', 1,
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
});
