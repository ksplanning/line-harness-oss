import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createSheetsConnection, type SheetsConnection } from '@line-crm/db';
import {
  getLatestSheetsSyncJob,
  processNextSheetsSyncJob,
  recordSheetsSyncDispatchError,
  startSheetsSyncJob,
} from './sheets-sync-jobs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');

type MockStatement = D1PreparedStatement & { __exec: () => { meta: { changes: number } } };

function d1(raw: Database.Database, afterFirst?: (sql: string) => void): D1Database {
  const prepare = (sql: string): MockStatement => {
    const statement = raw.prepare(sql);
    let params: unknown[] = [];
    const api = {
      bind(...args: unknown[]) { params = args; return api; },
      async first<T>() {
        const value = (statement.get(...(params as never[])) as T) ?? null;
        afterFirst?.(sql);
        return value;
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

function insertFriends(count: number): void {
  const insert = raw.prepare(`INSERT INTO friends
    (id, line_user_id, display_name, line_account_id, metadata, created_at, updated_at)
    VALUES (?, ?, ?, 'acc-1', '{}', ?, ?)`);
  const transaction = raw.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const id = `friend-${String(index).padStart(4, '0')}`;
      const timestamp = `2026-07-20T10:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}+09:00`;
      insert.run(id, `U_${index}`, `友だち${index}`, timestamp, timestamp);
    }
  });
  transaction();
}

beforeEach(async () => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  raw.exec(readFileSync(join(DB_ROOT, 'bootstrap.sql'), 'utf8'));
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
    VALUES ('acc-1', 'channel-1', 'A', 'token', 'secret')`).run();
  db = d1(raw);
  connection = await createSheetsConnection(db, {
    lineAccountId: 'acc-1',
    formId: 'friend-ledger',
    spreadsheetId: 'sheet-1',
    sheetName: '友だち台帳',
    syncDirection: 'bidirectional',
    friendLedgerEnabled: true,
  });
});

describe('durable Sheets sync jobs', () => {
  test('advances a stable cursor in bounded invocations until all 450 rows finish', async () => {
    insertFriends(450);
    const started = await startSheetsSyncJob({
      db, connection, source: 'manual', actor: 'owner-1',
    });
    expect(started).toMatchObject({
      status: 'running', totalCount: 450, processedCount: 0,
      lastFriendCreatedAt: null, lastFriendId: null, errorMessage: null,
    });

    const cursors = [
      { createdAt: '2026-07-20T10:03:19+09:00', friendId: 'friend-0199' },
      { createdAt: '2026-07-20T10:06:39+09:00', friendId: 'friend-0399' },
      { createdAt: '2026-07-20T10:07:29+09:00', friendId: 'friend-0449' },
    ];
    const sync = vi.fn()
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

    const first = await processNextSheetsSyncJob({
      db,
      sync,
      adminOrigin: 'https://admin.example.test',
      chunkSize: 200,
    });
    expect(first.job).toMatchObject({ status: 'running', processedCount: 200, totalCount: 450 });
    const second = await processNextSheetsSyncJob({ db, sync, chunkSize: 200 });
    expect(second.job).toMatchObject({ status: 'running', processedCount: 400, totalCount: 450 });
    const third = await processNextSheetsSyncJob({ db, sync, chunkSize: 200 });
    expect(third.job).toMatchObject({ status: 'success', processedCount: 450, totalCount: 450 });
    expect(sync).toHaveBeenNthCalledWith(2, expect.objectContaining({
      chunk: expect.objectContaining({ after: cursors[0], limit: 200 }),
    }));
    expect(sync).toHaveBeenNthCalledWith(1, expect.objectContaining({
      adminOrigin: 'https://admin.example.test',
    }));
  });

  test('keeps completed progress and cursor visible on failure, then resumes the same job', async () => {
    insertFriends(300);
    const started = await startSheetsSyncJob({ db, connection, source: 'manual', actor: 'owner-1' });
    const cursor = { createdAt: '2026-07-20T10:03:19+09:00', friendId: 'friend-0199' };
    const firstSync = vi.fn().mockResolvedValue({
      status: 'running', warning: null, warnings: [], busy: false,
      appendedRows: 200, updatedRows: 0, importedFields: 0, ignoredIdentityEdits: 0,
      chunk: { processed: 200, hasMore: true, cursor },
    });
    await processNextSheetsSyncJob({ db, sync: firstSync, chunkSize: 200 });

    await expect(processNextSheetsSyncJob({
      db,
      sync: vi.fn().mockRejectedValue(new Error('upstream body must never be exposed')),
      chunkSize: 200,
    })).resolves.toMatchObject({ job: { status: 'error', processedCount: 200 } });
    const failed = await getLatestSheetsSyncJob(db, 'acc-1', connection.id);
    expect(failed).toMatchObject({
      id: started.id,
      status: 'error',
      processedCount: 200,
      totalCount: 300,
      lastFriendId: cursor.friendId,
      errorCode: 'sheets_sync_chunk_failed',
    });
    expect(failed?.errorMessage).toBe('同期が途中で止まりました。接続設定を確認して、続きから再開してください。');
    expect(JSON.stringify(failed)).not.toContain('upstream body');

    const resumed = await startSheetsSyncJob({ db, connection, source: 'manual', actor: 'owner-1' });
    expect(resumed).toMatchObject({ id: started.id, status: 'running', processedCount: 200 });
    const finalSync = vi.fn().mockResolvedValue({
      status: 'success', warning: null, warnings: [], busy: false,
      appendedRows: 100, updatedRows: 0, importedFields: 0, ignoredIdentityEdits: 0,
      chunk: {
        processed: 100,
        hasMore: false,
        cursor: { createdAt: '2026-07-20T10:04:59+09:00', friendId: 'friend-0299' },
      },
    });
    const finished = await processNextSheetsSyncJob({ db, sync: finalSync, chunkSize: 200 });
    expect(finished.job).toMatchObject({
      id: started.id, status: 'success', processedCount: 300, totalCount: 300, errorMessage: null,
    });
    expect(finalSync).toHaveBeenCalledWith(expect.objectContaining({
      chunk: expect.objectContaining({ after: cursor }),
    }));
  });

  test('returns the one existing running job instead of resetting its progress', async () => {
    insertFriends(10);
    const first = await startSheetsSyncJob({ db, connection, source: 'polling', actor: 'system_poll' });
    const duplicate = await startSheetsSyncJob({ db, connection, source: 'manual', actor: 'owner-1' });
    expect(duplicate).toEqual(first);
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM sheets_sync_jobs WHERE connection_id=?`).get(connection.id))
      .toEqual({ count: 1 });
  });

  test('continues with the next queued connection after the current job completes', async () => {
    insertFriends(1);
    const secondConnection = await createSheetsConnection(db, {
      lineAccountId: 'acc-1',
      formId: 'friend-ledger-second',
      spreadsheetId: 'sheet-2',
      sheetName: '友だち台帳2',
      syncDirection: 'bidirectional',
      friendLedgerEnabled: true,
    });
    const firstJob = await startSheetsSyncJob({ db, connection, source: 'polling', actor: 'system_poll' });
    const secondJob = await startSheetsSyncJob({
      db, connection: secondConnection, source: 'manual', actor: 'owner-1',
    });
    raw.prepare("UPDATE sheets_sync_jobs SET created_at='2026-07-22T10:00:00.000+09:00' WHERE id=?")
      .run(firstJob.id);
    raw.prepare("UPDATE sheets_sync_jobs SET created_at='2026-07-22T10:00:01.000+09:00' WHERE id=?")
      .run(secondJob.id);
    const sync = vi.fn().mockResolvedValue({
      status: 'success', warning: null, warnings: [], busy: false,
      appendedRows: 1, updatedRows: 0, importedFields: 0, ignoredIdentityEdits: 0,
      chunk: {
        processed: 1,
        hasMore: false,
        cursor: { createdAt: '2026-07-20T10:00:00+09:00', friendId: 'friend-0000' },
      },
    });

    const first = await processNextSheetsSyncJob({ db, sync, chunkSize: 200 });
    expect(first).toMatchObject({
      attempted: 1,
      hasMore: true,
      continuationJobId: secondJob.id,
      job: { id: firstJob.id, status: 'success' },
    });
    const second = await processNextSheetsSyncJob({ db, sync, chunkSize: 200 });
    expect(second).toMatchObject({
      attempted: 1,
      hasMore: false,
      continuationJobId: null,
      job: { id: secondJob.id, status: 'success' },
    });
  });

  test('moves to another queued connection when the oldest connection is temporarily busy', async () => {
    insertFriends(1);
    const secondConnection = await createSheetsConnection(db, {
      lineAccountId: 'acc-1',
      formId: 'friend-ledger-busy-second',
      spreadsheetId: 'sheet-busy-2',
      sheetName: '待機確認',
      syncDirection: 'bidirectional',
      friendLedgerEnabled: true,
    });
    const firstJob = await startSheetsSyncJob({ db, connection, source: 'polling', actor: 'system_poll' });
    const secondJob = await startSheetsSyncJob({
      db, connection: secondConnection, source: 'polling', actor: 'system_poll',
    });
    raw.prepare("UPDATE sheets_sync_jobs SET created_at='2026-07-22T10:00:00.000+09:00' WHERE id=?")
      .run(firstJob.id);
    raw.prepare("UPDATE sheets_sync_jobs SET created_at='2026-07-22T10:00:01.000+09:00' WHERE id=?")
      .run(secondJob.id);

    const result = await processNextSheetsSyncJob({
      db,
      sync: vi.fn().mockResolvedValue({
        status: 'warning', warning: '別の同期処理が実行中です', warnings: [], busy: true,
        appendedRows: 0, updatedRows: 0, importedFields: 0, ignoredIdentityEdits: 0,
      }),
    });

    expect(result).toMatchObject({
      attempted: 0,
      hasMore: true,
      continuationJobId: secondJob.id,
      job: { id: firstJob.id, status: 'running' },
    });
  });

  test('does not let a stale claimed worker overwrite a newer connection status', async () => {
    insertFriends(1);
    const started = await startSheetsSyncJob({ db, connection, source: 'manual', actor: 'owner-1' });
    const sync = vi.fn(async () => {
      raw.prepare(`UPDATE sheets_sync_jobs
        SET lock_token='new-job-worker', locked_until='2099-01-01T00:00:00.000+09:00'
        WHERE id=?`).run(started.id);
      raw.prepare(`UPDATE sheets_connections
        SET last_sync_status='success', last_sync_warning='new worker completed',
            last_sync_error_code=NULL
        WHERE id=?`).run(connection.id);
      throw new Error('stale worker failure');
    });

    await processNextSheetsSyncJob({ db, sync, chunkSize: 200 });

    expect(raw.prepare(`SELECT last_sync_status, last_sync_warning, last_sync_error_code
      FROM sheets_connections WHERE id=?`).get(connection.id)).toEqual({
      last_sync_status: 'success',
      last_sync_warning: 'new worker completed',
      last_sync_error_code: null,
    });
    expect(raw.prepare('SELECT status, lock_token FROM sheets_sync_jobs WHERE id=?').get(started.id))
      .toEqual({ status: 'running', lock_token: 'new-job-worker' });
  });

  test('captures the cursor and total in one snapshot when a friend is inserted concurrently', async () => {
    insertFriends(1);
    let inserted = false;
    db = d1(raw, (sql) => {
      if (inserted || !/FROM friends[\s\S]*ORDER BY created_at DESC, id DESC LIMIT 1/.test(sql)) return;
      inserted = true;
      raw.prepare(`INSERT INTO friends
        (id, line_user_id, display_name, line_account_id, metadata, created_at, updated_at)
        VALUES ('friend-late', 'U_LATE', '後から追加', 'acc-1', '{}',
                '2026-07-20T11:00:00+09:00', '2026-07-20T11:00:00+09:00')`).run();
    });

    const started = await startSheetsSyncJob({ db, connection, source: 'manual', actor: 'owner-1' });

    expect(inserted).toBe(true);
    expect(raw.prepare("SELECT COUNT(*) AS count FROM friends WHERE line_account_id='acc-1'").get())
      .toEqual({ count: 2 });
    expect(started).toMatchObject({
      totalCount: 1,
      processedCount: 0,
      lastFriendId: null,
    });
  });

  test('retains a visible warning after recovering an expired worker lease', async () => {
    insertFriends(1);
    const started = await startSheetsSyncJob({ db, connection, source: 'manual', actor: 'owner-1' });
    raw.prepare(`UPDATE sheets_sync_jobs
      SET lock_token='cut-off-worker', locked_until='2026-07-22T09:00:00.000+09:00'
      WHERE id=?`).run(started.id);
    const sync = vi.fn().mockResolvedValue({
      status: 'success', warning: null, warnings: [], busy: false,
      appendedRows: 1, updatedRows: 0, importedFields: 0, ignoredIdentityEdits: 0,
      chunk: {
        processed: 1,
        hasMore: false,
        cursor: { createdAt: '2026-07-20T10:00:00+09:00', friendId: 'friend-0000' },
      },
    });

    const recovered = await processNextSheetsSyncJob({
      db,
      sync,
      chunkSize: 200,
      now: () => new Date('2026-07-22T03:00:00.000Z'),
    });

    expect(recovered.job).toMatchObject({
      status: 'warning',
      processedCount: 1,
      totalCount: 1,
      warning: expect.stringContaining('前回の同期が途中で止まりました'),
    });
  });

  test('does not report success when the starting total changes before completion', async () => {
    insertFriends(3);
    await startSheetsSyncJob({ db, connection, source: 'manual', actor: 'owner-1' });
    const result = await processNextSheetsSyncJob({
      db,
      sync: vi.fn().mockResolvedValue({
        status: 'success', warning: null, warnings: [], busy: false,
        appendedRows: 2, updatedRows: 0, importedFields: 0, ignoredIdentityEdits: 0,
        chunk: {
          processed: 2,
          hasMore: false,
          cursor: { createdAt: '2026-07-20T10:00:01+09:00', friendId: 'friend-0001' },
        },
      }),
    });

    expect(result.job).toMatchObject({
      status: 'warning',
      processedCount: 2,
      totalCount: 3,
      warning: expect.stringContaining('2 / 3件を処理して終了'),
    });
  });

  test('marks every unlocked queued job with a safe error when the initial dispatch fails', async () => {
    insertFriends(2);
    const secondConnection = await createSheetsConnection(db, {
      lineAccountId: 'acc-1',
      formId: 'friend-ledger-dispatch-second',
      spreadsheetId: 'sheet-dispatch-2',
      sheetName: '配信失敗確認',
      syncDirection: 'bidirectional',
      friendLedgerEnabled: true,
    });
    const first = await startSheetsSyncJob({ db, connection, source: 'polling', actor: 'system_poll' });
    const second = await startSheetsSyncJob({
      db, connection: secondConnection, source: 'polling', actor: 'system_poll',
    });

    await recordSheetsSyncDispatchError(db);

    expect(await getLatestSheetsSyncJob(db, 'acc-1', connection.id)).toMatchObject({
      id: first.id,
      status: 'error',
      processedCount: 0,
      errorCode: 'sheets_sync_dispatch_failed',
    });
    expect(await getLatestSheetsSyncJob(db, 'acc-1', secondConnection.id)).toMatchObject({
      id: second.id,
      status: 'error',
      processedCount: 0,
      errorCode: 'sheets_sync_dispatch_failed',
    });
  });
});
