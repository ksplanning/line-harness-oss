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
  processSheetsSyncJobBatch,
  startSheetsSyncJobsForFormMutation,
  startSheetsSyncJob,
  syncSheetsAfterFormMutation,
} from './sheets-sync-jobs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');

type MockStatement = D1PreparedStatement & { __exec: () => { meta: { changes: number } } };

function d1(
  raw: Database.Database,
  beforeFirst?: (sql: string) => Promise<void>,
): D1Database {
  const prepare = (sql: string): MockStatement => {
    const statement = raw.prepare(sql);
    let params: unknown[] = [];
    const api = {
      bind(...args: unknown[]) { params = args; return api; },
      async first<T>() {
        await beforeFirst?.(sql);
        return (statement.get(...(params as never[])) as T) ?? null;
      },
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
  test('a form mutation starts each enabled target once and coalesces a repeated burst', async () => {
    const first = await startSheetsSyncJobsForFormMutation({
      db,
      lineAccountId: 'acc-1',
      formId: 'form-1',
      actor: 'system_internal_form_submission',
    });
    const repeated = await startSheetsSyncJobsForFormMutation({
      db,
      lineAccountId: 'acc-1',
      formId: 'form-1',
      actor: 'system_internal_form_submission',
    });

    expect(first.map((job) => job.target).sort()).toEqual(['form_results', 'ledger']);
    expect(repeated.map((job) => job.id).sort()).toEqual(first.map((job) => job.id).sort());
    expect(raw.prepare('SELECT COUNT(*) AS count FROM sheets_sync_jobs').get()).toEqual({ count: 2 });
  });

  test('a form mutation is a no-op without credentials or an active matching connection', async () => {
    const forbiddenDb = {
      prepare() { throw new Error('DB must not be read without credentials'); },
    } as unknown as D1Database;
    await expect(syncSheetsAfterFormMutation({
      db: forbiddenDb,
      lineAccountId: 'acc-1',
      formId: 'form-1',
      actor: 'system_internal_form_submission',
      credentialsJson: undefined,
    })).resolves.toBeUndefined();

    const sync = vi.fn();
    const syncResults = vi.fn();
    await expect(syncSheetsAfterFormMutation({
      db,
      lineAccountId: 'acc-1',
      formId: 'form-without-connection',
      actor: 'system_internal_form_submission',
      credentialsJson: '{}',
      sync,
      syncResults,
    })).resolves.toBeUndefined();
    expect(sync).not.toHaveBeenCalled();
    expect(syncResults).not.toHaveBeenCalled();
    expect(raw.prepare('SELECT COUNT(*) AS count FROM sheets_sync_jobs').get()).toEqual({ count: 0 });

    raw.prepare('UPDATE sheets_connections SET is_active = 0 WHERE id = ?').run(connection.id);
    const jobs = await startSheetsSyncJobsForFormMutation({
      db,
      lineAccountId: 'acc-1',
      formId: 'form-1',
      actor: 'system_internal_form_submission',
    });
    expect(jobs).toEqual([]);
    expect(raw.prepare('SELECT COUNT(*) AS count FROM sheets_sync_jobs').get()).toEqual({ count: 0 });
  });

  test('a form mutation advances its durable results job inline', async () => {
    raw.prepare('UPDATE sheets_connections SET friend_ledger_enabled = 0 WHERE id = ?').run(connection.id);
    const client = {
      readValues: vi.fn().mockResolvedValue({ majorDimension: 'ROWS', values: [] }),
      ensureColumnCapacity: vi.fn().mockResolvedValue({ spreadsheetId: 'sheet-1', appendedColumns: 0 }),
      updateValues: vi.fn().mockResolvedValue({ spreadsheetId: 'sheet-1', updatedRows: 1 }),
      appendValues: vi.fn().mockResolvedValue({ spreadsheetId: 'sheet-1' }),
      batchUpdateValues: vi.fn().mockResolvedValue({ spreadsheetId: 'sheet-1', totalUpdatedRows: 0 }),
    };

    await syncSheetsAfterFormMutation({
      db,
      lineAccountId: 'acc-1',
      formId: 'form-1',
      actor: 'system_internal_form_submission',
      credentialsJson: '{}',
      client: client as never,
    });

    expect(client.readValues).toHaveBeenCalled();
    expect(raw.prepare('SELECT target, status FROM sheets_sync_jobs').get()).toEqual({
      target: 'form_results',
      status: 'completed',
    });
  });

  test('a submission arriving while the current results job is locked gets a fresh follow-up snapshot', async () => {
    raw.prepare('UPDATE sheets_connections SET friend_ledger_enabled = 0 WHERE id = ?').run(connection.id);
    insertSubmissions(1);
    const [original] = await startSheetsSyncJobsForFormMutation({
      db,
      lineAccountId: 'acc-1',
      formId: 'form-1',
      actor: 'system_internal_form_submission',
    });
    raw.prepare(`UPDATE sheets_sync_jobs
      SET lock_token = 'busy', locked_until = '2099-01-01T00:00:00+09:00'
      WHERE id = ?`).run(original.id);
    const timestamp = '2026-07-21T10:00:01+09:00';
    raw.prepare(`INSERT INTO internal_form_submissions
      (id, form_id, friend_id, answers_json, submitted_at, created_at)
      VALUES ('ifs-0001', 'form-1', 'friend-1', '{"q1":"later"}', ?, ?)`).run(timestamp, timestamp);

    const [coalesced] = await startSheetsSyncJobsForFormMutation({
      db,
      lineAccountId: 'acc-1',
      formId: 'form-1',
      actor: 'system_internal_form_submission',
    });
    expect(coalesced.id).toBe(original.id);
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sheets_sync_jobs
      WHERE connection_id = ? AND target = 'form_results' AND status = 'running'`).get(connection.id))
      .toEqual({ count: 1 });
    expect(raw.prepare('SELECT error_code FROM sheets_sync_jobs WHERE id = ?').get(original.id))
      .toEqual({ error_code: 'sheets_sync_refresh_requested' });

    raw.prepare(`INSERT INTO formaloo_forms (id, title, definition_json, render_backend, line_account_id)
      VALUES ('form-backlog', 'Backlog', '{"fields":[],"logic":[]}', 'internal', 'acc-1')`).run();
    const backlogConnection = await createSheetsConnection(db, {
      lineAccountId: 'acc-1',
      formId: 'form-backlog',
      spreadsheetId: 'sheet-backlog',
      sheetName: 'Backlog',
      syncDirection: 'bidirectional',
      friendLedgerEnabled: true,
      formResultsEnabled: false,
    });
    const backlog = await startSheetsSyncJob({
      db,
      connection: backlogConnection,
      source: 'manual',
      actor: 'owner-1',
      target: 'ledger',
    });
    raw.prepare("UPDATE sheets_sync_jobs SET created_at = '2026-07-21T09:00:00+09:00' WHERE id = ?")
      .run(original.id);
    raw.prepare("UPDATE sheets_sync_jobs SET created_at = '2026-07-21T09:00:01+09:00' WHERE id = ?")
      .run(backlog.id);
    raw.prepare(`UPDATE sheets_sync_jobs SET locked_until = '2020-01-01T00:00:00+09:00' WHERE id = ?`)
      .run(original.id);
    const syncResults = vi.fn()
      .mockResolvedValueOnce({
        status: 'success', warning: null, warnings: [], busy: false,
        appendedRows: 1, updatedRows: 0, importedFields: 0, ignoredIdentityEdits: 0,
        chunk: {
          processed: 1,
          hasMore: false,
          cursor: { submittedAt: '2026-07-21T10:00:00+09:00', submissionId: 'ifs-0000' },
        },
      })
      .mockResolvedValueOnce({
        status: 'success', warning: null, warnings: [], busy: false,
        appendedRows: 1, updatedRows: 1, importedFields: 0, ignoredIdentityEdits: 0,
        chunk: {
          processed: 2,
          hasMore: false,
          cursor: { submittedAt: timestamp, submissionId: 'ifs-0001' },
        },
      });
    const ledgerSync = vi.fn().mockResolvedValue({
      status: 'success', warning: null, warnings: [], busy: false,
      appendedRows: 0, updatedRows: 0, importedFields: 0, ignoredIdentityEdits: 0,
      chunk: {
        processed: 1,
        hasMore: false,
        cursor: { createdAt: '2026-07-20T10:00:00+09:00', friendId: 'friend-1' },
      },
    });

    const processed = await processSheetsSyncJobBatch({
      db,
      sync: ledgerSync,
      syncResults,
      maxChunks: 2,
      trigger: 'manual',
    });

    expect(processed.chunks).toBe(2);
    expect(syncResults).toHaveBeenCalledTimes(2);
    expect(ledgerSync).not.toHaveBeenCalled();
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sheets_sync_jobs
      WHERE connection_id = ? AND target = 'form_results'`).get(connection.id)).toEqual({ count: 2 });
    expect(raw.prepare(`SELECT total_count, processed_count, status FROM sheets_sync_jobs
      WHERE connection_id = ? AND target = 'form_results' AND id <> ?`).get(connection.id, original.id))
      .toEqual({ total_count: 2, processed_count: 2, status: 'completed' });
  });

  test('an edit behind a locked results cursor is revisited from the beginning by the follow-up snapshot', async () => {
    raw.prepare('UPDATE sheets_connections SET friend_ledger_enabled = 0 WHERE id = ?').run(connection.id);
    insertSubmissions(2);
    const [original] = await startSheetsSyncJobsForFormMutation({
      db,
      lineAccountId: 'acc-1',
      formId: 'form-1',
      actor: 'system_internal_form_edit',
    });
    raw.prepare(`UPDATE sheets_sync_jobs SET processed_count = 1,
      last_friend_created_at = '2026-07-21T10:00:00+09:00', last_record_key = 'ifs-0000',
      lock_token = 'busy', locked_until = '2099-01-01T00:00:00+09:00'
      WHERE id = ?`).run(original.id);
    raw.prepare(`UPDATE internal_form_submissions
      SET answers_json = '{"q1":"edited"}', edit_version = edit_version + 1
      WHERE id = 'ifs-0000'`).run();

    await startSheetsSyncJobsForFormMutation({
      db,
      lineAccountId: 'acc-1',
      formId: 'form-1',
      actor: 'system_internal_form_edit',
    });
    raw.prepare(`UPDATE sheets_sync_jobs SET locked_until = '2020-01-01T00:00:00+09:00' WHERE id = ?`)
      .run(original.id);
    const lastCursor = { submittedAt: '2026-07-21T10:00:01+09:00', submissionId: 'ifs-0001' };
    const syncResults = vi.fn()
      .mockResolvedValueOnce({
        status: 'success', warning: null, warnings: [], busy: false,
        appendedRows: 0, updatedRows: 1, importedFields: 0, ignoredIdentityEdits: 0,
        chunk: { processed: 1, hasMore: false, cursor: lastCursor },
      })
      .mockResolvedValueOnce({
        status: 'success', warning: null, warnings: [], busy: false,
        appendedRows: 0, updatedRows: 2, importedFields: 0, ignoredIdentityEdits: 0,
        chunk: { processed: 2, hasMore: false, cursor: lastCursor },
      });

    await processSheetsSyncJobBatch({
      db,
      jobId: original.id,
      sync: vi.fn(),
      syncResults,
      maxChunks: 8,
      trigger: 'manual',
    });

    expect(syncResults).toHaveBeenCalledTimes(2);
    expect(syncResults).toHaveBeenNthCalledWith(1, expect.objectContaining({
      chunk: expect.objectContaining({
        after: { submittedAt: '2026-07-21T10:00:00+09:00', submissionId: 'ifs-0000' },
      }),
    }));
    expect(syncResults).toHaveBeenNthCalledWith(2, expect.objectContaining({
      chunk: expect.objectContaining({ after: null }),
    }));
  });

  test('the mutation waitUntil retries a contended job and refreshes it as soon as its lock is released', async () => {
    raw.prepare('UPDATE sheets_connections SET friend_ledger_enabled = 0 WHERE id = ?').run(connection.id);
    insertSubmissions(1);
    const stale = await startSheetsSyncJob({
      db,
      connection,
      source: 'polling',
      actor: 'system_poll',
      target: 'form_results',
    });
    raw.prepare(`UPDATE sheets_sync_jobs
      SET lock_token = 'busy', locked_until = '2099-01-01T00:00:00+09:00'
      WHERE id = ?`).run(stale.id);
    const timestamp = '2026-07-21T10:00:01+09:00';
    raw.prepare(`INSERT INTO internal_form_submissions
      (id, form_id, friend_id, answers_json, submitted_at, created_at)
      VALUES ('ifs-0001', 'form-1', 'friend-1', '{"q1":"later"}', ?, ?)`).run(timestamp, timestamp);
    const retryDelay = vi.fn(async () => {
      raw.prepare('UPDATE sheets_sync_jobs SET lock_token = NULL, locked_until = NULL WHERE id = ?')
        .run(stale.id);
    });
    const syncResults = vi.fn().mockResolvedValue({
      status: 'success', warning: null, warnings: [], busy: false,
      appendedRows: 1, updatedRows: 1, importedFields: 0, ignoredIdentityEdits: 0,
      chunk: {
        processed: 1,
        hasMore: false,
        cursor: { submittedAt: timestamp, submissionId: 'ifs-0001' },
      },
    });

    await syncSheetsAfterFormMutation({
      db,
      lineAccountId: 'acc-1',
      formId: 'form-1',
      submissionId: 'ifs-0001',
      actor: 'system_internal_form_submission',
      credentialsJson: '{}',
      sync: vi.fn(),
      syncResults,
      retryDelay,
    });

    expect(retryDelay).toHaveBeenCalledTimes(1);
    expect(syncResults).toHaveBeenCalledTimes(1);
    expect(syncResults).toHaveBeenCalledWith(expect.objectContaining({
      source: 'manual',
      actor: 'system_internal_form_submission',
      chunk: expect.objectContaining({
        after: { submittedAt: '2026-07-21T10:00:00+09:00', submissionId: 'ifs-0000' },
      }),
    }));
    expect(raw.prepare('SELECT status, total_count, processed_count FROM sheets_sync_jobs WHERE id = ?').get(stale.id))
      .toEqual({ status: 'completed', total_count: 1, processed_count: 1 });
  });

  test('an immediate mutation job targets the changed submission even when the form has more than eight chunks', async () => {
    raw.prepare('UPDATE sheets_connections SET friend_ledger_enabled = 0 WHERE id = ?').run(connection.id);
    insertSubmissions(1_801);
    const syncResults = vi.fn().mockResolvedValue({
      status: 'success', warning: null, warnings: [], busy: false,
      appendedRows: 1, updatedRows: 0, importedFields: 0, ignoredIdentityEdits: 0,
      chunk: {
        processed: 1,
        hasMore: false,
        cursor: { submittedAt: '2026-07-21T10:30:00+09:00', submissionId: 'ifs-1800' },
      },
    });

    await syncSheetsAfterFormMutation({
      db,
      lineAccountId: 'acc-1',
      formId: 'form-1',
      submissionId: 'ifs-1800',
      actor: 'system_internal_form_submission',
      credentialsJson: '{}',
      sync: vi.fn(),
      syncResults,
    });

    expect(syncResults).toHaveBeenCalledTimes(1);
    expect(syncResults).toHaveBeenCalledWith(expect.objectContaining({
      chunk: {
        limit: 200,
        after: { submittedAt: '2026-07-21T10:29:59+09:00', submissionId: 'ifs-1799' },
        through: { submittedAt: '2026-07-21T10:30:00+09:00', submissionId: 'ifs-1800' },
      },
    }));
    expect(raw.prepare('SELECT status, total_count, processed_count FROM sheets_sync_jobs').get())
      .toEqual({ status: 'completed', total_count: 1, processed_count: 1 });
  });

  test('a mutation runner never consumes a targeted job that another mutation retargeted', async () => {
    raw.prepare('UPDATE sheets_connections SET friend_ledger_enabled = 0 WHERE id = ?').run(connection.id);
    insertSubmissions(2);
    const job = await startSheetsSyncJob({
      db,
      connection,
      source: 'manual',
      actor: 'system_internal_form_submission',
      target: 'form_results',
      refreshOnExisting: true,
      formResultsSubmissionId: 'ifs-0000',
    });
    const syncResults = vi.fn().mockResolvedValue({
      status: 'success', warning: null, warnings: [], busy: false,
      appendedRows: 1, updatedRows: 0, importedFields: 0, ignoredIdentityEdits: 0,
      chunk: {
        processed: 1,
        hasMore: false,
        cursor: { submittedAt: '2026-07-21T10:00:00+09:00', submissionId: 'ifs-0000' },
      },
    });

    const result = await processSheetsSyncJobBatch({
      db,
      jobId: job.id,
      expectedSnapshotRecordKey: 'ifs-0001',
      sync: vi.fn(),
      syncResults,
      maxChunks: 1,
      trigger: 'manual',
    });

    expect(result.chunks).toBe(0);
    expect(syncResults).not.toHaveBeenCalled();
    expect(raw.prepare('SELECT status, snapshot_record_key FROM sheets_sync_jobs WHERE id = ?').get(job.id))
      .toEqual({ status: 'running', snapshot_record_key: 'ifs-0000' });
  });

  test('a mutation runner follows a trusted full-refresh continuation after its target guard changes', async () => {
    raw.prepare('UPDATE sheets_connections SET friend_ledger_enabled = 0 WHERE id = ?').run(connection.id);
    insertSubmissions(3);
    const targeted = await startSheetsSyncJob({
      db,
      connection,
      source: 'manual',
      actor: 'system_internal_form_edit',
      target: 'form_results',
      refreshOnExisting: true,
      formResultsSubmissionId: 'ifs-0000',
    });
    const syncResults = vi.fn()
      .mockImplementationOnce(async () => {
        await startSheetsSyncJobsForFormMutation({
          db,
          lineAccountId: 'acc-1',
          formId: 'form-1',
          submissionId: 'ifs-0001',
          actor: 'system_internal_form_edit',
        });
        await startSheetsSyncJobsForFormMutation({
          db,
          lineAccountId: 'acc-1',
          formId: 'form-1',
          submissionId: 'ifs-0002',
          actor: 'system_internal_form_edit',
        });
        return {
          status: 'success', warning: null, warnings: [], busy: false,
          appendedRows: 0, updatedRows: 1, importedFields: 0, ignoredIdentityEdits: 0,
          chunk: {
            processed: 1,
            hasMore: false,
            cursor: { submittedAt: '2026-07-21T10:00:00+09:00', submissionId: 'ifs-0000' },
          },
        };
      })
      .mockResolvedValueOnce({
        status: 'success', warning: null, warnings: [], busy: false,
        appendedRows: 0, updatedRows: 3, importedFields: 0, ignoredIdentityEdits: 0,
        chunk: {
          processed: 3,
          hasMore: false,
          cursor: { submittedAt: '2026-07-21T10:00:02+09:00', submissionId: 'ifs-0002' },
        },
      });

    const result = await processSheetsSyncJobBatch({
      db,
      jobId: targeted.id,
      expectedSnapshotRecordKey: 'ifs-0000',
      sync: vi.fn(),
      syncResults,
      maxChunks: 2,
      trigger: 'manual',
    });

    expect(result.chunks).toBe(2);
    expect(syncResults).toHaveBeenCalledTimes(2);
    expect(raw.prepare(`SELECT status, total_count, processed_count FROM sheets_sync_jobs
      WHERE connection_id = ? AND target = 'form_results'
      ORDER BY created_at DESC, id DESC LIMIT 1`).get(connection.id))
      .toEqual({ status: 'completed', total_count: 3, processed_count: 3 });
  });

  test('different mutations waiting on the same lock upgrade the durable fallback to a full refresh', async () => {
    raw.prepare('UPDATE sheets_connections SET friend_ledger_enabled = 0 WHERE id = ?').run(connection.id);
    insertSubmissions(2);
    const locked = await startSheetsSyncJob({
      db,
      connection,
      source: 'polling',
      actor: 'system_poll',
      target: 'form_results',
    });
    raw.prepare(`UPDATE sheets_sync_jobs
      SET lock_token = 'busy', locked_until = '2099-01-01T00:00:00+09:00'
      WHERE id = ?`).run(locked.id);

    let waitingReaders = 0;
    let releaseReaders: (() => void) | undefined;
    const bothReadersReady = new Promise<void>((resolve) => {
      releaseReaders = resolve;
    });
    const concurrentDb = d1(raw, async (sql) => {
      if (!sql.includes("WHERE connection_id = ? AND target = ? AND status = 'running'")) return;
      waitingReaders += 1;
      if (waitingReaders === 2) releaseReaders?.();
      await bothReadersReady;
    });

    await Promise.all([
      startSheetsSyncJobsForFormMutation({
        db: concurrentDb,
        lineAccountId: 'acc-1',
        formId: 'form-1',
        submissionId: 'ifs-0000',
        actor: 'system_internal_form_submission',
      }),
      startSheetsSyncJobsForFormMutation({
        db: concurrentDb,
        lineAccountId: 'acc-1',
        formId: 'form-1',
        submissionId: 'ifs-0001',
        actor: 'system_internal_form_submission',
      }),
    ]);

    expect(raw.prepare('SELECT error_code FROM sheets_sync_jobs WHERE id = ?').get(locked.id))
      .toEqual({ error_code: 'sheets_sync_refresh_requested' });
  });

  test('a form mutation starts a fresh snapshot instead of resuming a stale failed results job', async () => {
    raw.prepare('UPDATE sheets_connections SET friend_ledger_enabled = 0 WHERE id = ?').run(connection.id);
    insertSubmissions(1);
    const stale = await startSheetsSyncJob({
      db,
      connection,
      source: 'manual',
      actor: 'owner-1',
      target: 'form_results',
    });
    raw.prepare(`UPDATE sheets_sync_jobs SET status = 'failed', error_code = 'old_failure'
      WHERE id = ?`).run(stale.id);
    const timestamp = '2026-07-21T10:00:01+09:00';
    raw.prepare(`INSERT INTO internal_form_submissions
      (id, form_id, friend_id, answers_json, submitted_at, created_at)
      VALUES ('ifs-0001', 'form-1', 'friend-1', '{"q1":"later"}', ?, ?)`).run(timestamp, timestamp);

    const [fresh] = await startSheetsSyncJobsForFormMutation({
      db,
      lineAccountId: 'acc-1',
      formId: 'form-1',
      actor: 'system_internal_form_submission',
    });

    expect(fresh.id).not.toBe(stale.id);
    expect(fresh).toMatchObject({ status: 'running', totalCount: 2 });
    expect(raw.prepare('SELECT status, error_code FROM sheets_sync_jobs WHERE id = ?').get(stale.id))
      .toEqual({ status: 'failed', error_code: 'old_failure' });
  });

  test('inline mutation processing is scoped to its form results job instead of older unrelated work', async () => {
    raw.prepare('UPDATE sheets_connections SET friend_ledger_enabled = 0 WHERE id = ?').run(connection.id);
    raw.prepare(`INSERT INTO formaloo_forms (id, title, definition_json, render_backend, line_account_id)
      VALUES ('form-backlog', 'Backlog', '{"fields":[],"logic":[]}', 'internal', 'acc-1')`).run();
    const backlogConnection = await createSheetsConnection(db, {
      lineAccountId: 'acc-1',
      formId: 'form-backlog',
      spreadsheetId: 'sheet-backlog',
      sheetName: 'Backlog',
      syncDirection: 'bidirectional',
      friendLedgerEnabled: true,
      formResultsEnabled: false,
    });
    const backlog = await startSheetsSyncJob({
      db,
      connection: backlogConnection,
      source: 'manual',
      actor: 'owner-1',
      target: 'ledger',
    });
    insertSubmissions(1);
    const ledgerSync = vi.fn().mockResolvedValue({
      status: 'running', warning: null, warnings: [], busy: false,
      appendedRows: 0, updatedRows: 0, importedFields: 0, ignoredIdentityEdits: 0,
      chunk: {
        processed: 1,
        hasMore: true,
        cursor: { createdAt: '2026-07-20T10:00:00+09:00', friendId: 'friend-1' },
      },
    });
    const syncResults = vi.fn().mockResolvedValue({
      status: 'success', warning: null, warnings: [], busy: false,
      appendedRows: 1, updatedRows: 0, importedFields: 0, ignoredIdentityEdits: 0,
      chunk: {
        processed: 1,
        hasMore: false,
        cursor: { submittedAt: '2026-07-21T10:00:00+09:00', submissionId: 'ifs-0000' },
      },
    });

    await syncSheetsAfterFormMutation({
      db,
      lineAccountId: 'acc-1',
      formId: 'form-1',
      actor: 'system_internal_form_submission',
      credentialsJson: '{}',
      sync: ledgerSync,
      syncResults,
    });

    expect(syncResults).toHaveBeenCalledTimes(1);
    expect(ledgerSync).not.toHaveBeenCalled();
    expect(raw.prepare('SELECT status FROM sheets_sync_jobs WHERE id = ?').get(backlog.id))
      .toEqual({ status: 'running' });
    expect(raw.prepare(`SELECT status FROM sheets_sync_jobs
      WHERE connection_id = ? AND target = 'form_results'`).get(connection.id))
      .toEqual({ status: 'completed' });
  });

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

  test('a manual results job snapshots friend-backed and anonymous submissions', async () => {
    insertSubmissions(3);
    const insertAnonymous = raw.prepare(`INSERT INTO internal_form_submissions
      (id, form_id, friend_id, answers_json, submitted_at, created_at)
      VALUES (?, 'form-1', NULL, ?, ?, ?)`);
    for (let index = 3; index < 6; index += 1) {
      const suffix = String(index).padStart(4, '0');
      const timestamp = `2026-07-21T10:00:0${index}+09:00`;
      insertAnonymous.run(`ifs-${suffix}`, JSON.stringify({ q1: `回答${suffix}` }), timestamp, timestamp);
    }
    const job = await startSheetsSyncJob({
      db, connection, source: 'manual', actor: 'owner-1', target: 'form_results',
    });
    expect(job).toMatchObject({ target: 'form_results', status: 'running', totalCount: 6 });
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

    const first = await processNextSheetsSyncJob({
      db,
      sync: ledgerSync,
      syncResults,
      adminOrigin: 'https://admin.example.test',
      chunkSize: 200,
    });
    expect(first.job).toMatchObject({ target: 'form_results', status: 'running', processedCount: 200, totalCount: 450 });
    const second = await processNextSheetsSyncJob({ db, sync: ledgerSync, syncResults, chunkSize: 200 });
    expect(second.job).toMatchObject({ status: 'running', processedCount: 400 });
    const third = await processNextSheetsSyncJob({ db, sync: ledgerSync, syncResults, chunkSize: 200 });
    expect(third.job).toMatchObject({ status: 'success', processedCount: 450, totalCount: 450 });
    expect(ledgerSync).not.toHaveBeenCalled();
    expect(syncResults).toHaveBeenNthCalledWith(2, expect.objectContaining({
      chunk: expect.objectContaining({ after: cursors[0], limit: 200 }),
    }));
    expect(syncResults).toHaveBeenNthCalledWith(1, expect.objectContaining({
      adminOrigin: 'https://admin.example.test',
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
