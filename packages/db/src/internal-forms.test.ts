import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  approveInternalFormSubmissionExternalEdit,
  beginFormalooDefinitionSave,
  countPendingInternalFormExternalEdits,
  countInternalFormSubmissionsForForm,
  createInternalFormSubmission,
  createInternalFormSubmissionForPublishedDefinition,
  createInternalFormSubmissionWithinLimit,
  getInternalFormSubmission,
  listLatestVerifiedInternalFormSubmissions,
  listInternalFormSubmissions,
  listVerifiedInternalFormSubmissionsForSheets,
  publishInternalFormDefinition,
  saveInternalFormDefinition,
  setFormRenderBackend,
  softDeleteInternalFormSubmission,
  switchFormRenderBackendToDraft,
  unpublishInternalFormDefinition,
  updateLatestInternalFormSubmissionAnswersForSheets,
  updateInternalFormSubmissionAnswers,
} from './internal-forms.js';
import {
  acquireFormalooFormOperationLock,
  getFormalooForm,
  releaseFormalooFormOperationLock,
} from './formaloo.js';
import { claimSheetsSyncLock, createSheetsConnection } from './sheets-connections.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database): void {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(join(PKG_ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    for (const statement of readFileSync(join(PKG_ROOT, 'migrations', file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean)) {
      try { db.exec(statement); } catch (error) {
        if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
  }
}

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
        async run() { const info = statement.run(...(params as never[])); return { meta: { changes: info.changes } }; },
      };
      return api;
    },
  } as unknown as D1Database;
}

