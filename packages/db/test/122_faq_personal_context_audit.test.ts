import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  join(__dirname, '../migrations/122_faq_personal_context_audit.sql'),
  'utf8',
);

let raw: Database.Database;

beforeEach(() => {
  raw = new Database(':memory:');
});

describe('migration 122 — FAQ personal-context audit log', () => {
  test('PII valuesを持たない注入メタデータだけを追記できる', () => {
    raw.exec(migration);
    raw.prepare(
      `INSERT INTO faq_personal_context_audit_log
         (id, line_account_id, friend_id, display_name_included,
          custom_field_ids_json, formaloo_submission_count,
          internal_submission_count, prompt_token_estimate, was_truncated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'audit-1',
      'account-alpha',
      'friend-alpha',
      1,
      JSON.stringify(['field-payment-status']),
      2,
      1,
      123,
      0,
    );

    const row = raw.prepare(
      `SELECT line_account_id, friend_id, display_name_included,
              custom_field_ids_json, formaloo_submission_count,
              internal_submission_count, prompt_token_estimate, was_truncated
         FROM faq_personal_context_audit_log WHERE id = 'audit-1'`,
    ).get();
    expect(row).toEqual({
      line_account_id: 'account-alpha',
      friend_id: 'friend-alpha',
      display_name_included: 1,
      custom_field_ids_json: '["field-payment-status"]',
      formaloo_submission_count: 2,
      internal_submission_count: 1,
      prompt_token_estimate: 123,
      was_truncated: 0,
    });

    const columns = raw.prepare("PRAGMA table_info('faq_personal_context_audit_log')")
      .all()
      .map((column) => (column as { name: string }).name);
    expect(columns).not.toContain('display_name');
    expect(columns).not.toContain('custom_field_values_json');
    expect(columns).not.toContain('answers_json');
  });

  test('監査行は append-only で更新・削除できない', () => {
    raw.exec(migration);
    raw.prepare(
      `INSERT INTO faq_personal_context_audit_log
         (id, line_account_id, friend_id)
       VALUES ('audit-1', 'account-alpha', 'friend-alpha')`,
    ).run();

    expect(() => raw.prepare(
      "UPDATE faq_personal_context_audit_log SET friend_id = 'friend-beta' WHERE id = 'audit-1'",
    ).run()).toThrow(/append-only/);
    expect(() => raw.prepare(
      "DELETE FROM faq_personal_context_audit_log WHERE id = 'audit-1'",
    ).run()).toThrow(/append-only/);
  });

  test('migration を再適用しても既存監査行を保つ', () => {
    raw.exec(migration);
    raw.prepare(
      `INSERT INTO faq_personal_context_audit_log
         (id, line_account_id, friend_id)
       VALUES ('audit-1', 'account-alpha', 'friend-alpha')`,
    ).run();

    raw.exec(migration);

    expect(raw.prepare('SELECT COUNT(*) AS count FROM faq_personal_context_audit_log').get())
      .toEqual({ count: 1 });
  });
});
