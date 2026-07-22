import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  createSheetsConnection,
  enqueueSheetsWebhookEvent,
  getSheetsConnection,
  updateSheetsConnection,
  type SheetsConnection,
} from '@line-crm/db';
import type { SheetCellValue, SheetsDataUpdate } from './google-sheets.js';
import { syncFriendLedger } from './friend-ledger-sync.js';
import {
  drainFormResultsWebhookEvents,
  syncFormResults,
  type FormResultsChunkCursor,
} from './form-results-sync.js';

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

function columnIndexOf(label: string): number {
  let result = 0;
  for (const char of label) result = result * 26 + char.charCodeAt(0) - 64;
  return result - 1;
}

function parseA1(range: string): { row: number; column: number } {
  const cell = range.slice(range.lastIndexOf('!') + 1).split(':')[0];
  const match = /^([A-Z]+)(\d+)$/.exec(cell);
  if (!match) throw new Error(`Unsupported range: ${range}`);
  return { column: columnIndexOf(match[1]), row: Number(match[2]) - 1 };
}

class FakeSheetsClient {
  values: SheetCellValue[][] = [];
  readonly writes: Array<{
    kind: 'update' | 'append' | 'batch' | 'delete';
    range?: string;
    rowCount?: number;
    sheetName?: string;
    rowNumbers?: number[];
  }> = [];
  readCount = 0;
  afterRead: ((readCount: number) => void) | null = null;
  readError: Error | null = null;
  deleteErrorAfterApply: Error | null = null;

  async readValues() {
    this.readCount += 1;
    if (this.readError) {
      const error = this.readError;
      this.readError = null;
      throw error;
    }
    const values = this.values.map((row) => [...row]);
    this.afterRead?.(this.readCount);
    return { majorDimension: 'ROWS' as const, values };
  }

  async updateValues(_spreadsheetId: string, range: string, values: SheetCellValue[][]) {
    this.writes.push({ kind: 'update', range, rowCount: values.length });
    this.apply(range, values);
    return { spreadsheetId: 'sheet-1', updatedRows: values.length };
  }

  async appendValues(_spreadsheetId: string, range: string, values: SheetCellValue[][]) {
    this.writes.push({ kind: 'append', range, rowCount: values.length });
    this.values.push(...values.map((row) => [...row]));
    return { spreadsheetId: 'sheet-1' };
  }

  async batchUpdateValues(_spreadsheetId: string, data: SheetsDataUpdate[]) {
    this.writes.push({ kind: 'batch', rowCount: data.length });
    for (const update of data) this.apply(update.range, update.values);
    return { spreadsheetId: 'sheet-1', totalUpdatedRows: data.length };
  }

