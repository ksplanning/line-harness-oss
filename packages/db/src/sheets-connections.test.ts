import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  createSheetsConnection,
  getSheetsConnection,
  listSheetsConnections,
  reserveSheetsSyncSequence,
  softDeleteSheetsConnection,
  updateSheetsConnection,
} from './sheets-connections.js';

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
});
