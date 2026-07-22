import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createSheetsConnection,
  updateSheetsConnection,
  type SheetsConnection,
} from '@line-crm/db';
import {
  enqueueSheetsSyncPollingJobs,
  getLatestSheetsSyncJob,
  processNextSheetsSyncJob,
  startSheetsSyncJob,
} from './sheets-sync-jobs.js';

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

let raw: Database.Database;
let db: D1Database;
let connection: SheetsConnection;

function insertSubmissions(count: number): void {
  const insert = raw.prepare(`INSERT INTO internal_form_submissions
    (id, form_id, friend_id, answers_json, submitted_at, created_at)
    VALUES (?, 'form-1', 'friend-1', ?, ?, ?)`);
  raw.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const suffix = String(index).padStart(4, '0');
      const timestamp = `2026-07-21T10:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}+09:00`;
      insert.run(`ifs-${suffix}`, JSON.stringify({ q1: `回答${suffix}` }), timestamp, timestamp);
    }
  })();
}

beforeEach(async () => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  raw.exec(readFileSync(join(DB_ROOT, 'bootstrap.sql'), 'utf8'));
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('acc-1', 'channel-1', 'A', 'token', 'secret')`).run();
  raw.prepare(`INSERT INTO formaloo_forms (id, title, definition_json, render_backend, line_account_id)
    VALUES ('form-1', '回答フォーム', '{"fields":[],"logic":[]}', 'internal', 'acc-1')`).run();
  raw.prepare(`INSERT INTO friends
    (id, line_user_id, display_name, line_account_id, metadata, created_at, updated_at)
    VALUES ('friend-1', 'U_1', 'あやこ', 'acc-1', '{}', '2026-07-20T10:00:00+09:00', '2026-07-20T10:00:00+09:00')`).run();
  db = d1(raw);
  connection = await createSheetsConnection(db, {
    lineAccountId: 'acc-1',
    formId: 'form-1',
    spreadsheetId: 'sheet-1',
    sheetName: '友だち台帳',
    syncDirection: 'bidirectional',
    friendLedgerEnabled: true,
    formResultsEnabled: true,
    formResultsSheetName: '回答',
  });
});

describe('target-aware sheets sync jobs', () => {
  test('polling enqueues one job per enabled target', async () => {
    const summary = await enqueueSheetsSyncPollingJobs(db, 10);
    expect(summary).toEqual({ enqueued: 2, runnable: 2 });
    const targets = (raw.prepare(`SELECT target FROM sheets_sync_jobs ORDER BY target`).all() as { target: string }[])
      .map((row) => row.target);
    expect(targets).toEqual(['form_results', 'ledger']);
  });

  test('polling skips the disabled target', async () => {
    raw.prepare('UPDATE sheets_connections SET friend_ledger_enabled = 0 WHERE id = ?').run(connection.id);
    const summary = await enqueueSheetsSyncPollingJobs(db, 10);
    expect(summary).toEqual({ enqueued: 1, runnable: 1 });
    const targets = (raw.prepare(`SELECT target FROM sheets_sync_jobs`).all() as { target: string }[])
      .map((row) => row.target);
    expect(targets).toEqual(['form_results']);
  });

  test('a manual results job snapshots the verified submission set', async () => {
    insertSubmissions(3);
    const job = await startSheetsSyncJob({
      db, connection, source: 'manual', actor: 'owner-1', target: 'form_results',
    });
    expect(job).toMatchObject({ target: 'form_results', status: 'running', totalCount: 3 });
    // A ledger job for the same connection can run at the same time.
    const ledgerJob = await startSheetsSyncJob({ db, connection, source: 'manual', actor: 'owner-1' });
    expect(ledgerJob).toMatchObject({ target: 'ledger', status: 'running' });
    expect(ledgerJob.id).not.toBe(job.id);
  });

  test('routes a form_results job to the results engine and advances the submission cursor', async () => {
    insertSubmissions(450);
    await startSheetsSyncJob({
      db, connection, source: 'manual', actor: 'owner-1', target: 'form_results',
    });
    const cursors = [
      { submittedAt: '2026-07-21T10:03:19+09:00', submissionId: 'ifs-0199' },
      { submittedAt: '2026-07-21T10:06:39+09:00', submissionId: 'ifs-0399' },
      { submittedAt: '2026-07-21T10:07:29+09:00', submissionId: 'ifs-0449' },
    ];
    const syncResults = vi.fn()
      .mockResolvedValueOnce({
        status: 'running', warning: null, warnings: [], busy: false,
        appendedRows: 200, updatedRows: 0, importedFields: 0, ignoredIdentityEdits: 0,
        chunk: { processed: 200, hasMore: true, cursor: cursors[0] },
      })
      .mockResolvedValueOnce({
        status: 'running', warning: null, warnings: [], busy: false,
        appendedRows: 200, updatedRows: 0, importedFields: 0, ignoredIdentityEdits: 0,
        chunk: { processed: 200, hasMore: true, cursor: cursors[1] },
      })
      .mockResolvedValueOnce({
        status: 'success', warning: null, warnings: [], busy: false,
        appendedRows: 50, updatedRows: 0, importedFields: 0, ignoredIdentityEdits: 0,
        chunk: { processed: 50, hasMore: false, cursor: cursors[2] },
      });
    const ledgerSync = vi.fn();

    const first = await processNextSheetsSyncJob({ db, sync: ledgerSync, syncResults, chunkSize: 200 });
    expect(first.job).toMatchObject({ target: 'form_results', status: 'running', processedCount: 200, totalCount: 450 });
    const second = await processNextSheetsSyncJob({ db, sync: ledgerSync, syncResults, chunkSize: 200 });
    expect(second.job).toMatchObject({ status: 'running', processedCount: 400 });
    const third = await processNextSheetsSyncJob({ db, sync: ledgerSync, syncResults, chunkSize: 200 });
    expect(third.job).toMatchObject({ status: 'success', processedCount: 450, totalCount: 450 });
    expect(ledgerSync).not.toHaveBeenCalled();
    expect(syncResults).toHaveBeenNthCalledWith(2, expect.objectContaining({
      chunk: expect.objectContaining({ after: cursors[0], limit: 200 }),
    }));
    const latest = await getLatestSheetsSyncJob(db, 'acc-1', connection.id, 'form_results');
    expect(latest).toMatchObject({
      target: 'form_results',
      status: 'success',
      lastFriendId: 'ifs-0449',
    });
  });

  test('keeps ledger jobs on the ledger engine', async () => {
    const syncResults = vi.fn();
    const ledgerSync = vi.fn().mockResolvedValue({
      status: 'success', warning: null, warnings: [], busy: false,
      appendedRows: 1, updatedRows: 0, importedFields: 0, ignoredIdentityEdits: 0,
      chunk: { processed: 1, hasMore: false, cursor: { createdAt: '2026-07-20T10:00:00+09:00', friendId: 'friend-1' } },
    });
    await startSheetsSyncJob({ db, connection, source: 'manual', actor: 'owner-1' });
    const result = await processNextSheetsSyncJob({ db, sync: ledgerSync, syncResults, chunkSize: 200 });
    expect(result.job).toMatchObject({ target: 'ledger', status: 'success' });
    expect(syncResults).not.toHaveBeenCalled();
    expect(ledgerSync).toHaveBeenCalledTimes(1);
  });

  test('keeps a results cursor running when only the ledger flag is turned off', async () => {
    insertSubmissions(3);
    const started = await startSheetsSyncJob({
      db,
      connection,
      source: 'manual',
      actor: 'owner-1',
      target: 'form_results',
    });
    const cursor = { submittedAt: '2026-07-21T10:00:01+09:00', submissionId: 'ifs-0001' };
    const finalCursor = { submittedAt: '2026-07-21T10:00:02+09:00', submissionId: 'ifs-0002' };
    const syncResults = vi.fn()
      .mockResolvedValueOnce({
        status: 'running', warning: null, warnings: [], busy: false,
        appendedRows: 2, updatedRows: 0, importedFields: 0, ignoredIdentityEdits: 0,
        chunk: { processed: 2, hasMore: true, cursor },
      })
      .mockResolvedValueOnce({
        status: 'success', warning: null, warnings: [], busy: false,
        appendedRows: 1, updatedRows: 0, importedFields: 0, ignoredIdentityEdits: 0,
        chunk: { processed: 1, hasMore: false, cursor: finalCursor },
      });

    const first = await processNextSheetsSyncJob({
      db,
      sync: vi.fn(),
      syncResults,
      chunkSize: 2,
    });
    expect(first.job).toMatchObject({ status: 'running', processedCount: 2 });

    connection = (await updateSheetsConnection(db, 'acc-1', connection.id, {
      spreadsheetId: connection.spreadsheetId,
      sheetName: connection.sheetName,
      syncDirection: connection.syncDirection,
      friendLedgerEnabled: false,
    }))!;
    expect(connection.configVersion).toBe(started.configVersion);

    const second = await processNextSheetsSyncJob({
      db,
      sync: vi.fn(),
      syncResults,
      chunkSize: 2,
    });
    expect(second.job).toMatchObject({
      target: 'form_results',
      status: 'success',
      processedCount: 3,
      lastFriendId: 'ifs-0002',
    });
    expect(syncResults).toHaveBeenNthCalledWith(2, expect.objectContaining({
      chunk: expect.objectContaining({ after: cursor }),
    }));
  });
});
