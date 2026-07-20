import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  readFaqPersonalContextData,
  recordFaqPersonalContextAudit,
} from './faq-personal-context.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database) {
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
        async run() {
          const info = statement.run(...(params as never[]));
          return { meta: { changes: info.changes } };
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
  replayAll(raw);
  db = d1(raw);

  raw.prepare(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
     VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
  ).run(
    'account-a', 'channel-a', 'A', 'synthetic-token-a', 'synthetic-secret-a',
    'account-b', 'channel-b', 'B', 'synthetic-token-b', 'synthetic-secret-b',
  );
  raw.prepare(
    `INSERT INTO friends (id, line_user_id, line_account_id, display_name, metadata)
     VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
  ).run(
    'friend-a', 'synthetic-user-a', 'account-a', '利用者A', JSON.stringify({ 入金状態: '確認済み', 内部メモ: 'Aだけ' }),
    'friend-b', 'synthetic-user-b', 'account-b', '利用者B', JSON.stringify({ 入金状態: '未確認-B-MARKER' }),
  );
  raw.prepare(
    `INSERT INTO friend_field_definitions
       (id, name, default_value, display_order, is_active)
     VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
  ).run(
    'field-payment', '入金状態', '未確認', 1, 1,
    'field-note', '内部メモ', '', 2, 1,
    'field-inactive', '無効項目', '出してはいけない', 3, 0,
  );

  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, line_account_id)
     VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)`,
  ).run(
    'form-a', '申込フォーム', 'account-a',
    'form-global', '共通アンケート', null,
    'form-b', '別アカウントフォーム', 'account-b',
  );
  raw.prepare(
    `INSERT INTO formaloo_field_map
       (id, form_id, formaloo_field_slug, field_type, label, position)
     VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
  ).run(
    'field-form-payment', 'form-a', 'payment', 'text', '入金確認', 1,
    'field-form-plan', 'form-global', 'plan', 'text', '希望プラン', 1,
  );
  raw.prepare(
    `INSERT INTO formaloo_submissions
       (id, form_id, friend_id, answers_json, submitted_at, verified)
     VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
  ).run(
    'formaloo-a-new', 'form-a', 'friend-a', JSON.stringify({ payment: '済' }), '2026-07-20T10:00:00+09:00', 1,
    'formaloo-a-global', 'form-global', 'friend-a', JSON.stringify({ plan: '標準' }), '2026-07-19T10:00:00+09:00', 1,
    'formaloo-a-unverified', 'form-a', 'friend-a', JSON.stringify({ payment: 'UNVERIFIED-MARKER' }), '2026-07-21T10:00:00+09:00', 0,
    'formaloo-b', 'form-b', 'friend-b', JSON.stringify({ payment: 'OTHER-FRIEND-MARKER' }), '2026-07-21T11:00:00+09:00', 1,
  );
  // Corrupt cross-account linkage must still be rejected by the form account scope.
  raw.prepare(
    `INSERT INTO formaloo_submissions
       (id, form_id, friend_id, answers_json, submitted_at, verified)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    'formaloo-cross-account', 'form-b', 'friend-a', JSON.stringify({ payment: 'CROSS-ACCOUNT-MARKER' }), '2026-07-21T12:00:00+09:00', 1,
  );
  raw.prepare(
    `INSERT INTO internal_form_submissions
       (id, form_id, friend_id, answers_json, submitted_at)
     VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`,
  ).run(
    'internal-a', 'form-a', 'friend-a', JSON.stringify({ 'field-form-payment': '再確認済み' }), '2026-07-18T10:00:00+09:00',
    'internal-b', 'form-b', 'friend-b', JSON.stringify({ 'field-form-payment': 'OTHER-INTERNAL-MARKER' }), '2026-07-21T10:00:00+09:00',
  );
});

describe('readFaqPersonalContextData', () => {
  test('exact friend/account の3源だけを読み、未検証・別人・別accountを除外する', async () => {
    const result = await readFaqPersonalContextData(db, {
      friendId: 'friend-a',
      lineAccountId: 'account-a',
      submissionLimit: 3,
    });

    expect(result?.friend).toEqual({
      friendId: 'friend-a',
      lineAccountId: 'account-a',
      displayName: '利用者A',
      metadataJson: JSON.stringify({ 入金状態: '確認済み', 内部メモ: 'Aだけ' }),
    });
    expect(result?.fieldDefinitions.map((field) => field.id)).toEqual(['field-payment', 'field-note']);
    expect(result?.formalooSubmissions.map((row) => row.submissionId)).toEqual([
      'formaloo-a-new',
      'formaloo-a-global',
    ]);
    expect(result?.internalSubmissions.map((row) => row.submissionId)).toEqual(['internal-a']);
    expect(result?.fieldMappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ formId: 'form-a', fieldId: 'field-form-payment', label: '入金確認' }),
      expect.objectContaining({ formId: 'form-global', fieldSlug: 'plan', label: '希望プラン' }),
    ]));

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('UNVERIFIED-MARKER');
    expect(serialized).not.toContain('OTHER-FRIEND-MARKER');
    expect(serialized).not.toContain('OTHER-INTERNAL-MARKER');
    expect(serialized).not.toContain('CROSS-ACCOUNT-MARKER');
  });

  test('friend が指定 account に存在しない場合は source query を返さない', async () => {
    await expect(readFaqPersonalContextData(db, {
      friendId: 'friend-a',
      lineAccountId: 'account-b',
      submissionLimit: 3,
    })).resolves.toBeNull();
  });
});

describe('recordFaqPersonalContextAudit', () => {
  test('値を受け取らず注入メタデータだけを保存する', async () => {
    const id = await recordFaqPersonalContextAudit(db, {
      lineAccountId: 'account-a',
      friendId: 'friend-a',
      displayNameIncluded: true,
      customFieldIds: ['field-payment'],
      formalooSubmissionCount: 2,
      internalSubmissionCount: 1,
      promptTokenEstimate: 42,
      wasTruncated: false,
    });

    const row = raw.prepare(
      `SELECT line_account_id, friend_id, display_name_included,
              custom_field_ids_json, formaloo_submission_count,
              internal_submission_count, prompt_token_estimate, was_truncated
         FROM faq_personal_context_audit_log WHERE id = ?`,
    ).get(id);
    expect(row).toEqual({
      line_account_id: 'account-a',
      friend_id: 'friend-a',
      display_name_included: 1,
      custom_field_ids_json: '["field-payment"]',
      formaloo_submission_count: 2,
      internal_submission_count: 1,
      prompt_token_estimate: 42,
      was_truncated: 0,
    });
  });
});
