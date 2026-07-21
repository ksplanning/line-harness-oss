import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  join(__dirname, '../migrations/123_faq_draft_answerable.sql'),
  'utf8',
);

let raw: Database.Database;

beforeEach(() => {
  raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE ai_faq_drafts (
      id TEXT PRIMARY KEY,
      line_account_id TEXT,
      friend_id TEXT,
      question TEXT NOT NULL,
      draft_answer TEXT NOT NULL,
      evidence_faq_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'))
    );
    INSERT INTO ai_faq_drafts (id, question, draft_answer)
    VALUES ('existing', '営業時間は？', '10時からです');
  `);
});

describe('migration 123 — AI FAQ draft answerable flag', () => {
  test('既存草案をanswerable=1へ補完し、新規省略時も1にする', () => {
    raw.exec(migration);

    const column = (raw.prepare(`PRAGMA table_info('ai_faq_drafts')`).all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>).find((candidate) => candidate.name === 'answerable');
    expect(column).toMatchObject({ name: 'answerable', notnull: 1, dflt_value: '1' });
    expect(raw.prepare(`SELECT answerable FROM ai_faq_drafts WHERE id = 'existing'`).get())
      .toEqual({ answerable: 1 });

    raw.prepare(`INSERT INTO ai_faq_drafts (id, question, draft_answer) VALUES (?, ?, ?)`)
      .run('new-default', '料金は？', '1000円です');
    expect(raw.prepare(`SELECT answerable FROM ai_faq_drafts WHERE id = 'new-default'`).get())
      .toEqual({ answerable: 1 });
  });

  test('answerable=0を保存でき、0/1以外はDB制約で拒否する', () => {
    raw.exec(migration);

    raw.prepare(
      `INSERT INTO ai_faq_drafts (id, question, draft_answer, answerable) VALUES (?, ?, ?, ?)`,
    ).run('source-limited', '申込開始日は？', '資料だけでは確認できません', 0);
    expect(raw.prepare(`SELECT answerable FROM ai_faq_drafts WHERE id = 'source-limited'`).get())
      .toEqual({ answerable: 0 });

    expect(() => raw.prepare(
      `INSERT INTO ai_faq_drafts (id, question, draft_answer, answerable) VALUES (?, ?, ?, ?)`,
    ).run('invalid', '不正値', '不正値', 2)).toThrow(/CHECK constraint failed/);
  });
});