let raw: Database.Database;
let DB: D1Database;

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, definition_json)
     VALUES ('fa_internal', '申込フォーム', '{"fields":[],"logic":[]}')`,
  ).run();
  raw.prepare(
    `INSERT INTO internal_form_notification_settings
       (form_id, enabled, edit_link_epoch, created_at, updated_at)
     VALUES ('fa_internal', 1, 4, '2026-07-21T00:00:00+09:00', '2026-07-21T00:00:00+09:00')`,
  ).run();
});

describe('internal form persistence', () => {
  test('switches a single form without changing the formaloo default', async () => {
    expect((await getFormalooForm(DB, 'fa_internal'))?.render_backend).toBe('formaloo');

    expect(await setFormRenderBackend(DB, 'fa_internal', 'internal')).toBe(true);

    expect((await getFormalooForm(DB, 'fa_internal'))?.render_backend).toBe('internal');
  });

  test('stores answers separately and scopes list/detail reads to the form', async () => {
    const created = await createInternalFormSubmission(DB, {
      formId: 'fa_internal',
      friendId: 'friend-1',
      answers: { name: '佐藤', interests: ['A', 'B'] },
    });

    expect(created.id).toMatch(/^ifs_/);
    expect(created.answers_json).toBe('{"name":"佐藤","interests":["A","B"]}');
    expect(created.origin_channel).toBe('embed');
    expect(created.edit_version).toBe(0);
    expect(await listInternalFormSubmissions(DB, 'fa_internal', { limit: 20, offset: 0 }))
      .toMatchObject({ total: 1, rows: [expect.objectContaining({ id: created.id })] });
    expect(await getInternalFormSubmission(DB, 'fa_internal', created.id))
      .toMatchObject({ id: created.id, friend_id: 'friend-1' });
    expect(await getInternalFormSubmission(DB, 'fa_other', created.id)).toBeNull();
  });

  test('soft-deletes one form-scoped submission while preserving its stored answers', async () => {
    await setFormRenderBackend(DB, 'fa_internal', 'internal');
    const deleted = await createInternalFormSubmission(DB, {
      formId: 'fa_internal',
      friendId: 'friend-1',
      answers: { name: '削除対象', keep: '復元用に保持' },
    });
    const survivor = await createInternalFormSubmission(DB, {
      formId: 'fa_internal',
      friendId: 'friend-2',
      answers: { name: '残す回答' },
    });
    const deletedAt = '2026-07-22T13:00:00+09:00';

    await expect(softDeleteInternalFormSubmission(DB, 'fa_other', deleted.id, deletedAt))
      .resolves.toBe(false);
    await expect(softDeleteInternalFormSubmission(DB, 'fa_internal', deleted.id, deletedAt))
      .resolves.toBe(true);
    await expect(softDeleteInternalFormSubmission(DB, 'fa_internal', deleted.id, deletedAt))
      .resolves.toBe(false);

    expect(raw.prepare(
      'SELECT answers_json, deleted_at FROM internal_form_submissions WHERE id = ?',
    ).get(deleted.id)).toEqual({
      answers_json: '{"name":"削除対象","keep":"復元用に保持"}',
      deleted_at: deletedAt,
    });
    await expect(getInternalFormSubmission(DB, 'fa_internal', deleted.id)).resolves.toBeNull();
    await expect(listInternalFormSubmissions(DB, 'fa_internal', { limit: 20, offset: 0 }))
      .resolves.toMatchObject({
        total: 1,
        rows: [expect.objectContaining({ id: survivor.id })],
      });
    await expect(countInternalFormSubmissionsForForm(DB, 'fa_internal')).resolves.toBe(1);
    await expect(updateInternalFormSubmissionAnswers(DB, {
      authorization: 'admin',
      formId: 'fa_internal',
      submissionId: deleted.id,
      expectedEditVersion: 0,
      expectedAnswersJson: deleted.answers_json,
      expectedDefinitionJson: '{"fields":[],"logic":[]}',
      answers: { name: '削除後の更新' },
    })).resolves.toEqual({ status: 'conflict', submission: null });
  });

  test('lists anonymous submissions plus the latest verified submission per friend in the requested tenant', async () => {
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('acc-1', 'channel-1', 'A', 'token', 'secret'),
             ('acc-2', 'channel-2', 'B', 'token', 'secret')`).run();
    raw.prepare(`UPDATE formaloo_forms
      SET render_backend='internal', line_account_id='acc-1' WHERE id='fa_internal'`).run();
    raw.prepare(`INSERT INTO formaloo_forms
      (id, title, definition_json, render_backend, line_account_id)
      VALUES ('fa_other', '別フォーム', '{"fields":[],"logic":[]}', 'internal', 'acc-1')`).run();
    raw.prepare(`INSERT INTO friends
      (id, line_user_id, display_name, line_account_id, metadata, created_at, updated_at)
      VALUES
      ('friend-1', 'U1', '一郎', 'acc-1', '{}', '2026-07-21T09:00:00+09:00', '2026-07-21T09:00:00+09:00'),
      ('friend-2', 'U2', '二郎', 'acc-2', '{}', '2026-07-21T09:00:00+09:00', '2026-07-21T09:00:00+09:00')`).run();
    await createInternalFormSubmission(DB, {
      formId: 'fa_internal', friendId: 'friend-1', answers: { name: '古い' },
      submittedAt: '2026-07-21T10:00:00+09:00',
    });
    await createInternalFormSubmission(DB, {
      formId: 'fa_internal', friendId: 'friend-1', answers: { name: '同時刻の先' },
      submittedAt: '2026-07-21T11:00:00+09:00',
    });
    const latest = await createInternalFormSubmission(DB, {
      formId: 'fa_internal', friendId: 'friend-1', answers: { name: '同時刻の後' },
      submittedAt: '2026-07-21T11:00:00+09:00',
    });
    const anonymous = await createInternalFormSubmission(DB, {
      formId: 'fa_internal', friendId: null, answers: { name: '匿名' },
      submittedAt: '2026-07-21T12:00:00+09:00',
    });
    const anonymousSecond = await createInternalFormSubmission(DB, {
      formId: 'fa_internal', friendId: null, answers: { name: '匿名2' },
      submittedAt: '2026-07-21T12:01:00+09:00',
    });
    await createInternalFormSubmission(DB, {
      formId: 'fa_internal', friendId: 'friend-2', answers: { name: '別tenant' },
      submittedAt: '2026-07-21T12:00:00+09:00',
    });
    await createInternalFormSubmission(DB, {
      formId: 'fa_other', friendId: 'friend-1', answers: { name: '別form' },
      submittedAt: '2026-07-21T12:00:00+09:00',
    });

    const rows = await listLatestVerifiedInternalFormSubmissions(DB, 'acc-1', 'fa_internal');
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: anonymous.id,
          friend_id: null,
          answers_json: '{"name":"匿名"}',
        }),
        expect.objectContaining({
          id: anonymousSecond.id,
          friend_id: null,
          answers_json: '{"name":"匿名2"}',
        }),
        expect.objectContaining({
          id: latest.id,
          friend_id: 'friend-1',
          answers_json: '{"name":"同時刻の後"}',
        }),
      ]));
    await expect(listLatestVerifiedInternalFormSubmissions(DB, 'acc-2', 'fa_internal'))
      .resolves.toEqual([]);
    await expect(listLatestVerifiedInternalFormSubmissions(DB, 'acc-1', 'fa_other'))
      .resolves.toEqual([expect.objectContaining({ friend_id: 'friend-1', answers_json: '{"name":"別form"}' })]);
  });

  test('CAS-updates only the still-latest answer under the owning tenant connection lease', async () => {
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('acc-1', 'channel-1', 'A', 'token', 'secret'),
             ('acc-2', 'channel-2', 'B', 'token', 'secret')`).run();
    raw.prepare(`UPDATE formaloo_forms
      SET render_backend='internal', line_account_id='acc-1' WHERE id='fa_internal'`).run();
    raw.prepare(`INSERT INTO friends
      (id, line_user_id, display_name, line_account_id, metadata, created_at, updated_at)
      VALUES ('friend-1', 'U1', '一郎', 'acc-1', '{}',
              '2026-07-21T09:00:00+09:00', '2026-07-21T09:00:00+09:00')`).run();
    const original = await createInternalFormSubmission(DB, {
      formId: 'fa_internal', friendId: 'friend-1', answers: { name: '初回', keep: '保持' },
      submittedAt: '2026-07-21T10:00:00+09:00',
    });
    const connection = await createSheetsConnection(DB, {
      lineAccountId: 'acc-1', formId: 'fa_internal', spreadsheetId: 'sheet-1',
      sheetName: '回答', syncDirection: 'bidirectional', friendLedgerEnabled: true,
    });
    const lease = { token: 'answer-cas-owner', now: '2026-07-21T12:00:00+09:00' };
    await expect(claimSheetsSyncLock(
      DB, 'acc-1', connection.id, lease.token, lease.now,
      '2026-07-21T12:05:00+09:00', connection.configVersion,
    )).resolves.toBe(true);

    await expect(updateLatestInternalFormSubmissionAnswersForSheets(DB, {
      lineAccountId: 'acc-2', connectionId: connection.id, connectionVersion: connection.configVersion,
      formId: 'fa_internal', friendId: 'friend-1', submissionId: original.id,
      expectedAnswersJson: original.answers_json, answers: { name: '越境', keep: '保持' }, lease,
    })).resolves.toBe(false);
    await expect(updateLatestInternalFormSubmissionAnswersForSheets(DB, {
      lineAccountId: 'acc-1', connectionId: connection.id, connectionVersion: connection.configVersion + 1,
      formId: 'fa_internal', friendId: 'friend-1', submissionId: original.id,
      expectedAnswersJson: original.answers_json, answers: { name: '旧設定', keep: '保持' }, lease,
    })).resolves.toBe(false);
    await expect(updateLatestInternalFormSubmissionAnswersForSheets(DB, {
      lineAccountId: 'acc-1', connectionId: connection.id, connectionVersion: connection.configVersion,
      formId: 'fa_internal', friendId: 'friend-1', submissionId: original.id,
      expectedAnswersJson: original.answers_json, answers: { name: '別worker', keep: '保持' },
      lease: { ...lease, token: 'answer-cas-other' },
    })).resolves.toBe(false);
    await expect(updateLatestInternalFormSubmissionAnswersForSheets(DB, {
      lineAccountId: 'acc-1', connectionId: connection.id, connectionVersion: connection.configVersion,
      formId: 'fa_internal', friendId: 'friend-1', submissionId: original.id,
      expectedAnswersJson: '{}', answers: { name: '競合上書き', keep: '保持' }, lease,
    })).resolves.toBe(false);
    await expect(updateLatestInternalFormSubmissionAnswersForSheets(DB, {
      lineAccountId: 'acc-1', connectionId: connection.id, connectionVersion: connection.configVersion,
      formId: 'fa_internal', friendId: 'friend-1', submissionId: original.id,
      expectedAnswersJson: original.answers_json, answers: { name: '初回', keep: '保持' }, lease,
    })).resolves.toBe(true);
    expect(raw.prepare(
      `SELECT external_edit_source, external_edited_at, external_edit_approved_at,
              external_edit_changes_json
       FROM internal_form_submissions WHERE id = ?`,
    ).get(original.id)).toEqual({
      external_edit_source: null,
      external_edited_at: null,
      external_edit_approved_at: null,
      external_edit_changes_json: null,
    });
    await expect(updateLatestInternalFormSubmissionAnswersForSheets(DB, {
      lineAccountId: 'acc-1', connectionId: connection.id, connectionVersion: connection.configVersion,
      formId: 'fa_internal', friendId: 'friend-1', submissionId: original.id,
      expectedAnswersJson: original.answers_json, answers: { name: 'シート編集', keep: '保持' }, lease,
    })).resolves.toBe(true);
    expect(raw.prepare(
      `SELECT answers_json, submitted_at, external_edit_source,
              external_edited_at, external_edit_approved_at,
              external_edit_changes_json
       FROM internal_form_submissions WHERE id=?`,
    )
      .get(original.id)).toEqual({
      answers_json: '{"name":"シート編集","keep":"保持"}',
      submitted_at: '2026-07-21T10:00:00+09:00',
      external_edit_source: 'sheet',
      external_edited_at: expect.any(String),
      external_edit_approved_at: null,
      external_edit_changes_json:
        '[{"fieldId":"name","before":"初回","after":"シート編集"}]',
    });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM internal_form_submissions').get()).toEqual({ n: 1 });

    const current = (await getInternalFormSubmission(DB, 'fa_internal', original.id))!;
    const newer = await createInternalFormSubmission(DB, {
      formId: 'fa_internal', friendId: 'friend-1', answers: { name: '再回答', keep: '保持' },
      submittedAt: '2026-07-21T13:00:00+09:00',
    });
    await expect(updateLatestInternalFormSubmissionAnswersForSheets(DB, {
      lineAccountId: 'acc-1', connectionId: connection.id, connectionVersion: connection.configVersion,
      formId: 'fa_internal', friendId: 'friend-1', submissionId: current.id,
      expectedAnswersJson: current.answers_json, answers: { name: '古い行へ上書き' }, lease,
    })).resolves.toBe(false);
    await expect(updateLatestInternalFormSubmissionAnswersForSheets(DB, {
      lineAccountId: 'acc-1', connectionId: connection.id, connectionVersion: connection.configVersion,
      formId: 'fa_internal', friendId: 'friend-1', submissionId: 'missing-submission',
      expectedAnswersJson: '{}', answers: { name: '部分新規作成' }, lease,
    })).resolves.toBe(false);
    expect(raw.prepare('SELECT COUNT(*) AS n FROM internal_form_submissions').get()).toEqual({ n: 2 });
    expect((await getInternalFormSubmission(DB, 'fa_internal', newer.id))?.answers_json)
      .toBe('{"name":"再回答","keep":"保持"}');
  });

  test('atomically refuses a submission after the configured response limit', async () => {
    const first = await createInternalFormSubmissionWithinLimit(DB, {
      formId: 'fa_internal', answers: { name: '一郎' }, maxSubmissions: 1,
    });
    const second = await createInternalFormSubmissionWithinLimit(DB, {
      formId: 'fa_internal', answers: { name: '二郎' }, maxSubmissions: 1,
    });

    expect(first?.id).toMatch(/^ifs_/);
    expect(second).toBeNull();
    expect(await listInternalFormSubmissions(DB, 'fa_internal', { limit: 20, offset: 0 }))
      .toMatchObject({ total: 1 });
  });

  test('atomically inserts only while the same internal definition is still published', async () => {
    raw.prepare(
      "UPDATE formaloo_forms SET render_backend = 'internal', builder_status = 'published' WHERE id = 'fa_internal'",
    ).run();
    const definitionJson = (await getFormalooForm(DB, 'fa_internal'))!.definition_json;

    const accepted = await createInternalFormSubmissionForPublishedDefinition(DB, {
      formId: 'fa_internal', definitionJson, answers: { name: '公開中' }, maxSubmissions: 2,
      submitStartTime: null, submitEndTime: null,
    });
    raw.prepare("UPDATE formaloo_forms SET builder_status = 'draft' WHERE id = 'fa_internal'").run();
    const unpublished = await createInternalFormSubmissionForPublishedDefinition(DB, {
      formId: 'fa_internal', definitionJson, answers: { name: '非公開後' }, maxSubmissions: 2,
      submitStartTime: null, submitEndTime: null,
    });
    raw.prepare(
      "UPDATE formaloo_forms SET builder_status = 'published', definition_json = '{\"fields\":[1]}' WHERE id = 'fa_internal'",
    ).run();
    const changed = await createInternalFormSubmissionForPublishedDefinition(DB, {
      formId: 'fa_internal', definitionJson, answers: { name: '定義変更後' }, maxSubmissions: 2,
      submitStartTime: null, submitEndTime: null,
    });

    expect(accepted?.id).toMatch(/^ifs_/);
    expect(unpublished).toBeNull();
    expect(changed).toBeNull();
    expect(await listInternalFormSubmissions(DB, 'fa_internal', { limit: 20, offset: 0 }))
      .toMatchObject({ total: 1 });
  });

  test('atomically rejects answers outside the saved reception window', async () => {
    raw.prepare(
      "UPDATE formaloo_forms SET render_backend = 'internal', builder_status = 'published' WHERE id = 'fa_internal'",
    ).run();
    const definitionJson = (await getFormalooForm(DB, 'fa_internal'))!.definition_json;

    const atStart = await createInternalFormSubmissionForPublishedDefinition(DB, {
      formId: 'fa_internal', definitionJson, answers: { name: '開始時刻' },
      submitStartTime: '2026-07-21T10:00:00+09:00',
      submitEndTime: '2026-07-21T11:00:00+09:00',
      submittedAt: '2026-07-21T10:00:00+09:00',
    });
    const atEnd = await createInternalFormSubmissionForPublishedDefinition(DB, {
      formId: 'fa_internal', definitionJson, answers: { name: '終了時刻' },
      submitStartTime: '2026-07-21T10:00:00+09:00',
      submitEndTime: '2026-07-21T11:00:00+09:00',
      submittedAt: '2026-07-21T11:00:00+09:00',
    });

    expect(atStart?.id).toMatch(/^ifs_/);
    expect(atEnd).toBeNull();
  });

  test('serializes a Formaloo definition save claim against provider switching', async () => {
    const snapshot = (await getFormalooForm(DB, 'fa_internal'))!;
    expect(await beginFormalooDefinitionSave(
      DB,
      'fa_internal',
      snapshot.updated_at,
      '2026-07-21T09:00:00+09:00',
    )).toBe(true);
    expect(await switchFormRenderBackendToDraft(DB, {
      formId: 'fa_internal',
      expectedBackend: 'formaloo',
      nextBackend: 'internal',
      expectedDefinitionJson: snapshot.definition_json,
      expectedUpdatedAt: snapshot.updated_at,
      updatedAt: '2026-07-21T09:01:00+09:00',
    })).toBe(false);

    raw.prepare("UPDATE formaloo_sync_state SET sync_status = 'idle' WHERE form_id = 'fa_internal'").run();
    expect(await switchFormRenderBackendToDraft(DB, {
      formId: 'fa_internal',
      expectedBackend: 'formaloo',
      nextBackend: 'internal',
      expectedDefinitionJson: snapshot.definition_json,
      expectedUpdatedAt: snapshot.updated_at,
      updatedAt: '2026-07-21T09:02:00+09:00',
    })).toBe(true);
    expect(await beginFormalooDefinitionSave(
      DB,
      'fa_internal',
      '2026-07-21T09:02:00+09:00',
      '2026-07-21T09:03:00+09:00',
    )).toBe(false);
    expect(await getFormalooForm(DB, 'fa_internal')).toMatchObject({
      render_backend: 'internal',
      builder_status: 'draft',
    });
  });

  test('serializes provider switching against every Formaloo form operation lock', async () => {
    const snapshot = (await getFormalooForm(DB, 'fa_internal'))!;
    expect(await acquireFormalooFormOperationLock(DB, 'fa_internal', {
      token: 'webhook-owner', nowMs: 1_000, leaseMs: 30_000,
    })).toBe(true);
    expect(await switchFormRenderBackendToDraft(DB, {
      formId: 'fa_internal',
      expectedBackend: 'formaloo',
      nextBackend: 'internal',
      expectedDefinitionJson: snapshot.definition_json,
      expectedUpdatedAt: snapshot.updated_at,
      nowMs: 1_001,
    })).toBe(false);

    await releaseFormalooFormOperationLock(DB, 'fa_internal', 'webhook-owner');
    expect(await switchFormRenderBackendToDraft(DB, {
      formId: 'fa_internal',
      expectedBackend: 'formaloo',
      nextBackend: 'internal',
      expectedDefinitionJson: snapshot.definition_json,
      expectedUpdatedAt: snapshot.updated_at,
      nowMs: 1_002,
    })).toBe(true);
    expect(await acquireFormalooFormOperationLock(DB, 'fa_internal', {
      token: 'stale-formaloo-request', nowMs: 1_003, leaseMs: 30_000,
    })).toBe(false);
  });

  test('rejects provider switching after the definition snapshot that was validated becomes stale', async () => {
    const snapshot = (await getFormalooForm(DB, 'fa_internal'))!;
    raw.prepare(
      `UPDATE formaloo_forms
       SET definition_json = '{"fields":[{"id":"new"}],"logic":[]}',
           updated_at = '2026-07-21T12:30:00.000+09:00'
       WHERE id = 'fa_internal'`,
    ).run();

    expect(await switchFormRenderBackendToDraft(DB, {
      formId: 'fa_internal',
      expectedBackend: 'formaloo',
      nextBackend: 'internal',
      expectedDefinitionJson: snapshot.definition_json,
      expectedUpdatedAt: snapshot.updated_at,
      updatedAt: '2026-07-21T12:31:00.000+09:00',
    })).toBe(false);
    expect((await getFormalooForm(DB, 'fa_internal'))?.render_backend).toBe('formaloo');
  });

  test('rejects a Formaloo mutation claim for a stale form snapshot', async () => {
    const staleUpdatedAt = (await getFormalooForm(DB, 'fa_internal'))!.updated_at;
    raw.prepare("UPDATE formaloo_forms SET updated_at = '2026-07-21T12:00:00.000+09:00' WHERE id = 'fa_internal'").run();

    expect(await beginFormalooDefinitionSave(
      DB,
      'fa_internal',
      staleUpdatedAt,
      '2026-07-21T12:01:00.000+09:00',
    )).toBe(false);
  });

  test('does not switch to internal while a recurring Formaloo answer is active', async () => {
    const snapshot = (await getFormalooForm(DB, 'fa_internal'))!;
    raw.prepare(
      `INSERT INTO formaloo_recurring_submissions
       (id, form_id, idempotency_key, request_fingerprint, schedule_json,
        submission_data_json, status, sync_state)
       VALUES ('frs_switch_guard', 'fa_internal', 'attempt', 'fingerprint', ?, '{}', 'resumed', 'synced')`,
    ).run(JSON.stringify({ interval: {}, start_time: '2026-07-20T00:00:00Z' }));

    expect(await switchFormRenderBackendToDraft(DB, {
      formId: 'fa_internal',
      expectedBackend: 'formaloo',
      nextBackend: 'internal',
      expectedDefinitionJson: snapshot.definition_json,
      expectedUpdatedAt: snapshot.updated_at,
    })).toBe(false);
    expect((await getFormalooForm(DB, 'fa_internal'))?.render_backend).toBe('formaloo');
  });

  test('returns the known inserted row without a fallible read after commit', async () => {
    let prepareCalls = 0;
    const insertOnlyDb = {
      prepare(sql: string) {
        prepareCalls += 1;
        if (!sql.includes('INSERT INTO internal_form_submissions')) {
          throw new Error('post-insert reads are unavailable');
        }
        const statement = {
          bind() { return statement; },
          async run() { return { meta: { changes: 1 } }; },
        };
        return statement;
      },
    } as unknown as D1Database;

    const submission = await createInternalFormSubmissionForPublishedDefinition(insertOnlyDb, {
      formId: 'fa_internal',
      definitionJson: '{"fields":[],"logic":[]}',
      friendId: 'friend-1',
      answers: { name: '保存済み' },
      submitStartTime: null,
      submitEndTime: null,
      submittedAt: '2026-07-21T12:00:00+09:00',
    });

    expect(prepareCalls).toBe(1);
    expect(submission).toMatchObject({
      form_id: 'fa_internal',
      friend_id: 'friend-1',
      answers_json: '{"name":"保存済み"}',
      submitted_at: '2026-07-21T12:00:00+09:00',
      created_at: '2026-07-21T12:00:00+09:00',
    });
  });

  test('saves an internal definition and draft status in one row update without touching field mappings', async () => {
    raw.prepare(
      `UPDATE formaloo_forms
       SET render_backend = 'internal', builder_status = 'published', published_at = '2026-07-20T09:00:00+09:00'
       WHERE id = 'fa_internal'`,
    ).run();
    raw.prepare(
      `INSERT INTO formaloo_field_map
         (id, form_id, formaloo_field_slug, field_type, label, position, config_json, created_at, updated_at)
       VALUES
         ('map_1', 'fa_internal', 'name', 'text', 'お名前', 0, '{"required":true}',
          '2026-07-20T08:00:00+09:00', '2026-07-20T08:00:00+09:00')`,
    ).run();
    const mappingBefore = raw.prepare(
      "SELECT * FROM formaloo_field_map WHERE form_id = 'fa_internal'",
    ).get();

    expect(await saveInternalFormDefinition(DB, {
      formId: 'fa_internal',
      definitionJson: '{"fields":[{"id":"name"}],"logic":[]}',
      title: '更新後タイトル',
      description: '更新後の説明',
      updatedAt: '2026-07-21T10:00:00+09:00',
    })).toBe(true);

    expect(raw.prepare(
      `SELECT definition_json, title, description, builder_status, published_at, updated_at
       FROM formaloo_forms WHERE id = 'fa_internal'`,
    ).get()).toEqual({
      definition_json: '{"fields":[{"id":"name"}],"logic":[]}',
      title: '更新後タイトル',
      description: '更新後の説明',
      builder_status: 'draft',
      published_at: '2026-07-20T09:00:00+09:00',
      updated_at: '2026-07-21T10:00:00+09:00',
    });
    expect(raw.prepare(
      "SELECT * FROM formaloo_field_map WHERE form_id = 'fa_internal'",
    ).get()).toEqual(mappingBefore);
  });

  test('definition save and publish both refuse a non-internal backend', async () => {
    const original = await getFormalooForm(DB, 'fa_internal');

    expect(await saveInternalFormDefinition(DB, {
      formId: 'fa_internal',
      definitionJson: '{"fields":[1]}',
      title: '変更しない',
      description: null,
      updatedAt: '2026-07-21T10:00:00+09:00',
    })).toBe(false);
    expect(await publishInternalFormDefinition(DB, {
      formId: 'fa_internal',
      definitionJson: original!.definition_json,
      title: original!.title,
      description: original!.description,
      updatedAt: original!.updated_at,
    })).toBe(false);
    expect(await getFormalooForm(DB, 'fa_internal')).toEqual(original);
  });

  test('publishes only the exact internal definition snapshot that was confirmed', async () => {
    raw.prepare(
      `UPDATE formaloo_forms
       SET render_backend = 'internal', builder_status = 'draft', title = '申込フォーム',
           description = '公開確認時の説明', updated_at = '2026-07-21T09:00:00+09:00'
       WHERE id = 'fa_internal'`,
    ).run();
    const confirmed = (await getFormalooForm(DB, 'fa_internal'))!;

    expect(await publishInternalFormDefinition(DB, {
      formId: 'fa_internal',
      definitionJson: confirmed.definition_json,
      title: confirmed.title,
      description: confirmed.description,
      updatedAt: confirmed.updated_at,
      publishedAt: '2026-07-21T10:00:00+09:00',
    })).toBe(true);
    expect(await getFormalooForm(DB, 'fa_internal')).toMatchObject({
      builder_status: 'published',
      published_at: '2026-07-21T10:00:00+09:00',
      updated_at: '2026-07-21T10:00:00+09:00',
    });

    raw.prepare(
      `UPDATE formaloo_forms
       SET builder_status = 'draft', published_at = '2026-07-21T10:00:00+09:00',
           updated_at = '2026-07-21T11:00:00+09:00'
       WHERE id = 'fa_internal'`,
    ).run();
    expect(await publishInternalFormDefinition(DB, {
      formId: 'fa_internal',
      definitionJson: confirmed.definition_json,
      title: confirmed.title,
      description: confirmed.description,
      updatedAt: '2026-07-21T11:00:00+09:00',
      publishedAt: '2026-07-21T12:00:00+09:00',
    })).toBe(true);
    expect(await getFormalooForm(DB, 'fa_internal')).toMatchObject({
      builder_status: 'published',
      published_at: '2026-07-21T10:00:00+09:00',
    });
  });

  test.each([
    ['definition_json', '{"fields":[1],"logic":[]}'],
    ['title', '別のタイトル'],
    ['description', '別の説明'],
    ['updated_at', '2026-07-21T09:00:01+09:00'],
  ] as const)('rejects publish when confirmed %s has become stale', async (column, changedValue) => {
    raw.prepare(
      `UPDATE formaloo_forms
       SET render_backend = 'internal', builder_status = 'draft', title = '申込フォーム',
           description = NULL, updated_at = '2026-07-21T09:00:00+09:00'
       WHERE id = 'fa_internal'`,
    ).run();
    const confirmed = (await getFormalooForm(DB, 'fa_internal'))!;
    raw.prepare(`UPDATE formaloo_forms SET ${column} = ? WHERE id = 'fa_internal'`).run(changedValue);

    expect(await publishInternalFormDefinition(DB, {
      formId: 'fa_internal',
      definitionJson: confirmed.definition_json,
      title: confirmed.title,
      description: confirmed.description,
      updatedAt: confirmed.updated_at,
      publishedAt: '2026-07-21T10:00:00+09:00',
    })).toBe(false);
    expect(await getFormalooForm(DB, 'fa_internal')).toMatchObject({
      builder_status: 'draft',
      published_at: null,
    });
  });

  test.each([
    ['definition_json', '{"fields":[1],"logic":[]}'],
    ['title', '後から変わったタイトル'],
    ['description', '後から変わった説明'],
    ['updated_at', '2026-07-21T09:00:01+09:00'],
  ] as const)('rejects unpublish when displayed %s has become stale', async (column, changedValue) => {
    raw.prepare(
      `UPDATE formaloo_forms
       SET render_backend = 'internal', builder_status = 'published', title = '申込フォーム',
           description = NULL, updated_at = '2026-07-21T09:00:00+09:00'
       WHERE id = 'fa_internal'`,
    ).run();
    const displayed = (await getFormalooForm(DB, 'fa_internal'))!;
    raw.prepare(`UPDATE formaloo_forms SET ${column} = ? WHERE id = 'fa_internal'`).run(changedValue);

    expect(await unpublishInternalFormDefinition(DB, {
      formId: displayed.id,
      definitionJson: displayed.definition_json,
      title: displayed.title,
      description: displayed.description,
      updatedAt: displayed.updated_at,
      unpublishedAt: '2026-07-21T10:00:00+09:00',
    })).toBe(false);
    expect(await getFormalooForm(DB, 'fa_internal')).toMatchObject({
      builder_status: 'published',
    });
  });

  test.each(['line', 'invalid'] as const)(
    'persists an explicitly classified %s origin channel',
    async (originChannel) => {
      const created = await createInternalFormSubmission(DB, {
        formId: 'fa_internal',
        answers: { name: '佐藤' },
        originChannel,
      });

      expect(created.origin_channel).toBe(originChannel);
    },
  );

  test('updates answers with compare-and-swap and returns the current row on a stale edit', async () => {
    const created = await createInternalFormSubmission(DB, {
      formId: 'fa_internal',
      answers: { name: '変更前' },
    });

    const updated = await updateInternalFormSubmissionAnswers(DB, {
      formId: 'fa_internal',
      submissionId: created.id,
      expectedEditVersion: 0,
      expectedEditLinkEpoch: 4,
      previousAnswers: { name: '変更前' },
      answers: { name: '変更後' },
    });
    expect(updated).toMatchObject({
      status: 'updated',
      submission: {
        id: created.id,
        answers_json: '{"name":"変更後"}',
        edit_version: 1,
        external_edit_source: 'edit_link',
        external_edited_at: expect.any(String),
        external_edit_approved_at: null,
        external_edit_changes_json:
          '[{"fieldId":"name","before":"変更前","after":"変更後"}]',
      },
    });

    const conflict = await updateInternalFormSubmissionAnswers(DB, {
      formId: 'fa_internal',
      submissionId: created.id,
      expectedEditVersion: 0,
      expectedEditLinkEpoch: 4,
      previousAnswers: { name: '変更前' },
      answers: { name: '競合書き込み' },
    });
    expect(conflict).toMatchObject({
      status: 'conflict',
      submission: {
        id: created.id,
        answers_json: '{"name":"変更後"}',
        edit_version: 1,
      },
    });

    raw.prepare(
      `UPDATE internal_form_submissions
       SET external_edit_approved_at = '2026-07-23T10:00:00+09:00'
       WHERE id = ?`,
    ).run(created.id);
    const editedAgain = await updateInternalFormSubmissionAnswers(DB, {
      formId: 'fa_internal',
      submissionId: created.id,
      expectedEditVersion: 1,
      expectedEditLinkEpoch: 4,
      previousAnswers: { name: '変更後' },
      answers: { name: '再編集' },
    });
    expect(editedAgain).toMatchObject({
      status: 'updated',
      submission: {
        answers_json: '{"name":"再編集"}',
        edit_version: 2,
        external_edit_source: 'edit_link',
        external_edit_approved_at: null,
        external_edit_changes_json:
          '[{"fieldId":"name","before":"変更後","after":"再編集"}]',
      },
    });
  });

  test('admin-origin keeps edit-link epoch and version CAS without raising an external-edit review', async () => {
    const created = await createInternalFormSubmission(DB, {
      formId: 'fa_internal',
      answers: { name: '変更前' },
    });

    const updated = await updateInternalFormSubmissionAnswers(DB, {
      authorization: 'admin-origin',
      formId: 'fa_internal',
      submissionId: created.id,
      expectedEditVersion: 0,
      expectedEditLinkEpoch: 4,
      answers: { name: '管理画面から変更' },
    });
    expect(updated).toMatchObject({
      status: 'updated',
      submission: {
        answers_json: '{"name":"管理画面から変更"}',
        edit_version: 1,
        external_edit_source: null,
        external_edited_at: null,
        external_edit_approved_at: null,
      },
    });

    const stale = await updateInternalFormSubmissionAnswers(DB, {
      authorization: 'admin-origin',
      formId: 'fa_internal',
      submissionId: created.id,
      expectedEditVersion: 0,
      expectedEditLinkEpoch: 4,
      answers: { name: '古い管理画面から変更' },
    });
    expect(stale).toMatchObject({
      status: 'conflict',
      submission: {
        answers_json: '{"name":"管理画面から変更"}',
        edit_version: 1,
      },
    });

    raw.prepare(
      'UPDATE internal_form_notification_settings SET edit_link_epoch = 5 WHERE form_id = ?',
    ).run('fa_internal');
    const revoked = await updateInternalFormSubmissionAnswers(DB, {
      authorization: 'admin-origin',
      formId: 'fa_internal',
      submissionId: created.id,
      expectedEditVersion: 1,
      expectedEditLinkEpoch: 4,
      answers: { name: '失効済み管理画面から変更' },
    });
    expect(revoked).toMatchObject({
      status: 'revoked',
      submission: {
        answers_json: '{"name":"管理画面から変更"}',
        edit_version: 1,
      },
    });
  });

  test('filters pending external edits and approval only clears the review queue', async () => {
    const pending = await createInternalFormSubmission(DB, {
      formId: 'fa_internal',
      answers: { name: '編集URLから変更' },
    });
    const approved = await createInternalFormSubmission(DB, {
      formId: 'fa_internal',
      answers: { name: '承認済み' },
    });
    const internal = await createInternalFormSubmission(DB, {
      formId: 'fa_internal',
      answers: { name: '管理画面だけ' },
    });
    const unchanged = await createInternalFormSubmission(DB, {
      formId: 'fa_internal',
      answers: { name: '変更なし' },
    });
    raw.prepare(
      `UPDATE internal_form_submissions
       SET external_edit_source = 'edit_link',
           external_edited_at = '2026-07-23T10:00:00+09:00',
           external_edit_changes_json = ?
       WHERE id = ?`,
    ).run(
      JSON.stringify([{ fieldId: 'name', before: '変更前', after: '編集URLから変更' }]),
      pending.id,
    );
    raw.prepare(
      `UPDATE internal_form_submissions
       SET external_edit_source = 'sheet',
           external_edited_at = '2026-07-23T10:01:00+09:00',
           external_edit_approved_at = '2026-07-23T10:02:00+09:00'
       WHERE id = ?`,
    ).run(approved.id);
    raw.prepare(
      `UPDATE internal_form_submissions
       SET external_edit_source = 'edit_link',
           external_edited_at = '2026-07-23T10:03:00+09:00',
           external_edit_changes_json = '[]'
       WHERE id = ?`,
    ).run(unchanged.id);

    await expect(listInternalFormSubmissions(DB, 'fa_internal', {
      limit: 20,
      offset: 0,
    })).resolves.toMatchObject({ total: 4 });
    await expect(listInternalFormSubmissions(DB, 'fa_internal', {
      limit: 20,
      offset: 0,
      externalEditReview: 'pending',
    })).resolves.toEqual({
      rows: [expect.objectContaining({ id: pending.id, external_edit_source: 'edit_link' })],
      total: 1,
    });
    await expect(countPendingInternalFormExternalEdits(DB, 'fa_internal')).resolves.toBe(1);

    expect(await approveInternalFormSubmissionExternalEdit(
      DB,
      {
        formId: 'fa_internal',
        submissionId: pending.id,
        expectedSource: 'edit_link',
        expectedEditedAt: '2026-07-23T10:00:00+09:00',
        expectedAnswersJson: pending.answers_json,
        approvedAt: '2026-07-23T10:03:00+09:00',
      },
    )).toBe(true);
    await expect(listInternalFormSubmissions(DB, 'fa_internal', {
      limit: 20,
      offset: 0,
      externalEditReview: 'pending',
    })).resolves.toEqual({ rows: [], total: 0 });
    expect(raw.prepare(
      `SELECT answers_json, external_edit_approved_at
       FROM internal_form_submissions WHERE id = ?`,
    ).get(pending.id)).toEqual({
      answers_json: '{"name":"編集URLから変更"}',
      external_edit_approved_at: '2026-07-23T10:03:00+09:00',
    });
    expect(await approveInternalFormSubmissionExternalEdit(
      DB,
      {
        formId: 'fa_internal',
        submissionId: internal.id,
        expectedSource: null,
        expectedEditedAt: null,
        expectedAnswersJson: internal.answers_json,
      },
    ))
      .toBe(false);
  });

  test('does not approve an external edit that arrived after the reviewed revision', async () => {
    const submission = await createInternalFormSubmission(DB, {
      formId: 'fa_internal',
      answers: { name: '確認した回答' },
    });
    raw.prepare(
      `UPDATE internal_form_submissions
       SET external_edit_source = 'edit_link',
           external_edited_at = '2026-07-23T10:00:00+09:00'
       WHERE id = ?`,
    ).run(submission.id);
    const reviewed = await getInternalFormSubmission(DB, 'fa_internal', submission.id);

    raw.prepare(
      `UPDATE internal_form_submissions
       SET answers_json = '{"name":"確認後の再編集"}',
           external_edit_source = 'sheet',
           external_edited_at = '2026-07-23T10:01:00+09:00',
           external_edit_approved_at = NULL
       WHERE id = ?`,
    ).run(submission.id);

    expect(await approveInternalFormSubmissionExternalEdit(
      DB,
      {
        formId: 'fa_internal',
        submissionId: submission.id,
        expectedSource: reviewed?.external_edit_source ?? null,
        expectedEditedAt: reviewed?.external_edited_at ?? null,
        expectedAnswersJson: reviewed?.answers_json ?? '',
        approvedAt: '2026-07-23T10:02:00+09:00',
      },
    )).toBe(false);
    expect(raw.prepare(
      `SELECT answers_json, external_edit_source, external_edited_at,
              external_edit_approved_at
       FROM internal_form_submissions WHERE id = ?`,
    ).get(submission.id)).toEqual({
      answers_json: '{"name":"確認後の再編集"}',
      external_edit_source: 'sheet',
      external_edited_at: '2026-07-23T10:01:00+09:00',
      external_edit_approved_at: null,
    });
  });

  test('admin CAS works without edit-link settings and feeds the existing Sheets readers', async () => {
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('acc-admin', 'channel-admin', 'Admin', 'token', 'secret')`).run();
    raw.prepare(`UPDATE formaloo_forms
      SET render_backend = 'internal', line_account_id = 'acc-admin', allow_post_edit = 1
      WHERE id = 'fa_internal'`).run();
    raw.prepare(`INSERT INTO friends
      (id, line_user_id, display_name, line_account_id, metadata, created_at, updated_at)
      VALUES ('friend-admin', 'UADMIN', '管理対象', 'acc-admin', '{}',
              '2026-07-22T09:00:00+09:00', '2026-07-22T09:00:00+09:00')`).run();
    raw.prepare('DELETE FROM internal_form_notification_settings WHERE form_id = ?').run('fa_internal');
    const created = await createInternalFormSubmission(DB, {
      formId: 'fa_internal',
      friendId: 'friend-admin',
      answers: { name: '変更前', keep: '保持' },
    });

    const updated = await updateInternalFormSubmissionAnswers(DB, {
      authorization: 'admin',
      formId: 'fa_internal',
      submissionId: created.id,
      expectedEditVersion: 0,
      expectedAnswersJson: created.answers_json,
      expectedDefinitionJson: '{"fields":[],"logic":[]}',
      answers: { name: '管理画面で変更', keep: '保持' },
    });

    expect(updated).toMatchObject({
      status: 'updated',
      submission: {
        answers_json: '{"name":"管理画面で変更","keep":"保持"}',
        edit_version: 1,
        external_edit_source: null,
        external_edited_at: null,
        external_edit_approved_at: null,
        external_edit_changes_json: null,
      },
    });
    await expect(listLatestVerifiedInternalFormSubmissions(DB, 'acc-admin', 'fa_internal'))
      .resolves.toEqual([expect.objectContaining({ answers_json: '{"name":"管理画面で変更","keep":"保持"}' })]);
    await expect(listVerifiedInternalFormSubmissionsForSheets(DB, 'acc-admin', 'fa_internal'))
      .resolves.toEqual([expect.objectContaining({ answers_json: '{"name":"管理画面で変更","keep":"保持"}' })]);

    // Sheets write-back does not increment edit_version. answers_json CAS must still
    // prevent a stale admin screen from overwriting that newer value.
    raw.prepare('UPDATE internal_form_submissions SET answers_json = ? WHERE id = ?')
      .run('{"name":"シート側の新しい値","keep":"保持"}', created.id);
    const conflict = await updateInternalFormSubmissionAnswers(DB, {
      authorization: 'admin',
      formId: 'fa_internal',
      submissionId: created.id,
      expectedEditVersion: 1,
      expectedAnswersJson: '{"name":"管理画面で変更","keep":"保持"}',
      expectedDefinitionJson: '{"fields":[],"logic":[]}',
      answers: { name: '古い管理画面の値', keep: '保持' },
    });
    expect(conflict).toMatchObject({
      status: 'conflict',
      submission: { answers_json: '{"name":"シート側の新しい値","keep":"保持"}', edit_version: 1 },
    });

    raw.prepare("UPDATE formaloo_forms SET allow_post_edit = 0 WHERE id = 'fa_internal'").run();
    const policyConflict = await updateInternalFormSubmissionAnswers(DB, {
      authorization: 'admin',
      formId: 'fa_internal',
      submissionId: created.id,
      expectedEditVersion: 1,
      expectedAnswersJson: '{"name":"シート側の新しい値","keep":"保持"}',
      expectedDefinitionJson: '{"fields":[],"logic":[]}',
      answers: { name: '禁止後の管理更新', keep: '保持' },
    });
    expect(policyConflict).toMatchObject({
      status: 'conflict',
      submission: { answers_json: '{"name":"シート側の新しい値","keep":"保持"}', edit_version: 1 },
    });
  });

  test('atomically rejects a revoked edit-link epoch without mutating the submission', async () => {
    const created = await createInternalFormSubmission(DB, {
      formId: 'fa_internal',
      answers: { name: '元の回答' },
    });
    raw.prepare(
      'UPDATE internal_form_notification_settings SET edit_link_epoch = 5 WHERE form_id = ?',
    ).run('fa_internal');

    expect(await updateInternalFormSubmissionAnswers(DB, {
      formId: 'fa_internal',
      submissionId: created.id,
      expectedEditVersion: 0,
      expectedEditLinkEpoch: 4,
      previousAnswers: { name: '元の回答' },
      answers: { name: '失効済みリンクからの更新' },
    })).toEqual({
      status: 'revoked',
      submission: expect.objectContaining({
        answers_json: '{"name":"元の回答"}',
        edit_version: 0,
      }),
    });
    expect(await getInternalFormSubmission(DB, 'fa_internal', created.id))
      .toMatchObject({ answers_json: '{"name":"元の回答"}', edit_version: 0 });
  });

  test('does not update a submission through another form scope', async () => {
    const created = await createInternalFormSubmission(DB, {
      formId: 'fa_internal',
      answers: { name: '元の回答' },
    });

    expect(await updateInternalFormSubmissionAnswers(DB, {
      formId: 'fa_other',
      submissionId: created.id,
      expectedEditVersion: 0,
      expectedEditLinkEpoch: 4,
      previousAnswers: { name: '元の回答' },
      answers: { name: '越境更新' },
    })).toEqual({ status: 'conflict', submission: null });
    expect(await getInternalFormSubmission(DB, 'fa_internal', created.id))
      .toMatchObject({ answers_json: '{"name":"元の回答"}', edit_version: 0 });
  });
});