  async deleteRows(_spreadsheetId: string, sheetName: string, rowNumbers: number[]) {
    const sorted = [...rowNumbers].sort((left, right) => right - left);
    this.writes.push({
      kind: 'delete',
      rowCount: sorted.length,
      sheetName,
      rowNumbers: sorted,
    });
    for (const rowNumber of sorted) this.values.splice(rowNumber - 1, 1);
    if (this.deleteErrorAfterApply) {
      const error = this.deleteErrorAfterApply;
      this.deleteErrorAfterApply = null;
      throw error;
    }
    return { spreadsheetId: 'sheet-1', deletedRows: sorted.length };
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
let resultsClient: FakeSheetsClient;
let ledgerClient: FakeSheetsClient;
let connection: SheetsConnection;

const FIXED_NOW = () => new Date('2026-07-22T03:00:00.000Z');

function enableForm(fields: Array<{ id: string; label: string; type?: string; position: number }>): void {
  const definition = {
    fields: fields.map((field) => ({
      id: field.id,
      label: field.label,
      type: field.type ?? 'text',
      required: false,
      position: field.position,
      config: {},
    })),
    logic: [],
  };
  raw.prepare(`INSERT INTO formaloo_forms
    (id, title, definition_json, render_backend, line_account_id)
    VALUES ('form-1', '回答フォーム', ?, 'internal', 'acc-1')`).run(JSON.stringify(definition));
}

function updateForm(fields: Array<{ id: string; label: string; type?: string; position: number }>): void {
  const definition = {
    fields: fields.map((field) => ({
      id: field.id,
      label: field.label,
      type: field.type ?? 'text',
      required: false,
      position: field.position,
      config: {},
    })),
    logic: [],
  };
  raw.prepare(`UPDATE formaloo_forms SET definition_json = ? WHERE id = 'form-1'`)
    .run(JSON.stringify(definition));
}

function insertSubmission(
  id: string,
  answers: Record<string, unknown>,
  submittedAt: string,
  friendId: string | null = 'friend-ayako',
): void {
  raw.prepare(`INSERT INTO internal_form_submissions
    (id, form_id, friend_id, answers_json, submitted_at, created_at)
    VALUES (?, 'form-1', ?, ?, ?, ?)`).run(id, friendId, JSON.stringify(answers), submittedAt, submittedAt);
}

function submissionAnswers(id: string): Record<string, unknown> {
  const row = raw.prepare('SELECT answers_json FROM internal_form_submissions WHERE id = ?')
    .get(id) as { answers_json: string };
  return JSON.parse(row.answers_json) as Record<string, unknown>;
}

function friendMetadata(friendId = 'friend-ayako'): Record<string, unknown> {
  const row = raw.prepare('SELECT metadata FROM friends WHERE id = ?').get(friendId) as { metadata: string };
  return JSON.parse(row.metadata) as Record<string, unknown>;
}

async function createResultsConnection(overrides: {
  friendLedgerEnabled?: boolean;
  formResultsEnabled?: boolean;
  syncDirection?: 'to_sheets' | 'from_sheets' | 'bidirectional';
  selectedFormFieldIds?: string[] | null;
} = {}): Promise<SheetsConnection> {
  return createSheetsConnection(db, {
    lineAccountId: 'acc-1',
    formId: 'form-1',
    spreadsheetId: 'sheet-1',
    sheetName: '友だち台帳',
    syncDirection: overrides.syncDirection ?? 'bidirectional',
    friendFieldMappings: [{ fieldId: 'field-paid', header: '入金確認' }],
    friendLedgerEnabled: overrides.friendLedgerEnabled ?? false,
    formResultsEnabled: overrides.formResultsEnabled ?? true,
    formResultsSheetName: '回答',
    selectedFormFieldIds: overrides.selectedFormFieldIds,
  });
}

async function run(
  source: 'manual' | 'polling' | 'webhook' = 'manual',
  extra: Partial<Parameters<typeof syncFormResults>[0]> = {},
) {
  connection = (await getSheetsConnection(db, 'acc-1', connection.id))!;
  return syncFormResults({
    db,
    connection,
    client: resultsClient,
    source,
    actor: 'owner',
    now: FIXED_NOW,
    ...extra,
  });
}

async function runChunk(after: FormResultsChunkCursor | null, limit = 200) {
  return run('manual', { chunk: { limit, after } });
}

beforeEach(async () => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  raw.exec(readFileSync(join(DB_ROOT, 'bootstrap.sql'), 'utf8'));
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('acc-1', 'channel-1', 'A', 'token', 'secret'), ('acc-2', 'channel-2', 'B', 'token', 'secret')`).run();
  raw.prepare(`INSERT INTO friend_field_definitions
    (id, name, default_value, display_order, is_active)
    VALUES ('field-paid', '入金確認', '未', 1, 1)`).run();
  raw.prepare(`INSERT INTO friends
    (id, line_user_id, display_name, line_account_id, metadata, created_at, updated_at)
    VALUES
    ('friend-ayako', 'U_AYAKO', 'あやこ', 'acc-1', '{"入金確認":"未"}', '2026-07-20T10:00:00+09:00', '2026-07-20T10:00:00+09:00'),
    ('friend-other', 'U_OTHER', '別人', 'acc-2', '{"入金確認":"別"}', '2026-07-20T11:00:00+09:00', '2026-07-20T11:00:00+09:00')`).run();
  db = d1(raw);
  resultsClient = new FakeSheetsClient();
  ledgerClient = new FakeSheetsClient();
  enableForm([
    { id: 'q1', label: '質問1', position: 1 },
    { id: 'q2', label: '質問2', position: 2 },
  ]);
  insertSubmission('ifs-001', { q1: '回答A1', q2: '回答A2' }, '2026-07-21T09:00:00+09:00');
  insertSubmission('ifs-002', { q1: '回答B1', q2: '回答B2' }, '2026-07-22T09:00:00+09:00');
  connection = await createResultsConnection();
});

describe('form results sheet — one row per submission', () => {
  test('creates the header (personal block left, answers right) and one row per submission', async () => {
    const result = await run();
    expect(result.status).toBe('success');
    expect(result.appendedRows).toBe(2);
    expect(resultsClient.values[0]).toEqual([
      '表示名', 'userId', '入金確認', '送信日時', '送信ID', '質問1', '質問2',
    ]);
    expect(resultsClient.values[1]).toEqual([
      'あやこ', 'U_AYAKO', '未', '2026-07-21T09:00:00+09:00', 'ifs-001', '回答A1', '回答A2',
    ]);
    expect(resultsClient.values[2]).toEqual([
      'あやこ', 'U_AYAKO', '未', '2026-07-22T09:00:00+09:00', 'ifs-002', '回答B1', '回答B2',
    ]);
    const ledgerKeys = (raw.prepare('SELECT record_key FROM sheets_sync_ledger WHERE connection_id = ? ORDER BY record_key')
      .all(connection.id) as { record_key: string }[]).map((row) => row.record_key);
    expect(ledgerKeys).toEqual(['sub:ifs-001', 'sub:ifs-002']);
  });

  test('writes nothing on an identical retry', async () => {
    await run();
    const writesBefore = resultsClient.writes.length;
    const result = await run();
    expect(result.status).toBe('success');
    expect(resultsClient.writes.length).toBe(writesBefore);
  });

  test('removes only the exact results row after its Harness submission is soft-deleted', async () => {
    await run();
    resultsClient.values[0].push('会社メモ');
    resultsClient.values[1].push('削除対象の社内値');
    resultsClient.values[2].push('残す社内値');
    const survivorBefore = [...resultsClient.values[2]];
    raw.prepare('UPDATE internal_form_submissions SET deleted_at = ? WHERE id = ?')
      .run('2026-07-22T13:00:00+09:00', 'ifs-001');

    const result = await run();

    expect(result.updatedRows).toBe(1);
    expect(resultsClient.writes.filter((write) => write.kind === 'delete')).toEqual([{
      kind: 'delete',
      rowCount: 1,
      sheetName: '回答',
      rowNumbers: [2],
    }]);
    expect(resultsClient.values).toEqual([
      ['表示名', 'userId', '入金確認', '送信日時', '送信ID', '質問1', '質問2', '会社メモ'],
      survivorBefore,
    ]);
    expect(raw.prepare(
      'SELECT answers_json, deleted_at FROM internal_form_submissions WHERE id = ?',
    ).get('ifs-001')).toEqual({
      answers_json: '{"q1":"回答A1","q2":"回答A2"}',
      deleted_at: '2026-07-22T13:00:00+09:00',
    });
    expect(raw.prepare(
      `SELECT record_key, sheet_row_number
       FROM sheets_sync_ledger WHERE connection_id = ? ORDER BY record_key`,
    ).all(connection.id)).toEqual([{ record_key: 'sub:ifs-002', sheet_row_number: 2 }]);
    expect(raw.prepare(
      'SELECT form_results_row_shifted_at FROM sheets_connections WHERE id = ?',
    ).get(connection.id)).toEqual({ form_results_row_shifted_at: expect.any(String) });
  });

  test('fails closed when a row moves after the deletion sync reads the sheet', async () => {
    await run();
    const unrelatedRow = ['会社管理', '', '', '', '', '', '', '消してはいけない'];
    resultsClient.afterRead = (readCount) => {
      if (readCount === 2) resultsClient.values.splice(1, 0, unrelatedRow);
    };
    raw.prepare('UPDATE internal_form_submissions SET deleted_at = ? WHERE id = ?')
      .run('2026-07-22T13:00:00+09:00', 'ifs-001');

    const result = await run();

    expect(result.warnings).toContain('削除直前に回答行が移動したため、行を除去しませんでした');
    expect(resultsClient.writes.some((write) => write.kind === 'delete')).toBe(false);
    expect(resultsClient.values).toContainEqual(unrelatedRow);
    expect(resultsClient.values.some((row) => row[4] === 'ifs-001')).toBe(true);
    expect(raw.prepare(
      `SELECT record_key FROM sheets_sync_ledger
       WHERE connection_id = ? AND record_key = 'sub:ifs-001'`,
    ).get(connection.id)).toEqual({ record_key: 'sub:ifs-001' });
  });

  test('cancels the intent fence when the final preflight read fails before deletion starts', async () => {
    await run();
    raw.prepare('UPDATE internal_form_submissions SET deleted_at = ? WHERE id = ?')
      .run('2026-07-22T13:00:00+09:00', 'ifs-001');
    resultsClient.afterRead = (readCount) => {
      if (readCount === 2) resultsClient.readError = new Error('preflight read failed');
    };

    await expect(run()).rejects.toThrow('preflight read failed');

    expect(resultsClient.writes.some((write) => write.kind === 'delete')).toBe(false);
    expect(raw.prepare(
      'SELECT form_results_row_shift_pending_until FROM sheets_connections WHERE id = ?',
    ).get(connection.id)).toEqual({ form_results_row_shift_pending_until: null });
  });

  test('cancels the intent fence when row deletion is unsupported before any request', async () => {
    await run();
    raw.prepare('UPDATE internal_form_submissions SET deleted_at = ? WHERE id = ?')
      .run('2026-07-22T13:00:00+09:00', 'ifs-001');
    Object.defineProperty(resultsClient, 'deleteRows', { value: undefined });

    await expect(run()).rejects.toThrow('form_results_row_delete_unsupported');

    expect(resultsClient.writes.some((write) => write.kind === 'delete')).toBe(false);
    expect(raw.prepare(
      'SELECT form_results_row_shift_pending_until FROM sheets_connections WHERE id = ?',
    ).get(connection.id)).toEqual({ form_results_row_shift_pending_until: null });
  });

  test('retains the deletion ledger when the protected submission ID is missing', async () => {
    await run();
    resultsClient.values[1][4] = '';
    raw.prepare('UPDATE internal_form_submissions SET deleted_at = ? WHERE id = ?')
      .run('2026-07-22T13:00:00+09:00', 'ifs-001');

    const result = await run();

    expect(result.warnings).toContain('削除済み回答の送信IDが見つからないため、行を除去しませんでした');
    expect(resultsClient.writes.some((write) => write.kind === 'delete')).toBe(false);
    expect(raw.prepare(
      `SELECT record_key FROM sheets_sync_ledger
       WHERE connection_id = ? AND record_key = 'sub:ifs-001'`,
    ).get(connection.id)).toEqual({ record_key: 'sub:ifs-001' });
  });

  test('removes an exact soft-deleted row even when its prior ledger baseline is missing', async () => {
    await run();
    raw.prepare(
      `DELETE FROM sheets_sync_ledger
       WHERE connection_id = ? AND record_key = 'sub:ifs-001'`,
    ).run(connection.id);
    raw.prepare('UPDATE internal_form_submissions SET deleted_at = ? WHERE id = ?')
      .run('2026-07-22T13:00:00+09:00', 'ifs-001');

    const result = await run();

    expect(result.updatedRows).toBe(1);
    expect(resultsClient.writes.filter((write) => write.kind === 'delete')).toEqual([{
      kind: 'delete',
      rowCount: 1,
      sheetName: '回答',
      rowNumbers: [2],
    }]);
    expect(resultsClient.values.some((row) => row[4] === 'ifs-001')).toBe(false);
    expect(resultsClient.values.some((row) => row[4] === 'ifs-002')).toBe(true);
  });

  test('never moves the persisted row-shift fence backward', async () => {
    await run();
    connection = (await getSheetsConnection(db, 'acc-1', connection.id))!;
    const later = Math.max(
      Date.parse(connection.updatedAt),
      Date.parse(connection.lastSyncAt ?? connection.updatedAt),
    ) + 60_000;
    raw.prepare('UPDATE internal_form_submissions SET deleted_at = ? WHERE id = ?')
      .run('2026-07-22T13:00:00+09:00', 'ifs-001');
    await run('polling', { now: () => new Date(later) });
    const firstFence = raw.prepare(
      'SELECT form_results_row_shifted_at FROM sheets_connections WHERE id = ?',
    ).get(connection.id) as { form_results_row_shifted_at: string };
    insertSubmission(
      'ifs-003',
      { q1: '回答C1', q2: '回答C2' },
      '2026-07-22T10:00:00+09:00',
    );
    await run('polling', { now: () => new Date(later - 30_000) });
    raw.prepare('UPDATE internal_form_submissions SET deleted_at = ? WHERE id = ?')
      .run('2026-07-22T13:01:00+09:00', 'ifs-003');

    await run('polling', { now: () => new Date(later - 30_000) });

    expect(raw.prepare(
      `SELECT form_results_row_shifted_at, form_results_row_shift_pending_until
       FROM sheets_connections WHERE id = ?`,
    ).get(connection.id)).toEqual({
      form_results_row_shifted_at: firstFence.form_results_row_shifted_at,
      form_results_row_shift_pending_until: null,
    });
  });

  test('lets a concurrent tombstone win over the stale active-submission read', async () => {
    await run();
    const writesBefore = resultsClient.writes.length;
    resultsClient.afterRead = (readCount) => {
      if (readCount === 2) {
        raw.prepare('UPDATE internal_form_submissions SET deleted_at = ? WHERE id = ?')
          .run('2026-07-22T13:00:00+09:00', 'ifs-001');
      }
    };

    await run();

    expect(resultsClient.values.some((row) => row[4] === 'ifs-001')).toBe(false);
    expect(resultsClient.writes.slice(writesBefore).filter((write) => write.kind === 'delete'))
      .toHaveLength(1);
    expect(resultsClient.writes.slice(writesBefore).filter((write) => write.kind === 'append'))
      .toHaveLength(0);
    expect(raw.prepare(
      `SELECT record_key, sheet_row_number FROM sheets_sync_ledger
       WHERE connection_id = ? ORDER BY record_key`,
    ).all(connection.id)).toEqual([{ record_key: 'sub:ifs-002', sheet_row_number: 2 }]);
  });

  test('postpones a physical deletion until the terminal chunk can advance the sync fence', async () => {
    insertSubmission(
      'ifs-003',
      { q1: '回答C1', q2: '回答C2' },
      '2026-07-22T10:00:00+09:00',
    );
    await run();
    raw.prepare('UPDATE internal_form_submissions SET deleted_at = ? WHERE id = ?')
      .run('2026-07-22T13:00:00+09:00', 'ifs-001');

    const first = await runChunk(null, 1);

    expect(first.status).toBe('running');
    expect(resultsClient.writes.filter((write) => write.kind === 'delete')).toHaveLength(0);
    expect(raw.prepare(
      `SELECT record_key FROM sheets_sync_ledger
       WHERE connection_id = ? AND record_key = 'sub:ifs-001'`,
    ).get(connection.id)).toEqual({ record_key: 'sub:ifs-001' });

    const terminal = await runChunk(first.chunk!.cursor, 1);

    expect(terminal.status).toBe('success');
    expect(resultsClient.writes.filter((write) => write.kind === 'delete')).toHaveLength(1);
    expect(resultsClient.values.some((row) => row[4] === 'ifs-001')).toBe(false);
  });

  test('restores a sheet-only row deletion without deleting the Harness submission', async () => {
    await run();
    resultsClient.values.splice(1, 1);

    const result = await run();

    expect(result.appendedRows).toBe(1);
    expect(resultsClient.values.some((row) => row[4] === 'ifs-001')).toBe(true);
    expect(raw.prepare(
      'SELECT deleted_at FROM internal_form_submissions WHERE id = ?',
    ).get('ifs-001')).toEqual({ deleted_at: null });
  });

  test('includes three friend-backed and three anonymous submissions while excluding other tenants', async () => {
    insertSubmission('ifs-foreign', { q1: 'x' }, '2026-07-20T09:00:00+09:00', 'friend-other');
    insertSubmission('ifs-friend-003', { q1: '回答C1', q2: '回答C2' }, '2026-07-20T09:15:00+09:00');
    insertSubmission('ifs-anon-001', { q1: '匿名回答1', q2: '匿名回答2' }, '2026-07-20T09:30:00+09:00', null);
    insertSubmission('ifs-anon-002', { q1: '匿名回答3', q2: '匿名回答4' }, '2026-07-21T10:00:00+09:00', null);
    insertSubmission('ifs-anon-003', { q1: '匿名回答5', q2: '匿名回答6' }, '2026-07-22T10:00:00+09:00', null);
    const result = await run();
    expect(result.appendedRows).toBe(6);
    const submissionIds = resultsClient.values.slice(1).map((row) => row[4]);
    expect(submissionIds).toEqual([
      'ifs-friend-003', 'ifs-anon-001', 'ifs-001', 'ifs-anon-002', 'ifs-002', 'ifs-anon-003',
    ]);
    expect(resultsClient.values[2]).toEqual([
      '', '', '', '2026-07-20T09:30:00+09:00', 'ifs-anon-001', '匿名回答1', '匿名回答2',
    ]);
    expect(resultsClient.values[4]).toEqual([
      '', '', '', '2026-07-21T10:00:00+09:00', 'ifs-anon-002', '匿名回答3', '匿名回答4',
    ]);
    expect(resultsClient.values[6]).toEqual([
      '', '', '', '2026-07-22T10:00:00+09:00', 'ifs-anon-003', '匿名回答5', '匿名回答6',
    ]);
  });

  test('keeps the legacy file marker when adminOrigin is unavailable', async () => {
    updateForm([
      { id: 'q1', label: '質問1', position: 1 },
      { id: 'q2', label: '質問2', position: 2 },
      { id: 'attachment', label: '添付', type: 'file', position: 3 },
    ]);
    raw.prepare(`UPDATE internal_form_submissions SET answers_json = ? WHERE id = 'ifs-001'`)
      .run(JSON.stringify({
        q1: '回答A1',
        q2: '回答A2',
        attachment: [
          { key: 'private/estimate', name: '見積書.pdf' },
          { key: 'private/photo', name: '写真.png' },
        ],
      }));

    await run();

    expect(resultsClient.values[1][7]).toBe('[添付ファイル 2件]');
  });

  test('adds an admin deep link to file cells and keeps them read-only', async () => {
    updateForm([
      { id: 'q1', label: '質問1', position: 1 },
      { id: 'q2', label: '質問2', position: 2 },
      { id: 'attachment', label: '添付', type: 'file', position: 3 },
    ]);
    const answers = {
      q1: '回答A1',
      q2: '回答A2',
      attachment: [
        { key: 'private/estimate', name: '見積書.pdf' },
        { key: 'private/photo', name: '写真.png' },
      ],
    };
    raw.prepare(`UPDATE internal_form_submissions SET answers_json = ? WHERE id = 'ifs-001'`)
      .run(JSON.stringify(answers));
    const linkedCell = '見積書.pdf, 写真.png (2件) 回答を開く: '
      + 'https://admin.example.test/forms-advanced/data?id=form-1&rowId=ifs-001';

    await run('manual', { adminOrigin: 'https://admin.example.test/' });
    expect(resultsClient.values[1][7]).toBe(linkedCell);

    resultsClient.values[1][7] = '改ざんされた値';
    const result = await run('manual', { adminOrigin: 'https://admin.example.test/' });

    expect(result.warnings).toContain('回答列「添付」はシートから変更できないため元に戻しました');
    expect(resultsClient.values[1][7]).toBe(linkedCell);
    expect(submissionAnswers('ifs-001')).toEqual(answers);
  });
});

describe('personal block edits (D-1 個人情報欄)', () => {
  test('reverts the read-only display name, userId, and submitted time', async () => {
    await run();
    resultsClient.values[1][0] = '偽名';
    resultsClient.values[1][1] = 'U_FAKE';
    resultsClient.values[1][3] = '1999-01-01T00:00:00+09:00';
    const result = await run();
    expect(result.ignoredIdentityEdits).toBeGreaterThanOrEqual(3);
    expect(result.warnings.some((warning) => warning.includes('保護列「表示名」'))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('保護列「userId」'))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('保護列「送信日時」'))).toBe(true);
    expect(resultsClient.values[1][0]).toBe('あやこ');
    expect(resultsClient.values[1][1]).toBe('U_AYAKO');
    expect(resultsClient.values[1][3]).toBe('2026-07-21T09:00:00+09:00');
    const ignored = raw.prepare(`SELECT COUNT(*) AS n FROM sheets_sync_audit_details
      WHERE change_kind = 'identity_ignored'`).get() as { n: number };
    expect(ignored.n).toBeGreaterThanOrEqual(3);
  });

  test('imports an edited friend custom field into friends.metadata and converges duplicate rows', async () => {
    await run();
    resultsClient.values[1][2] = '済';
    const first = await run();
    expect(first.importedFields).toBe(1);
    expect(friendMetadata()['入金確認']).toBe('済');
    // The second row of the same friend converges on the next pass.
    const second = await run();
    expect(second.status).toBe('success');
    expect(resultsClient.values[2][2]).toBe('済');
    expect(friendMetadata()['入金確認']).toBe('済');
  });

  test('absorbs conflicting duplicate-row custom edits with one server-ordered winner', async () => {
    await run();
    resultsClient.values[1][2] = '済';
    resultsClient.values[2][2] = '保留';

    const result = await run();

    expect(result.status).toBe('success');
    expect(friendMetadata()['入金確認']).toBe('済');
    expect(resultsClient.values[1][2]).toBe('済');
    expect(resultsClient.values[2][2]).toBe('済');
    const conflict = raw.prepare(`SELECT conflict_resolution FROM sheets_sync_audit_log
      WHERE record_key = 'sub:ifs-002' ORDER BY apply_sequence DESC LIMIT 1`)
      .get() as { conflict_resolution: string | null };
    expect(conflict.conflict_resolution).toBe('harness_wins');
  });
});

describe('answer edits (D-1 回答欄)', () => {
  test('applies an answer edit to that exact submission via submission_id — not the latest', async () => {
    await run();
    resultsClient.values[1][5] = '修正済み回答';
    const result = await run();
    expect(result.importedFields).toBe(1);
    expect(submissionAnswers('ifs-001')).toEqual({ q1: '修正済み回答', q2: '回答A2' });
    expect(submissionAnswers('ifs-002')).toEqual({ q1: '回答B1', q2: '回答B2' });
  });

  test('updates an anonymous answer and restores its personal columns to blank', async () => {
    insertSubmission(
      'ifs-anon',
      { q1: '匿名回答1', q2: '匿名回答2' },
      '2026-07-20T09:30:00+09:00',
      null,
    );
    await run();
    const row = resultsClient.values.find((value) => value[4] === 'ifs-anon');
    expect(row).toEqual([
      '', '', '', '2026-07-20T09:30:00+09:00', 'ifs-anon', '匿名回答1', '匿名回答2',
    ]);
    if (!row) throw new Error('anonymous result row was not created');

    row[0] = '偽名';
    row[1] = 'U_FAKE';
    row[2] = '済';
    row[5] = '匿名回答を修正';
    const metadataBefore = friendMetadata();
    const result = await run();

    expect(result.importedFields).toBe(1);
    expect(row.slice(0, 3)).toEqual(['', '', '']);
    expect(submissionAnswers('ifs-anon')).toEqual({ q1: '匿名回答を修正', q2: '匿名回答2' });
    expect(friendMetadata()).toEqual(metadataBefore);
  });

  test('rejects a webhook edit for an unselected form field', async () => {
    connection = await (async () => {
      // Re-create with an explicit selection that excludes q2.
      raw.prepare('DELETE FROM sheets_connections').run();
      return createResultsConnection({ selectedFormFieldIds: ['q1'] });
    })();
    await run();
    expect(resultsClient.values[0]).toEqual([
      '表示名', 'userId', '入金確認', '送信日時', '送信ID', '質問1',
    ]);
    // A company column named 質問2 exists on the sheet but is not selected.
    resultsClient.values[0][6] = '質問2';
    resultsClient.values[1][6] = '勝手な値';
    const result = await run('webhook', {
      range: { rowStart: 2, rowEnd: 2, columnStart: 7, columnEnd: 7 },
      snapshot: {
        rowNumber: 2,
        columnNumber: 7,
        header: '質問2',
        rowUserId: null,
        value: '勝手な値',
        oldValue: '',
        oldValueKnown: true,
      },
      webhookEventId: 'evt-unselected-0001',
    });
    expect(result.status).toBe('warning');
    expect(result.warnings.some((warning) => warning.includes('同期対象に選ばれていない列'))).toBe(true);
    const audit = raw.prepare(`SELECT error_code FROM sheets_sync_audit_log
      ORDER BY apply_sequence DESC LIMIT 1`).get() as { error_code: string };
    expect(audit.error_code).toBe('unselected_webhook_column');
    // The unselected column is never imported.
    expect(submissionAnswers('ifs-001')).toEqual({ q1: '回答A1', q2: '回答A2' });
  });
});

describe('LWW conflict policy (unchanged)', () => {
  test('bidirectional: when both sides changed, the sheet wins by last write', async () => {
    await run();
    raw.prepare(`UPDATE internal_form_submissions SET answers_json = ? WHERE id = 'ifs-001'`)
      .run(JSON.stringify({ q1: 'ハーネス側修正', q2: '回答A2' }));
    resultsClient.values[1][5] = 'シート側修正';
    const result = await run();
    expect(result.status).toBe('success');
    expect(submissionAnswers('ifs-001')).toEqual({ q1: 'シート側修正', q2: '回答A2' });
    const conflict = raw.prepare(`SELECT conflict_resolution FROM sheets_sync_audit_log
      WHERE conflict_resolution IS NOT NULL ORDER BY apply_sequence DESC LIMIT 1`)
      .get() as { conflict_resolution: string };
    expect(conflict.conflict_resolution).toBe('sheet_wins');
  });

  test('to_sheets: the harness value overwrites the sheet edit', async () => {
    raw.prepare('DELETE FROM sheets_connections').run();
    connection = await createResultsConnection({ syncDirection: 'to_sheets' });
    await run();
    raw.prepare(`UPDATE internal_form_submissions SET answers_json = ? WHERE id = 'ifs-001'`)
      .run(JSON.stringify({ q1: 'ハーネス側修正', q2: '回答A2' }));
    resultsClient.values[1][5] = 'シート側修正';
    await run();
    expect(resultsClient.values[1][5]).toBe('ハーネス側修正');
    expect(submissionAnswers('ifs-001')).toEqual({ q1: 'ハーネス側修正', q2: '回答A2' });
  });
});

describe('chunked completion (D-1 チャンク完走)', () => {
  test('finishes 450 submissions through a stable 200-row cursor window', async () => {
    raw.prepare('DELETE FROM internal_form_submissions').run();
    const insert = raw.prepare(`INSERT INTO internal_form_submissions
      (id, form_id, friend_id, answers_json, submitted_at, created_at)
      VALUES (?, 'form-1', 'friend-ayako', ?, ?, ?)`);
    raw.transaction(() => {
      for (let index = 0; index < 450; index += 1) {
        const suffix = String(index).padStart(4, '0');
        const timestamp = `2026-07-21T10:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}+09:00`;
        insert.run(`ifs-${suffix}`, JSON.stringify({ q1: `回答${suffix}` }), timestamp, timestamp);
      }
    })();

    const first = await runChunk(null);
    expect(first.status).toBe('running');
    expect(first.chunk).toMatchObject({ processed: 200, hasMore: true });
    const second = await runChunk(first.chunk!.cursor);
    expect(second.chunk).toMatchObject({ processed: 200, hasMore: true });
    const third = await runChunk(second.chunk!.cursor);
    expect(third.chunk).toMatchObject({ processed: 50, hasMore: false });
    expect(third.status).toBe('success');
    expect(resultsClient.values.length).toBe(451);
    const ledgerCount = raw.prepare(`SELECT COUNT(*) AS n FROM sheets_sync_ledger
      WHERE record_key LIKE 'sub:%'`).get() as { n: number };
    expect(ledgerCount.n).toBe(450);
  });
});

describe('target isolation (D-2 独立スイッチ)', () => {
  test('ledger OFF freezes the ledger while results continue', async () => {
    const ledgerResult = await syncFriendLedger({
      db, connection, client: ledgerClient, source: 'manual', actor: 'owner', now: FIXED_NOW,
    });
    expect(ledgerResult.status).toBe('warning');
    expect(ledgerResult.warnings).toContain('友だち台帳の同期設定が有効ではありません');
    expect(ledgerClient.writes.length).toBe(0);

    const resultsResult = await run();
    expect(resultsResult.status).toBe('success');
    expect(resultsClient.values.length).toBe(3);
  });

  test('results OFF freezes the results tab while the combined ledger keeps today\'s behavior', async () => {
    raw.prepare('DELETE FROM sheets_connections').run();
    connection = await createSheetsConnection(db, {
      lineAccountId: 'acc-1',
      formId: 'form-1',
      spreadsheetId: 'sheet-1',
      sheetName: '友だち台帳',
      syncDirection: 'bidirectional',
      friendFieldMappings: [{ fieldId: 'field-paid', header: '入金確認' }],
      friendLedgerEnabled: true,
    });
    const resultsResult = await run();
    expect(resultsResult.status).toBe('warning');
    expect(resultsResult.warnings).toContain('フォーム回答の同期設定が有効ではありません');
    expect(resultsClient.writes.length).toBe(0);

    connection = (await getSheetsConnection(db, 'acc-1', connection.id))!;
    const ledgerResult = await syncFriendLedger({
      db, connection, client: ledgerClient, source: 'manual', actor: 'owner', now: FIXED_NOW,
    });
    expect(ledgerResult.status).toBe('success');
    // Legacy combined layout still joins the answer columns on the ledger tab.
    expect(ledgerClient.values[0]).toEqual([
      '表示名', 'userId', '登録日', '入金確認', '質問1', '質問2',
    ]);
  });

  test('with both targets on, the ledger tab drops answer columns and the results tab carries them', async () => {
    raw.prepare('DELETE FROM sheets_connections').run();
    connection = await createResultsConnection({ friendLedgerEnabled: true });
    const ledgerResult = await syncFriendLedger({
      db, connection, client: ledgerClient, source: 'manual', actor: 'owner', now: FIXED_NOW,
    });
    expect(ledgerResult.status).toBe('success');
    expect(ledgerClient.values[0]).toEqual(['表示名', 'userId', '登録日', '入金確認']);

    const resultsResult = await run();
    expect(resultsResult.status).toBe('success');
    expect(resultsClient.values[0]).toEqual([
      '表示名', 'userId', '入金確認', '送信日時', '送信ID', '質問1', '質問2',
    ]);
  });

  test('drains a pending results edit after only the ledger flag is turned off', async () => {
    raw.prepare('DELETE FROM sheets_connections').run();
    connection = await createResultsConnection({ friendLedgerEnabled: true });
    await run();
    resultsClient.values[1][5] = 'フラグ変更後の回答';
    connection = (await getSheetsConnection(db, 'acc-1', connection.id))!;
    const occurredAt = new Date(Date.parse(connection.updatedAt) + 1_000).toISOString();
    const queued = await enqueueSheetsWebhookEvent(
      db,
      'acc-1',
      connection.id,
      connection.configVersion,
      {
        eventId: 'evt-results-survives-ledger-flip',
        actor: 'editor@example.test',
        actorKind: 'google_email',
        occurredAt,
        receivedAt: occurredAt,
        target: 'form_results',
        payload: {
          range: { rowStart: 2, rowEnd: 2, columnStart: 6, columnEnd: 6 },
          snapshot: {
            rowNumber: 2,
            columnNumber: 6,
            header: '質問1',
            rowUserId: 'U_AYAKO',
            value: 'フラグ変更後の回答',
            oldValue: '回答A1',
            oldValueKnown: true,
          },
        },
      },
    );
    expect(queued?.enqueued).toBe(true);

    const versionBeforeFlip = connection.configVersion;
    connection = (await updateSheetsConnection(db, 'acc-1', connection.id, {
      spreadsheetId: connection.spreadsheetId,
      sheetName: connection.sheetName,
      syncDirection: connection.syncDirection,
      friendLedgerEnabled: false,
    }))!;
    expect(connection.configVersion).toBe(versionBeforeFlip);

    const drainNow = new Date(Date.parse(occurredAt) + 10_000);
    const drained = await drainFormResultsWebhookEvents({
      db,
      connection,
      client: resultsClient,
      maxEvents: 1,
      now: () => drainNow,
    });

    expect(drained).toMatchObject({ attempted: 1, applied: 1, dead: 0 });
    expect(submissionAnswers('ifs-001')).toEqual({
      q1: 'フラグ変更後の回答',
      q2: '回答A2',
    });
  });

  test('does not retarget a queued pre-deletion webhook after a results row shifts', async () => {
    raw.prepare('UPDATE internal_form_submissions SET answers_json = ?')
      .run(JSON.stringify({ q1: '共通値', q2: '回答2' }));
    insertSubmission(
      'ifs-003',
      { q1: '共通値', q2: '回答2' },
      '2026-07-22T10:00:00+09:00',
    );
    await run();
    const targetRowIndex = resultsClient.values.findIndex((row) => row[4] === 'ifs-002');
    expect(targetRowIndex).toBeGreaterThan(0);
    resultsClient.values[targetRowIndex][5] = '本来はifs-002だけの編集';
    connection = (await getSheetsConnection(db, 'acc-1', connection.id))!;
    const baselineAt = Math.max(
      Date.parse(connection.updatedAt),
      Date.parse(connection.lastSyncAt ?? connection.updatedAt),
    );
    const occurredAt = new Date(baselineAt + 1_000).toISOString();
    const queued = await enqueueSheetsWebhookEvent(
      db,
      'acc-1',
      connection.id,
      connection.configVersion,
      {
        eventId: 'evt-before-results-row-delete',
        actor: 'editor@example.test',
        actorKind: 'google_email',
        occurredAt,
        receivedAt: occurredAt,
        target: 'form_results',
        payload: {
          range: {
            rowStart: targetRowIndex + 1,
            rowEnd: targetRowIndex + 1,
            columnStart: 6,
            columnEnd: 6,
          },
          snapshot: {
            rowNumber: targetRowIndex + 1,
            columnNumber: 6,
            header: '質問1',
            rowUserId: 'U_AYAKO',
            value: '本来はifs-002だけの編集',
            oldValue: '共通値',
            oldValueKnown: true,
          },
        },
      },
    );
    expect(queued?.enqueued).toBe(true);
    raw.prepare('UPDATE internal_form_submissions SET deleted_at = ? WHERE id = ?')
      .run('2026-07-22T13:00:00+09:00', 'ifs-001');
    const deletionCompletedAt = baselineAt + 10_000;

    await run('polling', { now: () => new Date(deletionCompletedAt) });

    expect(submissionAnswers('ifs-002')).toEqual({
      q1: '本来はifs-002だけの編集',
      q2: '回答2',
    });
    expect(submissionAnswers('ifs-003')).toEqual({ q1: '共通値', q2: '回答2' });
    // `run` keeps the caller's pre-completion connection object. The drain
    // must fetch the persisted lastSyncAt fence rather than trusting it.
    expect(Date.parse(connection.lastSyncAt ?? '')).toBeLessThan(deletionCompletedAt);
    const drained = await drainFormResultsWebhookEvents({
      db,
      connection,
      client: resultsClient,
      maxEvents: 1,
      now: () => new Date(deletionCompletedAt + 10_000),
    });

    expect(drained).toMatchObject({ attempted: 1, applied: 1, dead: 0 });
    expect(submissionAnswers('ifs-003')).toEqual({ q1: '共通値', q2: '回答2' });
    expect(raw.prepare(
      `SELECT error_code FROM sheets_sync_audit_log
       WHERE webhook_event_id = 'evt-before-results-row-delete'`,
    ).get()).toEqual({ error_code: 'stale_webhook_generation' });
  });

  test('does not discard a queued edit merely because an unrelated sync failed', async () => {
    await run();
    resultsClient.values[1][5] = '失敗後も取り込む編集';
    connection = (await getSheetsConnection(db, 'acc-1', connection.id))!;
    const baselineAt = Math.max(
      Date.parse(connection.updatedAt),
      Date.parse(connection.lastSyncAt ?? connection.updatedAt),
    );
    const occurredAt = new Date(baselineAt + 1_000).toISOString();
    const queued = await enqueueSheetsWebhookEvent(
      db,
      'acc-1',
      connection.id,
      connection.configVersion,
      {
        eventId: 'evt-before-unrelated-sync-failure',
        actor: 'editor@example.test',
        actorKind: 'google_email',
        occurredAt,
        receivedAt: occurredAt,
        target: 'form_results',
        payload: {
          range: { rowStart: 2, rowEnd: 2, columnStart: 6, columnEnd: 6 },
          snapshot: {
            rowNumber: 2,
            columnNumber: 6,
            header: '質問1',
            rowUserId: 'U_AYAKO',
            value: '失敗後も取り込む編集',
            oldValue: '回答A1',
            oldValueKnown: true,
          },
        },
      },
    );
    expect(queued?.enqueued).toBe(true);
    resultsClient.readError = new Error('temporary sheets read failure');
    const failureAt = baselineAt + 10_000;

    await expect(run('polling', { now: () => new Date(failureAt) }))
      .rejects.toThrow('temporary sheets read failure');

    const drained = await drainFormResultsWebhookEvents({
      db,
      connection,
      client: resultsClient,
      maxEvents: 1,
      now: () => new Date(failureAt + 10_000),
    });
    expect(drained).toMatchObject({ attempted: 1, applied: 1, dead: 0 });
    expect(submissionAnswers('ifs-001')).toEqual({
      q1: '失敗後も取り込む編集',
      q2: '回答A2',
    });
  });

  test('keeps an intent fence when the row-delete response is uncertain', async () => {
    raw.prepare('UPDATE internal_form_submissions SET answers_json = ?')
      .run(JSON.stringify({ q1: '共通値', q2: '回答2' }));
    insertSubmission(
      'ifs-003',
      { q1: '共通値', q2: '回答2' },
      '2026-07-22T10:00:00+09:00',
    );
    await run();
    const targetRow = resultsClient.values.findIndex((row) => row[4] === 'ifs-002') + 1;
    connection = (await getSheetsConnection(db, 'acc-1', connection.id))!;
    const baselineAt = Math.max(
      Date.parse(connection.updatedAt),
      Date.parse(connection.lastSyncAt ?? connection.updatedAt),
    );
    const occurredAt = new Date(baselineAt + 1_000).toISOString();
    resultsClient.values[targetRow - 1][5] = 'ifs-002だけの編集';
    raw.prepare('UPDATE internal_form_submissions SET deleted_at = ? WHERE id = ?')
      .run('2026-07-22T13:00:00+09:00', 'ifs-001');
    resultsClient.deleteErrorAfterApply = new Error('delete response lost');

    await expect(run('polling', { now: () => new Date(baselineAt + 10_000) }))
      .rejects.toThrow('delete response lost');

    expect(raw.prepare(
      'SELECT form_results_row_shift_pending_until FROM sheets_connections WHERE id = ?',
    ).get(connection.id)).toEqual({ form_results_row_shift_pending_until: expect.any(String) });
    const result = await run('webhook', {
      range: { rowStart: targetRow, rowEnd: targetRow, columnStart: 6, columnEnd: 6 },
      snapshot: {
        rowNumber: targetRow,
        columnNumber: 6,
        header: '質問1',
        rowUserId: 'U_AYAKO',
        value: 'ifs-002だけの編集',
        oldValue: '共通値',
        oldValueKnown: true,
      },
      webhookEventId: 'evt-uncertain-row-delete',
      webhookOccurredAt: occurredAt,
    });

    expect(result.warnings).toContain('編集後に行・列または同期設定が変わったため、古い編集通知を取り込みませんでした');
    expect(submissionAnswers('ifs-003')).toEqual({ q1: '共通値', q2: '回答2' });
  });
});
