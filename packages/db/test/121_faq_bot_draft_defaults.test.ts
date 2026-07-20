import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  join(__dirname, '../migrations/121_faq_bot_draft_defaults.sql'),
  'utf8',
);

let raw: Database.Database;

beforeEach(() => {
  raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE line_accounts (id TEXT PRIMARY KEY);
    CREATE TABLE account_settings (
      id TEXT PRIMARY KEY,
      line_account_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
      UNIQUE(line_account_id, key)
    );
    INSERT INTO line_accounts (id) VALUES ('ks-account'), ('piecemaker-account');
    INSERT INTO account_settings (id, line_account_id, key, value)
    VALUES (
      'ks-faq',
      'ks-account',
      'faq_bot',
      '{"enabled":false,"threshold":0.75,"handoffMessage":"担当者へ","autoReplyNotice":"注記","maxRepliesPerDay":3,"answerMode":"auto"}'
    );
    INSERT INTO account_settings (id, line_account_id, key, value)
    VALUES ('ks-theme', 'ks-account', 'theme', '{"color":"blue"}');
  `);
});

function faqSettings(accountId: string) {
  const row = raw.prepare(
    `SELECT value FROM account_settings WHERE line_account_id = ? AND key = 'faq_bot'`,
  ).get(accountId) as { value: string } | undefined;
  return row ? JSON.parse(row.value) as Record<string, unknown> : null;
}

describe('migration 121 — FAQ bot ON + draft defaults', () => {
  test('既存設定を ON + draft に直し、他の設定値は保持する', () => {
    raw.exec(migration);

    expect(faqSettings('ks-account')).toEqual({
      enabled: true,
      threshold: 0.75,
      handoffMessage: '担当者へ',
      autoReplyNotice: '注記',
      maxRepliesPerDay: 3,
      answerMode: 'draft',
    });
  });

  test('設定行がないアカウントにも enabled=true / answerMode=draft の安全な既定行を作る', () => {
    raw.exec(migration);

    expect(faqSettings('piecemaker-account')).toEqual({
      enabled: true,
      threshold: 0.6,
      handoffMessage: '',
      autoReplyNotice: '',
      maxRepliesPerDay: 5,
      answerMode: 'draft',
    });
  });

  test('再実行しても account ごとの faq_bot 行は 1 件のまま', () => {
    raw.exec(migration);
    raw.exec(migration);

    const rows = raw.prepare(
      `SELECT line_account_id, COUNT(*) AS count
         FROM account_settings
        WHERE key = 'faq_bot'
        GROUP BY line_account_id
        ORDER BY line_account_id`,
    ).all() as Array<{ line_account_id: string; count: number }>;
    expect(rows).toEqual([
      { line_account_id: 'ks-account', count: 1 },
      { line_account_id: 'piecemaker-account', count: 1 },
    ]);
  });

  test('既に ON + draft の行は再実行時に updated_at も書き換えない', () => {
    raw.exec(migration);
    raw.prepare(
      `UPDATE account_settings SET updated_at = 'stable-after-first-run' WHERE key = 'faq_bot'`,
    ).run();

    raw.exec(migration);

    const rows = raw.prepare(
      `SELECT DISTINCT updated_at FROM account_settings WHERE key = 'faq_bot'`,
    ).all() as Array<{ updated_at: string }>;
    expect(rows).toEqual([{ updated_at: 'stable-after-first-run' }]);
  });

  test('faq_bot 以外の account_settings は変更しない', () => {
    raw.exec(migration);

    const row = raw.prepare(
      `SELECT value FROM account_settings WHERE id = 'ks-theme'`,
    ).get() as { value: string };
    expect(row.value).toBe('{"color":"blue"}');
  });
});
