import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import { createSheetsConnection, getSheetsConnection, type SheetsConnection } from '@line-crm/db';
import type { SheetCellValue, SheetsDataUpdate } from './google-sheets.js';
import { syncFriendLedger } from './friend-ledger-sync.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');

type MockStatement = D1PreparedStatement & { __exec: () => { meta: { changes: number } } };

function d1(raw: Database.Database): D1Database {
  const prepare = (sql: string): MockStatement => {
    const statement = raw.prepare(sql);
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
      return raw.transaction((items: MockStatement[]) => items.map((item) => item.__exec()))(statements);
    },
  } as unknown as D1Database;
}

function columnIndex(label: string): number {
  let result = 0;
  for (const char of label) result = result * 26 + char.charCodeAt(0) - 64;
  return result - 1;
}

function parseA1(range: string): { row: number; column: number } {
  const cell = range.slice(range.lastIndexOf('!') + 1).split(':')[0];
  const match = /^([A-Z]+)(\d+)$/.exec(cell);
  if (!match) throw new Error(`Unsupported range: ${range}`);
  return { column: columnIndex(match[1]), row: Number(match[2]) - 1 };
}

class FakeSheetsClient {
  values: SheetCellValue[][] = [];
  readonly writes: Array<{ kind: 'update' | 'append' | 'batch'; range?: string }> = [];

  async readValues() {
    return { majorDimension: 'ROWS' as const, values: this.values.map((row) => [...row]) };
  }

  async updateValues(_spreadsheetId: string, range: string, values: SheetCellValue[][]) {
    this.writes.push({ kind: 'update', range });
    this.apply(range, values);
    return { spreadsheetId: 'sheet-1', updatedRows: values.length };
  }

  async appendValues(_spreadsheetId: string, range: string, values: SheetCellValue[][]) {
    this.writes.push({ kind: 'append', range });
    this.values.push(...values.map((row) => [...row]));
    return { spreadsheetId: 'sheet-1' };
  }

  async batchUpdateValues(_spreadsheetId: string, data: SheetsDataUpdate[]) {
    this.writes.push({ kind: 'batch' });
    for (const update of data) this.apply(update.range, update.values);
    return { spreadsheetId: 'sheet-1', totalUpdatedRows: data.length };
  }

  private apply(range: string, values: SheetCellValue[][]): void {
    const start = parseA1(range);
    values.forEach((sourceRow, rowOffset) => {
      const rowIndex = start.row + rowOffset;
      while (this.values.length <= rowIndex) this.values.push([]);
      sourceRow.forEach((value, columnOffset) => {
        this.values[rowIndex][start.column + columnOffset] = value;
      });
    });
  }
}

let raw: Database.Database;
let db: D1Database;
let client: FakeSheetsClient;
let connection: SheetsConnection;

function metadata(friendId = 'friend-ayako'): Record<string, unknown> {
  const row = raw.prepare('SELECT metadata FROM friends WHERE id=?').get(friendId) as { metadata: string };
  return JSON.parse(row.metadata) as Record<string, unknown>;
}

async function run(source: 'manual' | 'polling' | 'webhook' = 'manual', actor = 'owner') {
  connection = (await getSheetsConnection(db, 'acc-1', connection.id))!;
  return syncFriendLedger({
    db,
    connection,
    client,
    source,
    actor,
    now: () => new Date('2026-07-21T03:00:00.000Z'),
  });
}

