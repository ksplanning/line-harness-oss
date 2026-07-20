import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  createInternalFormSubmission,
  getInternalFormSubmission,
  listLatestVerifiedInternalFormSubmissions,
  listInternalFormSubmissions,
  setFormRenderBackend,
  updateLatestInternalFormSubmissionAnswersForSheets,
} from './internal-forms.js';
import { getFormalooForm } from './formaloo.js';
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
    expect(await listInternalFormSubmissions(DB, 'fa_internal', { limit: 20, offset: 0 }))
      .toMatchObject({ total: 1, rows: [expect.objectContaining({ id: created.id })] });
    expect(await getInternalFormSubmission(DB, 'fa_internal', created.id))
      .toMatchObject({ id: created.id, friend_id: 'friend-1' });
    expect(await getInternalFormSubmission(DB, 'fa_other', created.id)).toBeNull();
  });

  test('lists only the latest verified submission per friend inside the requested form and tenant', async () => {
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
    await createInternalFormSubmission(DB, {
      formId: 'fa_internal', friendId: null, answers: { name: '匿名' },
      submittedAt: '2026-07-21T12:00:00+09:00',
    });
    await createInternalFormSubmission(DB, {
      formId: 'fa_internal', friendId: 'friend-2', answers: { name: '別tenant' },
      submittedAt: '2026-07-21T12:00:00+09:00',
    });
    await createInternalFormSubmission(DB, {
      formId: 'fa_other', friendId: 'friend-1', answers: { name: '別form' },
      submittedAt: '2026-07-21T12:00:00+09:00',
    });

    await expect(listLatestVerifiedInternalFormSubmissions(DB, 'acc-1', 'fa_internal'))
      .resolves.toEqual([expect.objectContaining({
        id: latest.id,
        friend_id: 'friend-1',
        answers_json: '{"name":"同時刻の後"}',
      })]);
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
      expectedAnswersJson: original.answers_json, answers: { name: 'シート編集', keep: '保持' }, lease,
    })).resolves.toBe(true);
    expect(raw.prepare(`SELECT answers_json, submitted_at FROM internal_form_submissions WHERE id=?`)
      .get(original.id)).toEqual({
      answers_json: '{"name":"シート編集","keep":"保持"}',
      submitted_at: '2026-07-21T10:00:00+09:00',
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
});
