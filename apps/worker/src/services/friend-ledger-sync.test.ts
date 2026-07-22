import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  createSheetsConnection,
  enqueueSheetsWebhookEvent,
  getSheetsConnection,
  type SheetsConnection,
} from '@line-crm/db';
import type { SheetCellValue, SheetsDataUpdate } from './google-sheets.js';
import {
  drainFriendLedgerWebhookEvents,
  parseFriendLedgerTimestamp,
  parseFriendLedgerWebhookEventPayload,
  runFriendLedgerPolling,
  syncFriendLedger,
  type FriendLedgerWebhookSnapshot,
} from './friend-ledger-sync.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');

type MockStatement = D1PreparedStatement & { __exec: () => { meta: { changes: number } } };

function d1(raw: Database.Database, beforeRun?: (sql: string) => void): D1Database {
  const prepare = (sql: string): MockStatement => {
    const statement = raw.prepare(sql);
    let params: unknown[] = [];
    const api = {
      bind(...args: unknown[]) { params = args; return api; },
      async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
      async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
      async run() { return api.__exec(); },
      __exec() {
        beforeRun?.(sql);
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
  readonly writes: Array<{
    kind: 'update' | 'append' | 'batch';
    range?: string;
    rowCount?: number;
  }> = [];
  readCount = 0;
  afterWrite?: (kind: 'update' | 'append' | 'batch') => void | Promise<void>;
  afterRead?: () => void | Promise<void>;

  async readValues() {
    this.readCount += 1;
    const response = { majorDimension: 'ROWS' as const, values: this.values.map((row) => [...row]) };
    await this.afterRead?.();
    return response;
  }

  async updateValues(_spreadsheetId: string, range: string, values: SheetCellValue[][]) {
    this.writes.push({ kind: 'update', range, rowCount: values.length });
    this.apply(range, values);
    await this.afterWrite?.('update');
    return { spreadsheetId: 'sheet-1', updatedRows: values.length };
  }

  async appendValues(_spreadsheetId: string, range: string, values: SheetCellValue[][]) {
    this.writes.push({ kind: 'append', range, rowCount: values.length });
    this.values.push(...values.map((row) => [...row]));
    await this.afterWrite?.('append');
    return { spreadsheetId: 'sheet-1' };
  }

  async batchUpdateValues(_spreadsheetId: string, data: SheetsDataUpdate[]) {
    this.writes.push({ kind: 'batch', rowCount: data.length });
    for (const update of data) this.apply(update.range, update.values);
    await this.afterWrite?.('batch');
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

type AnswerFieldFixture = {
  id: string;
  label: string;
  type?: string;
  position: number;
};

function answerFieldConfig(type = 'text'): Record<string, unknown> {
  if (type === 'choice' || type === 'dropdown' || type === 'multiple_select') {
    return { choices: ['A', 'B', 'C', 'D'] };
  }
  if (type === 'section') return { text: '補足' };
  return {};
}

function enableInternalAnswerForm(fields: AnswerFieldFixture[]): void {
  const definition = {
    fields: fields.map((field) => ({
      id: field.id,
      label: field.label,
      type: field.type ?? 'text',
      required: false,
      position: field.position,
      config: answerFieldConfig(field.type),
    })),
    logic: [],
  };
  raw.prepare(`INSERT INTO formaloo_forms
    (id, title, definition_json, render_backend, line_account_id)
    VALUES ('friend-ledger', '回答フォーム', ?, 'internal', 'acc-1')`).run(JSON.stringify(definition));
}

function updateInternalAnswerFields(fields: AnswerFieldFixture[]): void {
  raw.prepare(`UPDATE formaloo_forms SET definition_json=? WHERE id='friend-ledger'`).run(JSON.stringify({
    fields: fields.map((field) => ({
      id: field.id,
      label: field.label,
      type: field.type ?? 'text',
      required: false,
      position: field.position,
      config: answerFieldConfig(field.type),
    })),
    logic: [],
  }));
}

function insertInternalAnswer(
  id: string,
  answers: Record<string, unknown>,
  submittedAt: string,
  friendId: string | null = 'friend-ayako',
): void {
  raw.prepare(`INSERT INTO internal_form_submissions
    (id, form_id, friend_id, answers_json, submitted_at, created_at)
    VALUES (?, 'friend-ledger', ?, ?, ?, ?)`).run(
    id,
    friendId,
    JSON.stringify(answers),
    submittedAt,
    submittedAt,
  );
}

function latestInternalAnswers(): Record<string, unknown> {
  const row = raw.prepare(`SELECT answers_json FROM internal_form_submissions
    WHERE form_id='friend-ledger' AND friend_id='friend-ayako'
    ORDER BY julianday(submitted_at) DESC, rowid DESC LIMIT 1`).get() as { answers_json: string };
  return JSON.parse(row.answers_json) as Record<string, unknown>;
}

async function run(
  source: 'manual' | 'polling' | 'webhook' = 'manual',
  actor = 'owner',
  range?: { rowStart: number; rowEnd: number; columnStart: number; columnEnd: number },
  snapshot?: FriendLedgerWebhookSnapshot,
  webhookEventId?: string,
  webhookTargetError?: 'stale_webhook_generation',
) {
  connection = (await getSheetsConnection(db, 'acc-1', connection.id))!;
  return syncFriendLedger({
    db,
    connection,
    client,
    source,
    actor,
    range,
    snapshot,
    webhookEventId,
    webhookTargetError,
    now: () => new Date('2026-07-21T03:00:00.000Z'),
  });
}

type TestFriendLedgerChunkCursor = {
  createdAt: string;
  friendId: string;
};

type TestFriendLedgerChunkMetadata = {
  processed: number;
  hasMore: boolean;
  cursor: TestFriendLedgerChunkCursor | null;
};

type ChunkedSyncOptions = Parameters<typeof syncFriendLedger>[0] & {
  chunk: {
    limit: number;
    after: TestFriendLedgerChunkCursor | null;
  };
};

async function runChunk(
  after: TestFriendLedgerChunkCursor | null,
  limit = 250,
): Promise<Awaited<ReturnType<typeof syncFriendLedger>> & { chunk: TestFriendLedgerChunkMetadata }> {
  connection = (await getSheetsConnection(db, 'acc-1', connection.id))!;
  const options: ChunkedSyncOptions = {
    db,
    connection,
    client,
    source: 'manual',
    actor: 'owner',
    now: () => new Date('2026-07-21T03:00:00.000Z'),
    chunk: { limit, after },
  };
  return syncFriendLedger(options) as Promise<
    Awaited<ReturnType<typeof syncFriendLedger>> & { chunk: TestFriendLedgerChunkMetadata }
  >;
}

function replaceAccountFriends(count: number): void {
  raw.prepare(`DELETE FROM friends WHERE line_account_id='acc-1'`).run();
  const insert = raw.prepare(`INSERT INTO friends
    (id, line_user_id, display_name, line_account_id, metadata, created_at, updated_at)
    VALUES (?, ?, ?, 'acc-1', ?, ?, ?)`);
  const createdAt = '2026-07-20T10:00:00+09:00';
  raw.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const suffix = String(index).padStart(4, '0');
      insert.run(
        `friend-${suffix}`,
        `U_${suffix}`,
        `友だち${suffix}`,
        JSON.stringify({ '入金確認': '未' }),
        createdAt,
        createdAt,
      );
    }
  })();
}

function sheetUserIds(): string[] {
  const userIdIndex = client.values[0]?.indexOf('userId') ?? -1;
  if (userIdIndex < 0) return [];
  return client.values.slice(1).map((row) => String(row[userIdIndex] ?? ''));
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
  test('interprets legacy offsetless connection timestamps as JST', () => {
    expect(parseFriendLedgerTimestamp('2026-07-21T12:00:00.000'))
      .toBe(Date.parse('2026-07-21T12:00:00.000+09:00'));
    expect(parseFriendLedgerTimestamp('2026-07-21T03:00:00.000Z'))
      .toBe(Date.parse('2026-07-21T03:00:00.000Z'));
  });

  test('stops before publishing state when another worker takes the lease between sheet writes', async () => {
    let stolen = false;
    client.afterWrite = (kind) => {
      if (kind !== 'update' || stolen) return;
      stolen = true;
      raw.prepare(`UPDATE sheets_connections
        SET sync_lock_token='new-worker', sync_lock_expires_at='2026-07-21T13:00:00+09:00',
            last_sync_status='warning', last_sync_warning='新しいワーカーの状態'
        WHERE id=?`).run(connection.id);
    };

    await expect(run()).rejects.toThrow('friend_ledger_sync_lock_lost');
    expect(raw.prepare('SELECT COUNT(*) AS count FROM sheets_sync_ledger').get()).toEqual({ count: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM sheets_sync_audit_log').get()).toEqual({ count: 0 });
    expect(raw.prepare(`SELECT sync_lock_token, last_sync_status, last_sync_warning
      FROM sheets_connections WHERE id=?`).get(connection.id)).toEqual({
      sync_lock_token: 'new-worker',
      last_sync_status: 'warning',
      last_sync_warning: '新しいワーカーの状態',
    });
  });

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

  test('finishes 1,450 friends through a stable 250-row cursor window', async () => {
    replaceAccountFriends(1_450);
    let cursor: TestFriendLedgerChunkCursor | null = null;
    let hasMore = true;
    const processedPerInvocation: number[] = [];

    while (hasMore) {
      const appendCountBefore = client.writes.filter((write) => write.kind === 'append').length;
      const result = await runChunk(cursor, 250);

      expect(result).toMatchObject({
        chunk: {
          processed: expect.any(Number),
          hasMore: expect.any(Boolean),
          cursor: { createdAt: expect.any(String), friendId: expect.any(String) },
        },
      });
      expect(result.chunk.processed).toBeGreaterThan(0);
      expect(result.chunk.processed).toBeLessThanOrEqual(250);
      const appendWrites = client.writes
        .filter((write) => write.kind === 'append')
        .slice(appendCountBefore);
      expect(appendWrites).toHaveLength(1);
      expect(appendWrites[0].rowCount).toBe(result.chunk.processed);
      expect(appendWrites[0].rowCount).toBeLessThanOrEqual(250);

      processedPerInvocation.push(result.chunk.processed);
      cursor = result.chunk.cursor;
      hasMore = result.chunk.hasMore;
    }

    expect(processedPerInvocation).toEqual([250, 250, 250, 250, 250, 200]);
    expect(cursor).toEqual({
      createdAt: '2026-07-20T10:00:00+09:00',
      friendId: 'friend-1449',
    });
    expect(client.writes.filter((write) => write.kind === 'append').map((write) => write.rowCount))
      .toEqual([250, 250, 250, 250, 250, 200]);
    expect(sheetUserIds()).toHaveLength(1_450);
    expect(new Set(sheetUserIds()).size).toBe(1_450);
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sheets_sync_ledger
      WHERE connection_id=?`).get(connection.id)).toEqual({ count: 1_450 });
  }, 60_000);

  test('uses the same binary cursor order as SQLite across mixed timestamp formats', async () => {
    raw.prepare("DELETE FROM friends WHERE line_account_id='acc-1'").run();
    const insert = raw.prepare(`INSERT INTO friends
      (id, line_user_id, display_name, line_account_id, metadata, created_at, updated_at)
      VALUES (?, ?, ?, 'acc-1', '{"\u5165\u91d1\u78ba\u8a8d":"\u672a"}', ?, ?)`);
    insert.run(
      'friend-offset',
      'U_OFFSET',
      'オフセット',
      '2026-07-20T10:00:00+09:00',
      '2026-07-20T10:00:00+09:00',
    );
    insert.run(
      'friend-millis',
      'U_MILLIS',
      'ミリ秒',
      '2026-07-20T10:00:00.000+09:00',
      '2026-07-20T10:00:00.000+09:00',
    );

    const first = await runChunk(null, 1);
    const second = await runChunk(first.chunk.cursor, 1);

    expect(first.chunk).toMatchObject({
      processed: 1,
      hasMore: true,
      cursor: { friendId: 'friend-offset' },
    });
    expect(second.chunk).toMatchObject({
      processed: 1,
      hasMore: false,
      cursor: { friendId: 'friend-millis' },
    });
    expect(sheetUserIds()).toEqual(['U_OFFSET', 'U_MILLIS']);
  });

  test('retries an interrupted chunk from the prior cursor without duplicate sheet or ledger rows', async () => {
    replaceAccountFriends(1_450);
    const first = await runChunk(null, 250);
    expect(first.chunk).toMatchObject({
      processed: 250,
      hasMore: true,
      cursor: { friendId: 'friend-0249' },
    });
    const durableCursor = first.chunk.cursor!;

    let interrupted = false;
    client.afterWrite = (kind) => {
      if (kind === 'append' && !interrupted) {
        interrupted = true;
        throw new Error('simulated_worker_cutoff_after_sheet_append');
      }
    };
    await expect(runChunk(durableCursor, 250))
      .rejects.toThrow('simulated_worker_cutoff_after_sheet_append');
    client.afterWrite = undefined;

    expect(sheetUserIds()).toHaveLength(500);
    expect(new Set(sheetUserIds()).size).toBe(500);
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sheets_sync_ledger
      WHERE connection_id=?`).get(connection.id)).toEqual({ count: 250 });

    const appendCountBeforeRetry = client.writes.filter((write) => write.kind === 'append').length;
    const retried = await runChunk(durableCursor, 250);
    expect(retried.chunk).toEqual({
      processed: 250,
      hasMore: true,
      cursor: {
        createdAt: '2026-07-20T10:00:00+09:00',
        friendId: 'friend-0499',
      },
    });
    expect(client.writes.filter((write) => write.kind === 'append')).toHaveLength(appendCountBeforeRetry);
    expect(sheetUserIds()).toHaveLength(500);
    expect(new Set(sheetUserIds()).size).toBe(500);
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sheets_sync_ledger
      WHERE connection_id=?`).get(connection.id)).toEqual({ count: 500 });

    let cursor = retried.chunk.cursor;
    let hasMore = retried.chunk.hasMore;
    while (hasMore) {
      const next = await runChunk(cursor, 250);
      cursor = next.chunk.cursor;
      hasMore = next.chunk.hasMore;
    }
    expect(cursor?.friendId).toBe('friend-1449');
    expect(sheetUserIds()).toHaveLength(1_450);
    expect(new Set(sheetUserIds()).size).toBe(1_450);
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sheets_sync_ledger
      WHERE connection_id=?`).get(connection.id)).toEqual({ count: 1_450 });
  }, 60_000);

  test('keeps a signed webhook bounded to its target while a 1,450-row job is incomplete', async () => {
    replaceAccountFriends(1_450);
    await runChunk(null, 250);
    client.values[1][3] = '署名済み編集';
    client.afterWrite = (kind) => {
      if (kind === 'append') throw new Error('webhook_escaped_signed_target');
    };

    const result = await run(
      'webhook',
      'bounded-editor@example.test',
      { rowStart: 2, rowEnd: 2, columnStart: 4, columnEnd: 4 },
      {
        rowNumber: 2,
        columnNumber: 4,
        header: '入金確認',
        rowUserId: 'U_0000',
        value: '署名済み編集',
        oldValue: '未',
        oldValueKnown: true,
      },
      'event-bounded-1450',
    );

    expect(result).toMatchObject({ importedFields: 1, appendedRows: 0 });
    expect(sheetUserIds()).toHaveLength(250);
    expect(metadata('friend-0000')).toMatchObject({ '入金確認': '署名済み編集' });
  });

  test('joins the latest verified internal-form answers to the right of each friend row', async () => {
    enableInternalAnswerForm([
      { id: 'name', label: '申込者名', position: 0 },
      { id: 'section', label: '補足見出し', type: 'section', position: 1 },
      { id: 'plan', label: '希望プラン', type: 'dropdown', position: 2 },
    ]);
    insertInternalAnswer('answer-old', { name: '旧回答', plan: 'A' }, '2026-07-20T11:00:00+09:00');
    insertInternalAnswer('answer-latest', { name: '山田花子', plan: 'B' }, '2026-07-21T11:00:00+09:00');
    insertInternalAnswer('answer-anonymous', { name: '匿名' }, '2026-07-21T12:00:00+09:00', null);

    const first = await run();
    const second = await run('polling', 'system_poll');

    expect(client.values).toEqual([
      ['表示名', 'userId', '登録日', '入金確認', '申込者名', '希望プラン'],
      ['あやこ', 'U_AYAKO', '2026-07-20T10:00:00+09:00', '未', '山田花子', 'B'],
    ]);
    expect(client.values[0]).not.toContain('補足見出し');
    expect(first).toMatchObject({ appendedRows: 1, status: 'success' });
    expect(second).toMatchObject({ appendedRows: 0, updatedRows: 0 });
    expect(client.values.slice(1).filter((row) => row.includes('U_AYAKO'))).toHaveLength(1);
  });

  test('threads the admin origin and submission id into a downloadable file-answer sheet cell', async () => {
    enableInternalAnswerForm([
      { id: 'docs', label: '添付資料', type: 'file', position: 0 },
    ]);
    insertInternalAnswer('answer-files', {
      docs: [
        { key: 'private/r2-key-1', name: '見積書.pdf' },
        { key: 'private/r2-key-2', name: '写真.png' },
      ],
    }, '2026-07-21T11:00:00+09:00');
    connection = (await getSheetsConnection(db, 'acc-1', connection.id))!;

    await syncFriendLedger({
      db,
      connection,
      client,
      adminOrigin: 'https://admin.example.test',
      source: 'manual',
      actor: 'owner',
      now: () => new Date('2026-07-21T03:00:00.000Z'),
    });

    expect(client.values[1][4]).toBe(
      '見積書.pdf, 写真.png (2件) 回答を開く: https://admin.example.test/forms-advanced/data?id=friend-ledger&rowId=answer-files',
    );
  });

  test('writes and reads only explicitly selected form fields', async () => {
    raw.prepare(`UPDATE sheets_connections SET is_active=0, deleted_at='2026-07-21T11:00:00+09:00'
      WHERE id=?`).run(connection.id);
    connection = await createSheetsConnection(db, {
      lineAccountId: 'acc-1',
      formId: 'friend-ledger',
      spreadsheetId: 'sheet-selected',
      sheetName: '友だち台帳',
      syncDirection: 'bidirectional',
      friendFieldMappings: [{ fieldId: 'field-paid', header: '入金確認' }],
      friendLedgerEnabled: true,
      selectedFormFieldIds: ['plan'],
    });
    enableInternalAnswerForm([
      { id: 'name', label: '申込者名', position: 0 },
      { id: 'plan', label: '希望プラン', type: 'dropdown', position: 1 },
    ]);
    insertInternalAnswer('answer-selected', { name: 'シートへ出さない', plan: 'B' }, '2026-07-21T11:00:00+09:00');

    await run();

    expect(client.values).toEqual([
      ['表示名', 'userId', '登録日', '入金確認', '希望プラン'],
      ['あやこ', 'U_AYAKO', '2026-07-20T10:00:00+09:00', '未', 'B'],
    ]);
    expect(client.values.flat()).not.toContain('申込者名');
    expect(client.values.flat()).not.toContain('シートへ出さない');

    client.values[1][4] = 'C';
    client.values[0].push('申込者名');
    client.values[1].push('読み込まない');
    await run('polling', 'system_poll');

    expect(latestInternalAnswers()).toEqual({ name: 'シートへ出さない', plan: 'C' });
  });

  test('scopes a common internal form through the connection account', async () => {
    enableInternalAnswerForm([{ id: 'name', label: '申込者名', position: 0 }]);
    raw.prepare(`UPDATE formaloo_forms SET line_account_id=NULL
      WHERE id='friend-ledger'`).run();
    insertInternalAnswer('answer-common', { name: '共通フォーム回答' }, '2026-07-21T11:00:00+09:00');

    const result = await run();

    expect(result.status).toBe('success');
    expect(client.values[0]).toEqual(['表示名', 'userId', '登録日', '入金確認', '申込者名']);
    expect(client.values[1][4]).toBe('共通フォーム回答');
    expect(client.values.flat()).not.toContain('U_OTHER');
  });

  test('keeps the W4a friend ledger unchanged for a Formaloo-rendered form', async () => {
    raw.prepare(`INSERT INTO formaloo_forms
      (id, title, definition_json, render_backend, line_account_id)
      VALUES ('friend-ledger', 'Formalooフォーム', ?, 'formaloo', 'acc-1')`).run(JSON.stringify({
      fields: [{ id: 'name', label: '申込者名', type: 'text', required: false, position: 0, config: {} }],
      logic: [],
    }));
    insertInternalAnswer('answer-ignored', { name: '出してはいけない回答' }, '2026-07-21T11:00:00+09:00');

    const result = await run();

    expect(result.status).toBe('success');
    expect(client.values).toEqual([
      ['表示名', 'userId', '登録日', '入金確認'],
      ['あやこ', 'U_AYAKO', '2026-07-20T10:00:00+09:00', '未'],
    ]);
    expect(client.values.flat()).not.toContain('出してはいけない回答');
    expect(JSON.parse((raw.prepare(`SELECT form_answer_headers_json AS headers
      FROM sheets_connections WHERE id=?`).get(connection.id) as { headers: string }).headers))
      .toEqual([]);
  });

  test('updates a re-answer in the same row by heading after company columns are inserted and reordered', async () => {
    enableInternalAnswerForm([
      { id: 'name', label: '申込者名', position: 0 },
      { id: 'plan', label: '希望プラン', type: 'dropdown', position: 1 },
    ]);
    insertInternalAnswer('answer-first', { name: '山田花子', plan: 'A' }, '2026-07-21T10:00:00+09:00');
    await run();
    client.values = [
      ['自社担当', '希望プラン', 'userId', '登録日', '入金確認', '表示名', '申込者名'],
      ['営業部', 'A', 'U_AYAKO', '2026-07-20T10:00:00+09:00', '未', 'あやこ', '山田花子'],
    ];
    insertInternalAnswer('answer-second', { name: '山田太郎', plan: 'C' }, '2026-07-21T12:00:00+09:00');

    const result = await run('polling', 'system_poll');

    expect(result).toMatchObject({ appendedRows: 0, updatedRows: 1 });
    expect(client.values).toEqual([
      ['自社担当', '希望プラン', 'userId', '登録日', '入金確認', '表示名', '申込者名'],
      ['営業部', 'C', 'U_AYAKO', '2026-07-20T10:00:00+09:00', '未', 'あやこ', '山田太郎'],
    ]);
    expect(client.values.slice(1).filter((row) => row[2] === 'U_AYAKO')).toHaveLength(1);
  });

  test('appends a newly built answer field but warns instead of recreating a renamed sheet heading', async () => {
    enableInternalAnswerForm([{ id: 'name', label: '申込者名', position: 0 }]);
    insertInternalAnswer('answer-first', { name: '山田花子' }, '2026-07-21T10:00:00+09:00');
    await run();
    updateInternalAnswerFields([
      { id: 'name', label: '申込者名', position: 0 },
      { id: 'plan', label: '希望プラン', type: 'dropdown', position: 1 },
    ]);
    insertInternalAnswer('answer-second', { name: '山田太郎', plan: 'C' }, '2026-07-21T11:00:00+09:00');
    await run('polling', 'system_poll');
    expect(client.values[0]).toEqual(['表示名', 'userId', '登録日', '入金確認', '申込者名', '希望プラン']);

    client.values[0][4] = '申込者名（変更）';
    insertInternalAnswer('answer-third', { name: '更新後', plan: 'D' }, '2026-07-21T12:00:00+09:00');
    const result = await run('polling', 'system_poll');

    expect(result.status).toBe('warning');
    expect(result.warnings.join(' ')).toContain('申込者名');
    expect(client.values[0]).toEqual(['表示名', 'userId', '登録日', '入金確認', '申込者名（変更）', '希望プラン']);
    expect(client.values[1][4]).toBe('山田太郎');
    expect(client.values[1][5]).toBe('D');
  });

  test('redacts a skipped webhook value after an answer heading is renamed', async () => {
    enableInternalAnswerForm([{ id: 'name', label: '申込者名', position: 0 }]);
    insertInternalAnswer('answer-first', { name: '山田花子' }, '2026-07-21T10:00:00+09:00');
    await run();
    client.values[0][4] = '申込者名（変更）';
    client.values[1][4] = '編集後の個人情報';

    const result = await run(
      'webhook',
      'editor@example.test',
      { rowStart: 2, rowEnd: 2, columnStart: 5, columnEnd: 5 },
      {
        rowNumber: 2, columnNumber: 5, header: '申込者名（変更）', rowUserId: 'U_AYAKO',
        value: '編集後の個人情報', oldValue: '山田花子', oldValueKnown: true,
      },
      'event-renamed-answer-1',
    );

    expect(result).toMatchObject({ status: 'warning', importedFields: 0 });
    expect(raw.prepare(`SELECT outcome, error_code FROM sheets_sync_audit_log
      WHERE webhook_event_id='event-renamed-answer-1'`).get()).toEqual({
      outcome: 'skipped', error_code: 'unselected_webhook_column',
    });
    expect(raw.prepare(`SELECT column_name, old_value, new_value FROM sheets_sync_audit_details
      WHERE audit_id=(SELECT id FROM sheets_sync_audit_log
        WHERE webhook_event_id='event-renamed-answer-1')`).get()).toEqual({
      column_name: '申込者名（変更）', old_value: null, new_value: null,
    });
  });

  test.each([
    ['stale_webhook_generation', 'U_AYAKO', 'stale_webhook_generation'],
    ['unsafe_webhook_identity', null, undefined],
  ] as const)(
    'redacts a renamed answer value when %s wins before header classification',
    async (expectedError, rowUserId, webhookTargetError) => {
      enableInternalAnswerForm([{ id: 'name', label: '申込者名', position: 0 }]);
      insertInternalAnswer('answer-first', { name: '山田花子' }, '2026-07-21T10:00:00+09:00');
      await run();
      client.values[0][4] = '申込者名（変更）';
      client.values[1][4] = '編集後の個人情報';
      const eventId = `event-renamed-${expectedError}`;

      const result = await run(
        'webhook',
        'editor@example.test',
        { rowStart: 2, rowEnd: 2, columnStart: 5, columnEnd: 5 },
        {
          rowNumber: 2, columnNumber: 5, header: '申込者名（変更）', rowUserId,
          value: '編集後の個人情報', oldValue: '山田花子', oldValueKnown: true,
        },
        eventId,
        webhookTargetError,
      );

      expect(result).toMatchObject({ status: 'warning', importedFields: 0 });
      expect(raw.prepare(`SELECT outcome, error_code FROM sheets_sync_audit_log
        WHERE webhook_event_id=?`).get(eventId)).toEqual({
        outcome: 'skipped', error_code: expectedError,
      });
      expect(raw.prepare(`SELECT old_value, new_value FROM sheets_sync_audit_details
        WHERE audit_id=(SELECT id FROM sheets_sync_audit_log
          WHERE webhook_event_id=?)`).get(eventId)).toEqual({ old_value: null, new_value: null });
    },
  );

  test('imports a sheet answer edit into the latest submission without creating a duplicate or logging answer PII', async () => {
    enableInternalAnswerForm([{ id: 'name', label: '申込者名', position: 0 }]);
    insertInternalAnswer('answer-first', { name: '山田花子', keep: '保持' }, '2026-07-21T10:00:00+09:00');
    await run();
    client.values[1][4] = 'シート編集値';

    const result = await run('polling', 'system_poll');

    expect(result).toMatchObject({ appendedRows: 0, importedFields: 1 });
    expect(latestInternalAnswers()).toEqual({ name: 'シート編集値', keep: '保持' });
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM internal_form_submissions
      WHERE form_id='friend-ledger' AND friend_id='friend-ayako'`).get()).toEqual({ count: 1 });
    expect(raw.prepare(`SELECT old_value, new_value FROM sheets_sync_audit_details
      WHERE column_name='申込者名' ORDER BY rowid DESC LIMIT 1`).get()).toEqual({
      old_value: null,
      new_value: null,
    });
  });

  test('does not claim or overwrite a pre-existing company column with the same name as a new answer field', async () => {
    enableInternalAnswerForm([{ id: 'owner', label: '自社担当', position: 0 }]);
    insertInternalAnswer('answer-first', { owner: 'フォーム回答' }, '2026-07-21T10:00:00+09:00');
    client.values = [['自社担当'], ['営業部']];

    const result = await run();

    expect(result.status).toBe('warning');
    expect(result.warnings.join(' ')).toContain('自社担当');
    expect(client.values[0]).toEqual(['自社担当', '表示名', 'userId', '登録日', '入金確認']);
    expect(client.values[1][0]).toBe('営業部');
    expect(client.values.flat()).not.toContain('フォーム回答');
    expect(JSON.parse((raw.prepare(`SELECT form_answer_headers_json AS headers
      FROM sheets_connections WHERE id=?`).get(connection.id) as { headers: string }).headers))
      .toEqual([]);
  });

  test('does not fabricate a partial submission when an unanswered row is edited in Sheets', async () => {
    enableInternalAnswerForm([{ id: 'name', label: '申込者名', position: 0 }]);
    await run();
    raw.prepare('DELETE FROM sheets_sync_ledger WHERE connection_id=?').run(connection.id);
    client.values[1][4] = '回答がないのに編集';

    const result = await run('polling', 'system_poll');

    expect(result.status).toBe('warning');
    expect(result.importedFields).toBe(0);
    expect(result.warnings.join(' ')).toContain('回答');
    expect(client.values[1][4]).toBe('');
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM internal_form_submissions
      WHERE form_id='friend-ledger'`).get()).toEqual({ count: 0 });
  });

  test('leaves the sheet answer untouched when the latest stored answer JSON is malformed', async () => {
    enableInternalAnswerForm([{ id: 'name', label: '申込者名', position: 0 }]);
    insertInternalAnswer('answer-first', { name: '壊す前の回答' }, '2026-07-21T10:00:00+09:00');
    await run();
    raw.prepare(`UPDATE internal_form_submissions SET answers_json='{broken'
      WHERE id='answer-first'`).run();
    const writesBefore = client.writes.length;

    const result = await run('polling', 'system_poll');

    expect(result.status).toBe('warning');
    expect(result.warnings.join(' ')).toContain('保存済み回答');
    expect(client.values[1][4]).toBe('壊す前の回答');
    expect(client.writes).toHaveLength(writesBefore);
    expect(raw.prepare(`SELECT answers_json FROM internal_form_submissions
      WHERE id='answer-first'`).get()).toEqual({ answers_json: '{broken' });
  });

  test('keeps a newer re-answer authoritative when it races a sheet answer import', async () => {
    enableInternalAnswerForm([{ id: 'name', label: '申込者名', position: 0 }]);
    insertInternalAnswer('answer-first', { name: '最初の回答' }, '2026-07-21T10:00:00+09:00');
    await run();
    client.values[1][4] = 'シート編集';
    let raced = false;
    db = d1(raw, (sql) => {
      if (raced || !sql.includes('UPDATE internal_form_submissions')) return;
      raced = true;
      insertInternalAnswer('answer-raced', { name: '直前の再回答' }, '2026-07-21T12:00:00+09:00');
    });

    const result = await run('polling', 'system_poll');

    expect(raced).toBe(true);
    expect(result.importedFields).toBe(0);
    expect(latestInternalAnswers()).toEqual({ name: '直前の再回答' });
    expect(client.values[1][4]).toBe('直前の再回答');
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM internal_form_submissions
      WHERE form_id='friend-ledger' AND friend_id='friend-ayako'`).get()).toEqual({ count: 2 });
  });

  test('clears an owned answer cell after the field is removed without exposing its value in audit details', async () => {
    enableInternalAnswerForm([{ id: 'secret', label: '秘密の回答', position: 0 }]);
    insertInternalAnswer('answer-first', { secret: '消す値' }, '2026-07-21T10:00:00+09:00');
    await run();
    updateInternalAnswerFields([]);

    const result = await run('polling', 'system_poll');

    expect(result.updatedRows).toBe(1);
    expect(client.values[0][4]).toBe('秘密の回答');
    expect(client.values[1][4]).toBe('');
    expect(raw.prepare(`SELECT old_value, new_value FROM sheets_sync_audit_details
      WHERE column_name='秘密の回答' ORDER BY rowid DESC LIMIT 1`).get()).toEqual({
      old_value: null,
      new_value: null,
    });
  });

  test('rebuilds a cleared heading row without duplicating established friend rows', async () => {
    await run();
    client.values[0] = [];

    const recovered = await run('polling', 'system_poll');
    const retried = await run('polling', 'system_poll');

    expect(recovered).toMatchObject({ appendedRows: 0, importedFields: 0 });
    expect(retried).toMatchObject({ appendedRows: 0, importedFields: 0 });
    expect(client.values[0]).toEqual(['表示名', 'userId', '登録日', '入金確認']);
    expect(client.values.slice(1).filter((row) => row[1] === 'U_AYAKO')).toHaveLength(1);
    expect(retried.warnings.join(' ')).not.toContain('userId が重複');
  });

  test('fails closed without replacing malformed stored friend metadata', async () => {
    await run();
    raw.prepare(`UPDATE friends SET metadata='{broken',
      updated_at='2026-07-21T11:00:00+09:00' WHERE id='friend-ayako'`).run();
    client.values[1][3] = 'シートの変更';
    const auditCount = raw.prepare('SELECT COUNT(*) AS count FROM sheets_sync_audit_log').get();

    const result = await run('polling', 'system_poll');

    expect(result.status).toBe('warning');
    expect(result.warnings.join(' ')).toContain('metadata');
    expect(raw.prepare('SELECT metadata FROM friends WHERE id=?').get('friend-ayako'))
      .toEqual({ metadata: '{broken' });
    expect(client.values[1][3]).toBe('シートの変更');
    expect(raw.prepare('SELECT COUNT(*) AS count FROM sheets_sync_audit_log').get()).toEqual(auditCount);
  });

  test('adds friend headings beside company-owned headings on the first sync', async () => {
    client.values = [['自社担当'], ['営業部']];

    const result = await run();

    expect(result).toMatchObject({ appendedRows: 1, status: 'success' });
    expect(client.values).toEqual([
      ['自社担当', '表示名', 'userId', '登録日', '入金確認'],
      ['営業部'],
      ['', 'あやこ', 'U_AYAKO', '2026-07-20T10:00:00+09:00', '未'],
    ]);
  });

  test('warns about a renamed heading after an empty ledger was initialized', async () => {
    raw.prepare("DELETE FROM friends WHERE line_account_id='acc-1'").run();
    await run();
    client.values[0][3] = '入金済み';

    const result = await run('polling', 'system_poll');

    expect(result.status).toBe('warning');
    expect(result.warnings.join(' ')).toContain('入金確認');
    expect(client.values[0]).toEqual(['表示名', 'userId', '登録日', '入金済み']);
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
    raw.prepare(`INSERT INTO friends
      (id, line_user_id, display_name, line_account_id, metadata, created_at, updated_at)
      VALUES ('friend-c', 'U_C', 'しー', 'acc-1', '{"入金確認":"C"}',
              '2026-07-20T12:00:00+09:00', '2026-07-20T12:00:00+09:00')`).run();
    await run();
    client.values = [client.values[0], client.values[2], client.values[1], client.values[3]];

    const result = await run('polling', 'system_poll');

    expect(result).toMatchObject({ importedFields: 0, ignoredIdentityEdits: 0 });
    expect(raw.prepare(`SELECT record_key, sheet_row_number FROM sheets_sync_ledger
      ORDER BY record_key`).all()).toEqual([
      { record_key: 'friend-ayako', sheet_row_number: 3 },
      { record_key: 'friend-b', sheet_row_number: 2 },
      { record_key: 'friend-c', sheet_row_number: 4 },
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

  test('never imports custom values through a fallback shared by identical display identities', async () => {
    raw.prepare(`INSERT INTO friends
      (id, line_user_id, display_name, line_account_id, metadata, created_at, updated_at)
      VALUES ('friend-b', 'U_B', 'あやこ', 'acc-1', '{"入金確認":"B"}',
              '2026-07-20T10:00:00+09:00', '2026-07-20T10:00:00+09:00')`).run();
    await run();
    client.values = [
      client.values[0],
      ['あやこ', 'tampered-b', '2026-07-20T10:00:00+09:00', 'B'],
      ['あやこ', 'tampered-a', '2026-07-20T10:00:00+09:00', '未'],
    ];

    const result = await run('polling', 'system_poll');

    expect(result).toMatchObject({ importedFields: 0, ignoredIdentityEdits: 2, status: 'warning' });
    expect(metadata()).toMatchObject({ 入金確認: '未' });
    expect(metadata('friend-b')).toMatchObject({ 入金確認: 'B' });
    expect(client.values.slice(1).map((row) => [row[1], row[3]])).toEqual([
      ['U_AYAKO', '未'],
      ['U_B', 'B'],
    ]);
  });

  test('reappends an authoritative friend row after the last sheet row is deleted', async () => {
    await run();
    client.values.pop();

    const result = await run('polling', 'system_poll');

    expect(result).toMatchObject({ appendedRows: 1, importedFields: 0 });
    expect(client.values[1]).toEqual(['あやこ', 'U_AYAKO', '2026-07-20T10:00:00+09:00', '未']);
    expect(raw.prepare(`SELECT sheet_row_number FROM sheets_sync_ledger
      WHERE record_key='friend-ayako'`).get()).toEqual({ sheet_row_number: 2 });
  });

  test('reappends a deleted middle friend without confusing the row that shifted up', async () => {
    raw.prepare(`INSERT INTO friends
      (id, line_user_id, display_name, line_account_id, metadata, created_at, updated_at)
      VALUES ('friend-b', 'U_B', 'びー', 'acc-1', '{"入金確認":"B"}',
              '2026-07-20T11:00:00+09:00', '2026-07-20T11:00:00+09:00')`).run();
    await run();
    client.values.splice(1, 1);

    const result = await run('polling', 'system_poll');

    expect(result).toMatchObject({ appendedRows: 1, importedFields: 0 });
    expect(client.values.slice(1).map((row) => row[1])).toEqual(['U_B', 'U_AYAKO']);
    expect(raw.prepare(`SELECT record_key, sheet_row_number FROM sheets_sync_ledger
      ORDER BY record_key`).all()).toEqual([
      { record_key: 'friend-ayako', sheet_row_number: 3 },
      { record_key: 'friend-b', sheet_row_number: 2 },
    ]);
  });

  test('clears only owned cells for a Harness-deleted friend and completes after a DB-failure replay', async () => {
    await run();
    client.values[0].push('会社の数式');
    client.values[1].push('=KEEP_ME()');
    client.values.splice(1, 0, ['外部行', 'U_EXTERNAL', '外部日付', '外部値', '=KEEP_EXTERNAL()']);
    raw.prepare(`DELETE FROM friends WHERE id='friend-ayako'`).run();
    let ledgerCommits = 0;
    db = d1(raw, (sql) => {
      if (sql.includes('INSERT INTO sheets_sync_ledger') && ++ledgerCommits === 2) {
        throw new Error('simulated ledger commit failure');
      }
    });

    await expect(run('polling', 'system_poll')).rejects.toThrow('simulated ledger commit failure');
    expect(client.values[1]).toEqual(['外部行', 'U_EXTERNAL', '外部日付', '外部値', '=KEEP_EXTERNAL()']);
    expect(client.values[2]).toEqual(['', '', '', '', '=KEEP_ME()']);

    await expect(run('polling', 'system_poll')).resolves.toMatchObject({ status: 'success' });
    expect(raw.prepare(`SELECT sheet_row_number, canonical_snapshot_json
      FROM sheets_sync_ledger WHERE record_key='friend-ayako'`).get()).toEqual({
      sheet_row_number: null,
      canonical_snapshot_json: '{}',
    });
    expect(raw.prepare(`SELECT outcome, error_code FROM sheets_sync_audit_log
      WHERE record_key='friend-ayako' ORDER BY apply_sequence DESC LIMIT 1`).get()).toEqual({
      outcome: 'applied', error_code: 'friend_removed_from_harness',
    });
  });

  test('bounds actionable orphan cleanup and resumes past completed tombstones', async () => {
    const insert = raw.prepare(`INSERT INTO friends
      (id, line_user_id, display_name, line_account_id, metadata, created_at, updated_at)
      VALUES (?, ?, ?, 'acc-1', '{"入金確認":"未"}', ?, ?)`);
    for (let index = 1; index <= 20; index += 1) {
      const suffix = String(index).padStart(2, '0');
      const timestamp = `2026-07-20T10:${suffix}:00+09:00`;
      insert.run(`friend-${suffix}`, `U_${suffix}`, `友だち${suffix}`, timestamp, timestamp);
    }
    await run();
    raw.prepare("DELETE FROM friends WHERE line_account_id='acc-1'").run();
    client.readCount = 0;

    const firstCleanup = await run('polling', 'system_poll');

    expect(firstCleanup.status).toBe('warning');
    expect(firstCleanup.warnings.join(' ')).toContain('20件');
    expect(client.readCount).toBeLessThanOrEqual(41);
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sheets_sync_ledger
      WHERE canonical_snapshot_json='{}'`).get()).toEqual({ count: 20 });

    client.readCount = 0;
    await run('polling', 'system_poll');

    expect(client.readCount).toBeLessThanOrEqual(3);
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sheets_sync_ledger
      WHERE canonical_snapshot_json='{}'`).get()).toEqual({ count: 21 });
  });

  test('keeps deleted-friend data when its sheet userId is duplicated and records the unsafe skip', async () => {
    await run();
    client.values.push([...client.values[1]]);
    raw.prepare(`DELETE FROM friends WHERE id='friend-ayako'`).run();

    const result = await run('polling', 'system_poll');

    expect(result.status).toBe('warning');
    expect(client.values.slice(1).map((row) => row[1])).toEqual(['U_AYAKO', 'U_AYAKO']);
    expect(raw.prepare(`SELECT sheet_row_number, canonical_snapshot_json
      FROM sheets_sync_ledger WHERE record_key='friend-ayako'`).get()).toMatchObject({
      sheet_row_number: 2,
      canonical_snapshot_json: expect.stringContaining('U_AYAKO'),
    });
    expect(raw.prepare(`SELECT outcome, error_code FROM sheets_sync_audit_log
      WHERE record_key='friend-ayako' ORDER BY apply_sequence DESC LIMIT 1`).get()).toEqual({
      outcome: 'skipped', error_code: 'unsafe_deleted_friend_row',
    });
  });

  test('keeps userId as a recovery anchor until other deleted-friend cells are cleared', async () => {
    await run();
    raw.prepare(`DELETE FROM friends WHERE id='friend-ayako'`).run();
    let interrupted = false;
    client.afterWrite = (kind) => {
      if (kind === 'batch' && !interrupted) {
        interrupted = true;
        throw new Error('simulated clear interruption');
      }
    };

    await expect(run('polling', 'system_poll')).rejects.toThrow('simulated clear interruption');
    expect(client.values[1]).toEqual(['', 'U_AYAKO', '', '']);
    client.afterWrite = undefined;
    await run('polling', 'system_poll');
    expect(client.values[1]).toEqual(['', '', '', '']);
    expect(raw.prepare(`SELECT sheet_row_number, canonical_snapshot_json FROM sheets_sync_ledger
      WHERE record_key='friend-ayako'`).get()).toEqual({
      sheet_row_number: null, canonical_snapshot_json: '{}',
    });
  });

  test('does not tombstone a blank row without a durable pending-removal marker', async () => {
    await run();
    client.values[1] = ['', '', '', ''];
    raw.prepare(`DELETE FROM friends WHERE id='friend-ayako'`).run();

    const result = await run('polling', 'system_poll');

    expect(result.status).toBe('warning');
    expect(raw.prepare(`SELECT sheet_row_number, canonical_snapshot_json
      FROM sheets_sync_ledger WHERE record_key='friend-ayako'`).get()).toMatchObject({
      sheet_row_number: 2,
      canonical_snapshot_json: expect.stringContaining('U_AYAKO'),
    });
    expect(raw.prepare(`SELECT outcome, error_code FROM sheets_sync_audit_log
      WHERE record_key='friend-ayako' ORDER BY apply_sequence DESC LIMIT 1`).get()).toEqual({
      outcome: 'skipped', error_code: 'unsafe_deleted_friend_row',
    });
  });

  test('releases all shifted ledger row slots before locating a deleted friend', async () => {
    raw.prepare(`INSERT INTO friends
      (id, line_user_id, display_name, line_account_id, metadata, created_at, updated_at)
      VALUES ('friend-b', 'U_B', 'びー', 'acc-1', '{"入金確認":"B"}',
              '2026-07-20T11:00:00+09:00', '2026-07-20T11:00:00+09:00')`).run();
    await run();
    client.values.splice(1, 0, ['外部行', 'U_EXTERNAL', '外部日付', '外部値']);
    raw.prepare(`DELETE FROM friends WHERE id='friend-ayako'`).run();

    await expect(run('polling', 'system_poll')).resolves.toMatchObject({ status: 'success' });

    expect(client.values).toEqual([
      ['表示名', 'userId', '登録日', '入金確認'],
      ['外部行', 'U_EXTERNAL', '外部日付', '外部値'],
      ['', '', '', ''],
      ['びー', 'U_B', '2026-07-20T11:00:00+09:00', 'B'],
    ]);
    expect(raw.prepare(`SELECT record_key, sheet_row_number FROM sheets_sync_ledger
      ORDER BY record_key`).all()).toEqual([
      { record_key: 'friend-ayako', sheet_row_number: null },
      { record_key: 'friend-b', sheet_row_number: 4 },
    ]);
  });

  test('does not clear when a row moves between the initial read and destructive preflight', async () => {
    await run();
    client.values.push(['外部行', 'U_EXTERNAL', '外部日付', '外部値']);
    raw.prepare(`DELETE FROM friends WHERE id='friend-ayako'`).run();
    client.afterRead = () => {
      client.afterRead = undefined;
      client.values.splice(1, 0, client.values.pop()!);
    };

    const result = await run('polling', 'system_poll');

    expect(result.status).toBe('warning');
    expect(client.values.slice(1)).toEqual([
      ['外部行', 'U_EXTERNAL', '外部日付', '外部値'],
      ['あやこ', 'U_AYAKO', '2026-07-20T10:00:00+09:00', '未'],
    ]);
    expect(raw.prepare(`SELECT outcome, error_code FROM sheets_sync_audit_log
      WHERE record_key='friend-ayako' ORDER BY apply_sequence DESC LIMIT 1`).get()).toEqual({
      outcome: 'skipped', error_code: 'unsafe_deleted_friend_row',
    });
  });

  test('rechecks the recovery userId after content clear before erasing identity', async () => {
    await run();
    client.values.push(['外部行', 'U_EXTERNAL', '外部日付', '外部値']);
    raw.prepare(`DELETE FROM friends WHERE id='friend-ayako'`).run();
    let moved = false;
    client.afterWrite = (kind) => {
      if (kind === 'batch' && !moved) {
        moved = true;
        [client.values[1], client.values[2]] = [client.values[2], client.values[1]];
      }
    };

    const interrupted = await run('polling', 'system_poll');

    expect(interrupted.status).toBe('warning');
    expect(client.values[1]).toEqual(['外部行', 'U_EXTERNAL', '外部日付', '外部値']);
    expect(client.values[2]).toEqual(['', 'U_AYAKO', '', '']);
    client.afterWrite = undefined;
    await run('polling', 'system_poll');
    expect(client.values[1]).toEqual(['外部行', 'U_EXTERNAL', '外部日付', '外部値']);
    expect(client.values[2]).toEqual(['', '', '', '']);
  });

  test('adopts the existing row for a recreated friend with the same userId without clearing it', async () => {
    await run();
    raw.prepare(`DELETE FROM friends WHERE id='friend-ayako'`).run();
    raw.prepare(`INSERT INTO friends
      (id, line_user_id, display_name, line_account_id, metadata, created_at, updated_at)
      VALUES ('friend-ayako-new', 'U_AYAKO', 'あやこ再登録', 'acc-1', '{"入金確認":"再登録"}',
              '2026-07-21T11:00:00+09:00', '2026-07-21T11:00:00+09:00')`).run();

    await run('polling', 'system_poll');

    expect(client.values[1]).toEqual([
      'あやこ再登録', 'U_AYAKO', '2026-07-21T11:00:00+09:00', '再登録',
    ]);
    expect(raw.prepare(`SELECT record_key, sheet_row_number, canonical_snapshot_json
      FROM sheets_sync_ledger ORDER BY record_key`).all()).toEqual([
      { record_key: 'friend-ayako', sheet_row_number: null, canonical_snapshot_json: '{}' },
      expect.objectContaining({ record_key: 'friend-ayako-new', sheet_row_number: 2 }),
    ]);
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

  test('keeps a newer Harness field update that races with an observed sheet edit', async () => {
    await run();
    client.values[1][3] = 'シート更新';
    let injected = false;
    db = d1(raw, (sql) => {
      if (injected || !sql.includes('UPDATE friends') || !sql.includes('metadata IS ?')) return;
      injected = true;
      raw.prepare(`UPDATE friends SET metadata='{"\u5165\u91d1\u78ba\u8a8d":"Harness newer","\u672a\u9078\u629e":"\u4fdd\u6301"}',
        updated_at='2026-07-21T11:59:00+09:00' WHERE id='friend-ayako'`).run();
    });

    const result = await run('webhook', 'editor@example.test');

    expect(result).toMatchObject({ importedFields: 0, updatedRows: 1 });
    expect(metadata()).toMatchObject({ 入金確認: 'Harness newer', 未選択: '保持' });
    expect(client.values[1][3]).toBe('Harness newer');
    expect(raw.prepare(`SELECT conflict_resolution FROM sheets_sync_audit_log
      WHERE conflict_resolution IS NOT NULL ORDER BY apply_sequence DESC LIMIT 1`).get())
      .toEqual({ conflict_resolution: 'harness_wins' });
  });

  test('records a racing equal value as convergence without a redundant write', async () => {
    await run();
    client.values[1][3] = '同時に同じ';
    let injected = false;
    db = d1(raw, (sql) => {
      if (injected || !sql.includes('UPDATE friends') || !sql.includes('metadata IS ?')) return;
      injected = true;
      raw.prepare(`UPDATE friends SET metadata='{"入金確認":"同時に同じ","未選択":"保持"}',
        updated_at='2026-07-21T11:59:00+09:00' WHERE id='friend-ayako'`).run();
    });

    const result = await run('webhook', 'editor@example.test');

    expect(result).toMatchObject({ importedFields: 0, updatedRows: 0 });
    expect(client.values[1][3]).toBe('同時に同じ');
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sheets_sync_audit_details
      WHERE old_value = new_value`).get()).toEqual({ count: 0 });
  });

  test('attributes and imports only sheet edits inside the signed webhook range', async () => {
    raw.prepare(`INSERT INTO friends
      (id, line_user_id, display_name, line_account_id, metadata, created_at, updated_at)
      VALUES ('friend-b', 'U_B', 'びー', 'acc-1', '{"入金確認":"B"}',
              '2026-07-20T11:00:00+09:00', '2026-07-20T11:00:00+09:00')`).run();
    await run();
    client.values[1][3] = 'A sheet';
    client.values[2][3] = 'B sheet';

    const webhook = await run('webhook', 'editor-a@example.test', {
      rowStart: 2, rowEnd: 2, columnStart: 4, columnEnd: 4,
    });

    expect(webhook.importedFields).toBe(1);
    expect(metadata()).toMatchObject({ 入金確認: 'A sheet' });
    expect(metadata('friend-b')).toMatchObject({ 入金確認: 'B' });
    expect(raw.prepare(`SELECT DISTINCT actor FROM sheets_sync_audit_details
      WHERE source='webhook'`).all()).toEqual([{ actor: 'editor-a@example.test' }]);
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sheets_sync_audit_details
      WHERE source='webhook' AND old_value='B' AND new_value='B sheet'`).get()).toEqual({ count: 0 });

    const polling = await run('polling', 'system_poll');
    expect(polling.importedFields).toBe(1);
    expect(metadata('friend-b')).toMatchObject({ 入金確認: 'B sheet' });
  });

  test('imports the signed single-cell snapshot instead of a later sheet reread', async () => {
    await run();
    client.values[1][3] = 'さらに後の編集';

    const result = await run(
      'webhook',
      'editor-snapshot@example.test',
      { rowStart: 2, rowEnd: 2, columnStart: 4, columnEnd: 4 },
      {
        rowNumber: 2, columnNumber: 4, header: '入金確認', rowUserId: 'U_AYAKO',
        value: '署名済み編集', oldValue: '未', oldValueKnown: true,
      },
      'event-snapshot-0001',
    );

    expect(result.importedFields).toBe(1);
    expect(metadata()).toMatchObject({ 入金確認: '署名済み編集' });
    expect(raw.prepare(`SELECT webhook_event_id FROM sheets_sync_audit_log
      WHERE webhook_event_id IS NOT NULL`).get()).toEqual({ webhook_event_id: 'event-snapshot-0001' });
    expect(raw.prepare(`SELECT actor, old_value, new_value FROM sheets_sync_audit_details
      WHERE source='webhook' ORDER BY created_at DESC LIMIT 1`).get()).toEqual({
      actor: 'editor-snapshot@example.test', old_value: '未', new_value: '署名済み編集',
    });
  });

  test('audits and skips a signed edit after its friend row moved', async () => {
    raw.prepare(`INSERT INTO friends
      (id, line_user_id, display_name, line_account_id, metadata, created_at, updated_at)
      VALUES ('friend-b', 'U_B', 'びー', 'acc-1', '{"入金確認":"B"}',
              '2026-07-20T11:00:00+09:00', '2026-07-20T11:00:00+09:00')`).run();
    await run();
    client.values = [
      client.values[0],
      client.values[2],
      [...client.values[1].slice(0, 3), 'Aの編集'],
    ];

    const result = await run(
      'webhook',
      'delayed-editor@example.test',
      { rowStart: 2, rowEnd: 2, columnStart: 4, columnEnd: 4 },
      {
        rowNumber: 2, columnNumber: 4, header: '入金確認', rowUserId: 'U_AYAKO',
        value: 'Aの編集', oldValue: '未', oldValueKnown: true,
      },
      'event-moved-row-0001',
    );

    expect(result.status).toBe('warning');
    expect(result.importedFields).toBe(0);
    expect(metadata()).toMatchObject({ 入金確認: '未' });
    expect(metadata('friend-b')).toMatchObject({ 入金確認: 'B' });
    expect(raw.prepare(`SELECT outcome, error_code FROM sheets_sync_audit_log
      WHERE webhook_event_id='event-moved-row-0001'`).get()).toEqual({
      outcome: 'skipped', error_code: 'stale_webhook_target',
    });

    await run('polling', 'system_poll');
    expect(metadata()).toMatchObject({ 入金確認: 'Aの編集' });
  });

  test('audits and skips signed edits to an unselected company-owned column', async () => {
    await run();
    client.values[0].push('社内メモ');
    client.values[1].push('会社だけの値');

    const result = await run(
      'webhook',
      'editor@example.test',
      { rowStart: 2, rowEnd: 2, columnStart: 5, columnEnd: 5 },
      {
        rowNumber: 2, columnNumber: 5, header: '社内メモ', rowUserId: 'U_AYAKO',
        value: '編集後', oldValue: '会社だけの値', oldValueKnown: true,
      },
      'event-unselected-001',
    );

    expect(result).toMatchObject({ status: 'warning', importedFields: 0 });
    expect(metadata()).toMatchObject({ 入金確認: '未', 未選択: '保持' });
    expect(raw.prepare(`SELECT outcome, error_code FROM sheets_sync_audit_log
      WHERE webhook_event_id='event-unselected-001'`).get()).toEqual({
      outcome: 'skipped', error_code: 'unselected_webhook_column',
    });
  });

  test('audits and skips a signed edit when the row userId is duplicated', async () => {
    await run();
    client.values.push(['複製', 'U_AYAKO', '2026-07-20T10:00:00+09:00', '複製値']);

    const result = await run(
      'webhook',
      'editor@example.test',
      { rowStart: 2, rowEnd: 2, columnStart: 4, columnEnd: 4 },
      {
        rowNumber: 2, columnNumber: 4, header: '入金確認', rowUserId: 'U_AYAKO',
        value: '編集後', oldValue: '未', oldValueKnown: true,
      },
      'event-duplicate-user-1',
    );

    expect(result).toMatchObject({ status: 'warning', importedFields: 0 });
    expect(metadata()).toMatchObject({ 入金確認: '未' });
    expect(raw.prepare(`SELECT outcome, error_code FROM sheets_sync_audit_log
      WHERE webhook_event_id='event-duplicate-user-1'`).get()).toEqual({
      outcome: 'skipped', error_code: 'unsafe_webhook_identity',
    });
  });

  test('does not let an old unknown-before-value event overwrite the current sheet value', async () => {
    await run();
    client.values[1][3] = '現在値B';

    const stale = await run(
      'webhook',
      'editor@example.test',
      { rowStart: 2, rowEnd: 2, columnStart: 4, columnEnd: 4 },
      {
        rowNumber: 2, columnNumber: 4, header: '入金確認', rowUserId: 'U_AYAKO',
        value: '古い値A', oldValue: null, oldValueKnown: false,
      },
      'event-unknown-old-001',
    );

    expect(stale).toMatchObject({ status: 'warning', importedFields: 0 });
    expect(metadata()).toMatchObject({ 入金確認: '未' });
    expect(raw.prepare(`SELECT outcome, error_code FROM sheets_sync_audit_log
      WHERE webhook_event_id='event-unknown-old-001'`).get()).toEqual({
      outcome: 'skipped', error_code: 'stale_webhook_event',
    });
    await run('polling', 'system_poll');
    expect(metadata()).toMatchObject({ 入金確認: '現在値B' });
  });

  test('audits a protected identity edit even when its signed value already equals Harness', async () => {
    await run();

    const result = await run(
      'webhook',
      'editor@example.test',
      { rowStart: 2, rowEnd: 2, columnStart: 1, columnEnd: 1 },
      {
        rowNumber: 2, columnNumber: 1, header: '表示名', rowUserId: 'U_AYAKO',
        value: 'あやこ', oldValue: '一時的な改変', oldValueKnown: true,
      },
      'event-identity-noop-1',
    );

    expect(result).toMatchObject({ status: 'warning', ignoredIdentityEdits: 1 });
    expect(raw.prepare(`SELECT outcome, error_code FROM sheets_sync_audit_log
      WHERE webhook_event_id='event-identity-noop-1'`).get()).toEqual({
      outcome: 'skipped', error_code: 'identity_read_only',
    });
  });

  test('classifies a protected identity webhook as ignored before any ledger baseline exists', async () => {
    client.values = [
      ['表示名', 'userId', '登録日', '入金確認'],
      ['改変名', 'U_AYAKO', '2026-07-20T10:00:00+09:00', '未'],
    ];

    const result = await run(
      'webhook',
      'editor@example.test',
      { rowStart: 2, rowEnd: 2, columnStart: 1, columnEnd: 1 },
      {
        rowNumber: 2, columnNumber: 1, header: '表示名', rowUserId: 'U_AYAKO',
        value: '改変名', oldValue: 'あやこ', oldValueKnown: true,
      },
      'event-identity-first-1',
    );

    expect(result).toMatchObject({ status: 'warning', ignoredIdentityEdits: 1 });
    expect(client.values[1][0]).toBe('あやこ');
    expect(raw.prepare(`SELECT outcome, error_code FROM sheets_sync_audit_log
      WHERE webhook_event_id='event-identity-first-1'`).get()).toEqual({
      outcome: 'skipped', error_code: 'identity_read_only',
    });
  });

  test('rejects impossible signed cell coordinates without allocating a padded sheet', () => {
    expect(parseFriendLedgerWebhookEventPayload({
      range: {
        rowStart: Number.MAX_SAFE_INTEGER,
        rowEnd: Number.MAX_SAFE_INTEGER,
        columnStart: 4,
        columnEnd: 4,
      },
      snapshot: {
        rowNumber: Number.MAX_SAFE_INTEGER,
        columnNumber: 4,
        header: '入金確認',
        rowUserId: 'U_AYAKO',
        value: 'private',
        oldValue: 'old',
        oldValueKnown: true,
      },
    })).toBeNull();
  });

  test('logs and skips an out-of-order snapshot after a newer edit already won', async () => {
    await run();
    client.values[1][3] = '新しい編集';
    await run(
      'webhook',
      'newer@example.test',
      { rowStart: 2, rowEnd: 2, columnStart: 4, columnEnd: 4 },
      {
        rowNumber: 2, columnNumber: 4, header: '入金確認', rowUserId: 'U_AYAKO',
        value: '新しい編集', oldValue: '中間値', oldValueKnown: true,
      },
      'event-newer-0000001',
    );

    const stale = await run(
      'webhook',
      'older@example.test',
      { rowStart: 2, rowEnd: 2, columnStart: 4, columnEnd: 4 },
      {
        rowNumber: 2, columnNumber: 4, header: '入金確認', rowUserId: 'U_AYAKO',
        value: '中間値', oldValue: '未', oldValueKnown: true,
      },
      'event-older-0000001',
    );

    expect(stale.status).toBe('warning');
    expect(stale.warnings.join(' ')).toContain('古い編集通知');
    expect(metadata()).toMatchObject({ 入金確認: '新しい編集' });
    expect(raw.prepare(`SELECT outcome, error_code FROM sheets_sync_audit_log
      WHERE webhook_event_id='event-older-0000001'`).get()).toEqual({
      outcome: 'skipped', error_code: 'stale_webhook_event',
    });
  });

  test('leases, applies, and redacts a durable signed webhook event', async () => {
    await run();
    client.values[1][3] = 'live-after-edit';
    connection = (await getSheetsConnection(db, 'acc-1', connection.id))!;
    await enqueueSheetsWebhookEvent(db, 'acc-1', connection.id, connection.configVersion, {
      eventId: 'event-durable-000001',
      actor: 'durable-editor@example.test',
      actorKind: 'google_email',
      occurredAt: connection.updatedAt,
      payload: {
        range: { rowStart: 2, rowEnd: 2, columnStart: 4, columnEnd: 4 },
        snapshot: {
          rowNumber: 2, columnNumber: 4, header: '入金確認', rowUserId: 'U_AYAKO',
          value: 'durable-value', oldValue: '未', oldValueKnown: true,
        },
      },
      receivedAt: '2026-07-21T12:00:00+09:00',
    });

    const drained = await drainFriendLedgerWebhookEvents({
      db,
      connection,
      client,
      maxEvents: 5,
      now: () => new Date('2026-07-21T03:00:01.000Z'),
    });

    expect(drained).toMatchObject({ attempted: 1, applied: 1, deferred: 0, dead: 0 });
    expect(metadata()).toMatchObject({ 入金確認: 'durable-value' });
    expect(raw.prepare(`SELECT status, actor, payload_json, attempts, processing_token
      FROM sheets_sync_webhook_events WHERE event_id='event-durable-000001'`).get()).toEqual({
      status: 'applied', actor: 'redacted', payload_json: null, attempts: 0, processing_token: null,
    });
  });

  test('does not spend retry attempts while a manual sync owns the connection lock', async () => {
    await run();
    connection = (await getSheetsConnection(db, 'acc-1', connection.id))!;
    await enqueueSheetsWebhookEvent(db, 'acc-1', connection.id, connection.configVersion, {
      eventId: 'event-busy-000000001',
      actor: 'busy-editor@example.test',
      actorKind: 'google_email',
      occurredAt: '2026-07-21T03:00:00.000Z',
      payload: {
        range: { rowStart: 2, rowEnd: 2, columnStart: 4, columnEnd: 4 },
        snapshot: {
          rowNumber: 2, columnNumber: 4, header: '入金確認', rowUserId: 'U_AYAKO',
          value: '待機', oldValue: '未', oldValueKnown: true,
        },
      },
      receivedAt: '2026-07-21T12:00:00+09:00',
    });
    raw.prepare(`UPDATE sheets_connections
      SET sync_lock_token='manual-owner', sync_lock_expires_at='2026-07-21T12:02:00+09:00'
      WHERE id=?`).run(connection.id);

    const drained = await drainFriendLedgerWebhookEvents({
      db,
      connection,
      client,
      maxEvents: 1,
      now: () => new Date('2026-07-21T03:00:01.000Z'),
    });

    expect(drained).toMatchObject({ attempted: 0, applied: 0, deferred: 0, dead: 0 });
    expect(raw.prepare(`SELECT status, attempts, processing_token FROM sheets_sync_webhook_events
      WHERE event_id='event-busy-000000001'`).get()).toEqual({
      status: 'pending', attempts: 0, processing_token: null,
    });
  });

  test('finishes a recovered event when its immutable audit already proves application', async () => {
    await run();
    connection = (await getSheetsConnection(db, 'acc-1', connection.id))!;
    const eventId = 'event-recovery-000001';
    await enqueueSheetsWebhookEvent(db, 'acc-1', connection.id, connection.configVersion, {
      eventId,
      actor: 'recovered-editor@example.test',
      actorKind: 'google_email',
      occurredAt: '2026-07-21T03:00:00.000Z',
      payload: {
        range: { rowStart: 2, rowEnd: 2, columnStart: 4, columnEnd: 4 },
        snapshot: {
          rowNumber: 2, columnNumber: 4, header: '入金確認', rowUserId: 'U_AYAKO',
          value: '再実行しない', oldValue: '未', oldValueKnown: true,
        },
      },
      receivedAt: '2026-07-21T12:00:00+09:00',
    });
    raw.prepare(`INSERT INTO sheets_sync_audit_log
      (id, connection_id, connection_version, apply_sequence, line_account_id, form_id,
       spreadsheet_id, sheet_name, record_key, sheet_row_number, direction, action, outcome,
       webhook_event_id)
      VALUES ('audit-recovered', ?, ?, 999, 'acc-1', 'friend-ledger', 'sheet-1', '友だち台帳',
              'friend-ayako', 2, 'from_sheets', 'update', 'applied', ?)`).run(
      connection.id,
      connection.configVersion,
      eventId,
    );

    const drained = await drainFriendLedgerWebhookEvents({
      db,
      connection,
      client,
      maxEvents: 1,
      now: () => new Date('2026-07-21T03:00:01.000Z'),
    });

    expect(drained).toMatchObject({ attempted: 1, applied: 1 });
    expect(metadata()).toMatchObject({ 入金確認: '未' });
    expect(raw.prepare(`SELECT status, payload_json FROM sheets_sync_webhook_events
      WHERE event_id=?`).get(eventId)).toEqual({ status: 'applied', payload_json: null });
  });

  test('redacts expired webhook PII even while Google credentials are unavailable', async () => {
    connection = (await getSheetsConnection(db, 'acc-1', connection.id))!;
    await enqueueSheetsWebhookEvent(db, 'acc-1', connection.id, connection.configVersion, {
      eventId: 'event-no-creds-000001',
      actor: 'no-creds-editor@example.test',
      actorKind: 'google_email',
      occurredAt: '2026-07-19T03:00:00.000Z',
      payload: {
        range: { rowStart: 2, rowEnd: 2, columnStart: 4, columnEnd: 4 },
        snapshot: {
          rowNumber: 2, columnNumber: 4, header: '入金確認', rowUserId: 'U_AYAKO',
          value: 'private', oldValue: null, oldValueKnown: false,
        },
      },
      receivedAt: '2026-07-19T12:00:00+09:00',
    });

    await expect(runFriendLedgerPolling({
      db,
      credentialsJson: undefined,
      maxConnections: 10,
      now: () => new Date('2026-07-21T03:00:00.000Z'),
    })).resolves.toEqual({ attempted: 0, succeeded: 0, warnings: 0, failed: 0 });
    expect(raw.prepare(`SELECT status, actor, payload_json FROM sheets_sync_webhook_events
      WHERE event_id='event-no-creds-000001'`).get()).toEqual({
      status: 'dead', actor: 'redacted', payload_json: null,
    });
  });

  test('keeps a skipped webhook warning observable after the same cron cycle polls', async () => {
    await run();
    client.values[0].push('社内メモ');
    client.values[1].push('会社の値');
    connection = (await getSheetsConnection(db, 'acc-1', connection.id))!;
    await enqueueSheetsWebhookEvent(db, 'acc-1', connection.id, connection.configVersion, {
      eventId: 'event-cron-warning-01',
      actor: 'editor@example.test',
      actorKind: 'google_email',
      occurredAt: connection.updatedAt,
      payload: {
        range: { rowStart: 2, rowEnd: 2, columnStart: 5, columnEnd: 5 },
        snapshot: {
          rowNumber: 2, columnNumber: 5, header: '社内メモ', rowUserId: 'U_AYAKO',
          value: '編集値', oldValue: '会社の値', oldValueKnown: true,
        },
      },
      receivedAt: '2026-07-21T12:00:00+09:00',
    });

    await expect(runFriendLedgerPolling({
      db,
      client,
      maxConnections: 10,
      now: () => new Date('2026-07-21T03:00:01.000Z'),
    })).resolves.toMatchObject({ attempted: 1, warnings: 1, failed: 0 });
    expect(raw.prepare(`SELECT last_sync_status, last_sync_warning FROM sheets_connections
      WHERE id=?`).get(connection.id)).toEqual({
      last_sync_status: 'warning',
      last_sync_warning: expect.stringContaining('選ばれていない列'),
    });
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

  test('truncates sheet-provided headings before persisting polling warnings', async () => {
    await run();
    const prefix = '長'.repeat(200);
    const unsafeHeader = `${prefix}SECRET_TAIL`;
    client.values[0].push(unsafeHeader, unsafeHeader);

    const result = await run('polling', 'system_poll');
    const stored = raw.prepare(`SELECT last_sync_warning FROM sheets_connections WHERE id=?`)
      .get(connection.id) as { last_sync_warning: string };

    expect(result.status).toBe('warning');
    expect(result.warnings.join(' ')).toContain(prefix);
    expect(result.warnings.join(' ')).not.toContain('SECRET_TAIL');
    expect(stored.last_sync_warning).not.toContain('SECRET_TAIL');
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
