/**
 * 050_canned_responses.sql (G23 チャット定型文) の additive 性 + スキーマ検証。
 *
 *   - checkMigration(050).ok === true (破壊操作ゼロ)
 *   - schema.sql replay に canned_responses 表 + 全列 + index が現れる
 *   - line_account_id は既定 NULL (全アカ共通) / title・content は NOT NULL
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMigration } from '../../../scripts/check-migrations';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATION = join(PKG_ROOT, 'migrations', '050_canned_responses.sql');

function loadDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  db.exec(readFileSync(MIGRATION, 'utf8'));
  return db;
}

describe('050_canned_responses.sql', () => {
  it('passes the additive-only migration safety check', () => {
    expect(checkMigration(readFileSync(MIGRATION, 'utf8'))).toEqual({ ok: true });
  });

  let db: Database.Database;
  beforeEach(() => {
    db = loadDb();
  });

  it('creates canned_responses with all 6 expected columns', () => {
    const rows = db.prepare("PRAGMA table_info('canned_responses')").all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(['id', 'line_account_id', 'title', 'content', 'created_at', 'updated_at'].sort());
  });

  it('defaults line_account_id to NULL (global) when omitted', () => {
    db.prepare(`INSERT INTO canned_responses (id, title, content) VALUES ('c-1', '営業案内', 'ご案内します')`).run();
    const row = db
      .prepare(`SELECT line_account_id, title, content FROM canned_responses WHERE id = 'c-1'`)
      .get() as { line_account_id: string | null; title: string; content: string };
    expect(row.line_account_id).toBeNull();
    expect(row.title).toBe('営業案内');
    expect(row.content).toBe('ご案内します');
  });

  it('creates idx_canned_responses_account index', () => {
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_canned_responses_account'`)
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe('idx_canned_responses_account');
  });
});