beforeEach(async () => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  raw.exec(readFileSync(join(DB_ROOT, 'bootstrap.sql'), 'utf8'));
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('acc-1', 'channel-1', 'A', 'token', 'secret'), ('acc-2', 'channel-2', 'B', 'token', 'secret')`).run();
  raw.prepare(`INSERT INTO friend_field_definitions
    (id, name, default_value, display_order, is_active)
    VALUES ('field-paid', '入金確認', '未', 1, 1), ('field-note', '担当メモ', '', 2, 1)`).run();
  raw.prepare(`INSERT INTO friends
    (id, line_user_id, display_name, line_account_id, metadata, created_at, updated_at)
    VALUES
    ('friend-ayako', 'U_AYAKO', 'あやこ', 'acc-1', '{"入金確認":"未","未選択":"保持"}', '2026-07-20T10:00:00+09:00', '2026-07-20T10:00:00+09:00'),
    ('friend-other', 'U_OTHER', '別人', 'acc-2', '{"入金確認":"別"}', '2026-07-20T11:00:00+09:00', '2026-07-20T11:00:00+09:00')`).run();
  db = d1(raw);
  client = new FakeSheetsClient();
  connection = await createSheetsConnection(db, {
    lineAccountId: 'acc-1',
    formId: 'friend-ledger',
    spreadsheetId: 'sheet-1',
    sheetName: '友だち台帳',
    syncDirection: 'bidirectional',
    friendFieldMappings: [{ fieldId: 'field-paid', header: '入金確認' }],
    friendLedgerEnabled: true,
  });
});

describe('friend ledger bidirectional sync', () => {
  test('creates headings/full rows once, stays tenant-scoped, and writes nothing on an identical retry', async () => {
    const first = await run();
    expect(client.values).toEqual([
      ['表示名', 'userId', '登録日', '入金確認'],
      ['あやこ', 'U_AYAKO', '2026-07-20T10:00:00+09:00', '未'],
    ]);
    expect(first).toMatchObject({ appendedRows: 1, importedFields: 0, status: 'success' });
    expect(client.values.flat()).not.toContain('U_OTHER');
    const writesAfterFirst = client.writes.length;

    const second = await run('polling', 'system_poll');
    expect(second).toMatchObject({ appendedRows: 0, updatedRows: 0, importedFields: 0 });
    expect(client.writes).toHaveLength(writesAfterFirst);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM sheets_sync_ledger').get()).toEqual({ count: 1 });
  });

  test('uses heading names after reorder/insertion and never overwrites a company column', async () => {
    await run();
    client.values = [
      ['自社担当', '入金確認', '登録日', '表示名', 'userId'],
      ['営業部', '未', '2026-07-20T10:00:00+09:00', 'あやこ', 'U_AYAKO'],
    ];
    raw.prepare(`UPDATE friends SET metadata='{"入金確認":"済","未選択":"保持"}',
      updated_at='2026-07-21T11:00:00+09:00' WHERE id='friend-ayako'`).run();

    const result = await run('polling', 'system_poll');

    expect(result.updatedRows).toBe(1);
    expect(client.values[1]).toEqual(['営業部', '済', '2026-07-20T10:00:00+09:00', 'あやこ', 'U_AYAKO']);
  });

  test('reassigns ledger row positions safely after friends are reordered by exact userId', async () => {
    raw.prepare(`INSERT INTO friends
      (id, line_user_id, display_name, line_account_id, metadata, created_at, updated_at)
      VALUES ('friend-b', 'U_B', 'びー', 'acc-1', '{"入金確認":"済"}',
              '2026-07-20T11:00:00+09:00', '2026-07-20T11:00:00+09:00')`).run();
    await run();
    client.values = [client.values[0], client.values[2], client.values[1]];

    const result = await run('polling', 'system_poll');

    expect(result).toMatchObject({ importedFields: 0, ignoredIdentityEdits: 0 });
    expect(raw.prepare(`SELECT record_key, sheet_row_number FROM sheets_sync_ledger
      ORDER BY record_key`).all()).toEqual([
      { record_key: 'friend-ayako', sheet_row_number: 3 },
      { record_key: 'friend-b', sheet_row_number: 2 },
    ]);
  });

  test('skips an unsafe old-row fallback when userIds are ambiguous after a reorder', async () => {
    raw.prepare(`INSERT INTO friends
      (id, line_user_id, display_name, line_account_id, metadata, created_at, updated_at)
      VALUES ('friend-b', 'U_B', 'びー', 'acc-1', '{"入金確認":"B"}',
              '2026-07-20T11:00:00+09:00', '2026-07-20T11:00:00+09:00')`).run();
    await run();
    client.values = [
      client.values[0],
      ['びー', 'tampered-b', '2026-07-20T11:00:00+09:00', 'B'],
      ['あやこ', 'tampered-a', '2026-07-20T10:00:00+09:00', '未'],
    ];

    const result = await run('polling', 'system_poll');

    expect(result.status).toBe('warning');
    expect(result.importedFields).toBe(0);
    expect(metadata()).toMatchObject({ 入金確認: '未' });
    expect(metadata('friend-b')).toMatchObject({ 入金確認: 'B' });
  });

  test('imports selected custom cells but restores and audits edited identity cells', async () => {
    await run();
    client.values[1][0] = '改ざん名';
    client.values[1][3] = '済';

    const result = await run('polling', 'system_poll');

    expect(result).toMatchObject({ importedFields: 1, ignoredIdentityEdits: 1, status: 'warning' });
    expect(metadata()).toMatchObject({ 入金確認: '済', 未選択: '保持' });
    expect((raw.prepare('SELECT display_name FROM friends WHERE id=?').get('friend-ayako') as { display_name: string }).display_name)
      .toBe('あやこ');
    expect(client.values[1][0]).toBe('あやこ');
    expect(raw.prepare(`SELECT actor, column_name, old_value, new_value, source, change_kind
      FROM sheets_sync_audit_details ORDER BY created_at, id`).all()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actor: 'system_poll', column_name: '入金確認', old_value: '未', new_value: '済',
        source: 'polling', change_kind: 'custom_field',
      }),
      expect.objectContaining({
        actor: 'system_poll', column_name: '表示名', old_value: 'あやこ', new_value: '改ざん名',
        source: 'polling', change_kind: 'identity_ignored',
      }),
    ]));
  });

  test('pushes a legitimate Harness display-name change without a read-only warning', async () => {
    await run();
    raw.prepare(`UPDATE friends SET display_name='あやこ（更新）',
      updated_at='2026-07-21T11:00:00+09:00' WHERE id='friend-ayako'`).run();

    const result = await run('polling', 'system_poll');

    expect(result).toMatchObject({ updatedRows: 1, ignoredIdentityEdits: 0, status: 'success' });
    expect(client.values[1][0]).toBe('あやこ（更新）');
    expect(raw.prepare(`SELECT column_name, old_value, new_value, change_kind
      FROM sheets_sync_audit_details WHERE change_kind='identity_sync'`).get()).toEqual({
      column_name: '表示名', old_value: 'あやこ', new_value: 'あやこ（更新）', change_kind: 'identity_sync',
    });
  });

  test('accepts the latest server-observed sheet edit on conflict and records sheet_wins', async () => {
    await run();
    raw.prepare(`UPDATE friends SET metadata='{"入金確認":"ハーネス更新"}',
      updated_at='2026-07-21T11:00:00+09:00' WHERE id='friend-ayako'`).run();
    client.values[1][3] = 'シート更新';

    await run('webhook', 'editor@example.test');

    expect(metadata()).toMatchObject({ 入金確認: 'シート更新' });
    expect(raw.prepare(`SELECT conflict_resolution FROM sheets_sync_audit_log
      WHERE conflict_resolution IS NOT NULL ORDER BY apply_sequence DESC LIMIT 1`).get())
      .toEqual({ conflict_resolution: 'sheet_wins' });
  });

  test('treats equal Harness and sheet changes as convergence, not a fake import', async () => {
    await run();
    raw.prepare(`UPDATE friends SET metadata='{"入金確認":"同値"}',
      updated_at='2026-07-21T11:00:00+09:00' WHERE id='friend-ayako'`).run();
    client.values[1][3] = '同値';

    const result = await run('polling', 'system_poll');

    expect(result).toMatchObject({ importedFields: 0, updatedRows: 0 });
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sheets_sync_audit_details
      WHERE old_value = new_value`).get()).toEqual({ count: 0 });
  });

  test('treats a renamed selected heading as a warning and never imports the lookalike column', async () => {
    await run();
    client.values[0][3] = '入金済み';
    client.values[1][3] = '勝手な変更';

    const result = await run('polling', 'system_poll');

    expect(result.status).toBe('warning');
    expect(result.warnings.join(' ')).toContain('入金確認');
    expect(metadata()).toMatchObject({ 入金確認: '未' });
    expect(raw.prepare('SELECT last_sync_status, last_sync_warning FROM sheets_connections WHERE id=?').get(connection.id))
      .toMatchObject({ last_sync_status: 'warning', last_sync_warning: expect.stringContaining('入金確認') });
  });

  test('does not advance a custom-field baseline while its heading is missing', async () => {
    await run();
    raw.prepare(`UPDATE friends SET metadata='{"入金確認":"ハーネス更新"}',
      updated_at='2026-07-21T11:00:00+09:00' WHERE id='friend-ayako'`).run();
    client.values[0][3] = '入金済み';
    await run('polling', 'system_poll');
    expect((raw.prepare(`SELECT canonical_snapshot_json FROM sheets_sync_ledger
      WHERE record_key='friend-ayako'`).get() as { canonical_snapshot_json: string }).canonical_snapshot_json)
      .toContain('未');

    client.values[0][3] = '入金確認';
    const restored = await run('polling', 'system_poll');

    expect(restored.importedFields).toBe(0);
    expect(client.values[1][3]).toBe('ハーネス更新');
    expect(metadata()).toMatchObject({ 入金確認: 'ハーネス更新' });
  });
});
