import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  createSheetsConnection,
  getSheetsConnection,
  listSheetsConnections,
  softDeleteSheetsConnection,
  updateSheetsConnection,
} from './sheets-connections.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
        async run() {
          const result = statement.run(...(params as never[]));
          return { meta: { changes: result.changes } };
        },
      };
      return api;
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

    expect(await getSheetsConnection(db, first.id)).toMatchObject({
      id: first.id,
      lineAccountId: 'acc-1',
      formId: 'form-1',
      spreadsheetId: 'sheet-1',
      sheetName: '回答',
      syncDirection: 'bidirectional',
      conflictPolicy: 'last_write_wins',
      isActive: true,
    });
    expect((await listSheetsConnections(db, 'acc-1')).map((item) => item.formId).sort()).toEqual(['form-1', 'form-2']);
    expect((await listSheetsConnections(db, 'acc-1', 'form-2')).map((item) => item.formId)).toEqual(['form-2']);
  });

  test('update changes only mutable sheet settings', async () => {
    const created = await createSheetsConnection(db, {
      lineAccountId: 'acc-1', formId: 'form-1', spreadsheetId: 'sheet-old',
      sheetName: '旧', syncDirection: 'to_sheets',
    });
    const updated = await updateSheetsConnection(db, created.id, {
      spreadsheetId: 'sheet-new', sheetName: '新', syncDirection: 'from_sheets',
    });
    expect(updated).toMatchObject({
      id: created.id,
      lineAccountId: 'acc-1',
      formId: 'form-1',
      spreadsheetId: 'sheet-new',
      sheetName: '新',
      syncDirection: 'from_sheets',
    });
    expect(await updateSheetsConnection(db, 'missing', {
      spreadsheetId: 'x', sheetName: 'x', syncDirection: 'bidirectional',
    })).toBeNull();
  });

  test('soft delete hides the connection while retaining its row for audit history', async () => {
    const created = await createSheetsConnection(db, {
      lineAccountId: 'acc-1', formId: 'form-1', spreadsheetId: 'sheet-1',
      sheetName: '回答', syncDirection: 'bidirectional',
    });
    expect(await softDeleteSheetsConnection(db, created.id)).toBe(true);
    expect(await getSheetsConnection(db, created.id)).toBeNull();
    expect(await listSheetsConnections(db, 'acc-1')).toEqual([]);
    expect(raw.prepare('SELECT is_active, deleted_at FROM sheets_connections WHERE id=?').get(created.id))
      .toMatchObject({ is_active: 0, deleted_at: expect.any(String) });
    expect(await softDeleteSheetsConnection(db, created.id)).toBe(false);
  });
});
