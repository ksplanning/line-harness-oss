import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  join(__dirname, '../migrations/144_ai_reply_style_defaults.sql'),
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
    INSERT INTO line_accounts (id) VALUES ('account-a'), ('account-b'), ('account-c');
    INSERT INTO account_settings (id, line_account_id, key, value)
    VALUES (
      'faq-a',
      'account-a',
      'faq_bot',
      '{"enabled":true,"threshold":0.75,"handoffMessage":"担当者へ","autoReplyNotice":"注記","maxRepliesPerDay":3,"answerMode":"draft"}'
    );
    INSERT INTO account_settings (id, line_account_id, key, value)
    VALUES (
      'faq-b',
      'account-b',
      'faq_bot',
      '{"enabled":true,"answerMode":"auto","replyStyle":{"instructions":"親しみやすく","greeting":"店舗Bです。"}}'
    );
    INSERT INTO account_settings (id, line_account_id, key, value)
    VALUES ('theme-a', 'account-a', 'theme', '{"color":"blue"}');
  `);
});

function faqSettings(accountId: string) {
  const row = raw.prepare(
    `SELECT value FROM account_settings WHERE line_account_id = ? AND key = 'faq_bot'`,
  ).get(accountId) as { value: string } | undefined;
  return row ? JSON.parse(row.value) as Record<string, unknown> : null;
}

describe('migration 144 — account-scoped AI reply style defaults', () => {
  test('既存の FAQ 設定を保ったまま未設定の返信スタイルだけを空で追加する', () => {
    raw.exec(migration);

    expect(faqSettings('account-a')).toEqual({
      enabled: true,
      threshold: 0.75,
      handoffMessage: '担当者へ',
      autoReplyNotice: '注記',
      maxRepliesPerDay: 3,
      answerMode: 'draft',
      replyStyle: { instructions: '', greeting: '' },
    });
  });

  test('保存済みの返信スタイルを上書きせず、設定行のないアカウントだけ既定行を追加する', () => {
    raw.exec(migration);

    expect(faqSettings('account-b')).toMatchObject({
      replyStyle: { instructions: '親しみやすく', greeting: '店舗Bです。' },
    });
    expect(faqSettings('account-c')).toEqual({
      enabled: false,
      threshold: 0.6,
      handoffMessage: '',
      autoReplyNotice: '',
      maxRepliesPerDay: 5,
      answerMode: 'draft',
      replyStyle: { instructions: '', greeting: '' },
    });
  });

  test('再実行しても値と updated_at を変えず、faq_bot 以外の設定にも触れない', () => {
    raw.exec(migration);
    raw.prepare(
      `UPDATE account_settings SET updated_at = 'stable-after-first-run' WHERE key = 'faq_bot'`,
    ).run();

    raw.exec(migration);

    const timestamps = raw.prepare(
      `SELECT DISTINCT updated_at FROM account_settings WHERE key = 'faq_bot'`,
    ).all() as Array<{ updated_at: string }>;
    expect(timestamps).toEqual([{ updated_at: 'stable-after-first-run' }]);
    expect(raw.prepare(`SELECT value FROM account_settings WHERE id = 'theme-a'`).get())
      .toEqual({ value: '{"color":"blue"}' });
  });
});
