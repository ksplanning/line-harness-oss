import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '..');

describe('migration 123 — AI FAQ draft review audit', () => {
  test('creates an append-only action log without changing existing draft rows', () => {
    const raw = new Database(':memory:');
    raw.exec(`
      CREATE TABLE ai_faq_drafts (
        id TEXT PRIMARY KEY,
        line_account_id TEXT,
        friend_id TEXT,
        question TEXT NOT NULL,
        draft_answer TEXT NOT NULL,
        evidence_faq_ids TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO ai_faq_drafts
        (id, line_account_id, friend_id, question, draft_answer, status, created_at, updated_at)
      VALUES ('draft-existing', 'acc-1', 'friend-1', '質問', '回答', 'pending', '2026-07-21T10:00:00', '2026-07-21T10:00:00');
    `);

    raw.exec(readFileSync(join(DB_ROOT, 'migrations/123_ai_faq_draft_review_audit.sql'), 'utf8'));

    expect(raw.prepare(`SELECT status, draft_answer FROM ai_faq_drafts WHERE id='draft-existing'`).get())
      .toEqual({ status: 'pending', draft_answer: '回答' });
    const columns = raw.prepare(`PRAGMA table_info(ai_faq_draft_audit_log)`).all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual([
      'id', 'draft_id', 'line_account_id', 'friend_id', 'actor_staff_id', 'action', 'created_at',
    ]);

    raw.prepare(`INSERT INTO ai_faq_draft_audit_log
      (id, draft_id, line_account_id, friend_id, actor_staff_id, action)
      VALUES ('audit-1', 'draft-existing', 'acc-1', 'friend-1', 'staff-1', 'edited')`).run();
    expect(() => raw.prepare(`UPDATE ai_faq_draft_audit_log SET action='discarded' WHERE id='audit-1'`).run())
      .toThrow(/append-only/);
    expect(() => raw.prepare(`DELETE FROM ai_faq_draft_audit_log WHERE id='audit-1'`).run())
      .toThrow(/append-only/);
    expect(() => raw.prepare(`INSERT OR REPLACE INTO ai_faq_draft_audit_log
      (id, draft_id, line_account_id, friend_id, actor_staff_id, action)
      VALUES ('audit-1', 'draft-existing', 'acc-1', 'friend-1', 'staff-2', 'approved')`).run())
      .toThrow(/append-only/);
  });
});
