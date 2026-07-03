/**
 * 049_saved_searches.sql (G10 保存済み検索) の additive 性 + スキーマ検証。
 *
 *   - checkMigration(049).ok === true (破壊操作ゼロ)
 *   - schema.sql replay に saved_searches 表 + 全列 + index が現れる
 *   - conditions 既定は空 SegmentCondition JSON
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkMigration } from '../../../scripts/check-migrations';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATION = join(PKG_ROOT, 'migrations', '049_saved_searches.sql');

function loadDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  db.exec(readFileSync(MIGRATION, 'utf8'));
  return db;
}

describe('049_saved_searches.sql', () => {
  it('passes the additive-only migration safety check', () => {
    expect(checkMigration(readFileSync(MIGRATION, 'utf8'))).toEqual({ ok: true });
  });

  let db: Database.Database;
  beforeEach(() => {
    db = loadDb();
  });

  it('creates saved_searches with all 6 expected columns', () => {
    const rows = db.prepare("PRAGMA table_info('saved_searches')").all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(['id', 'line_account_id', 'name', 'conditions', 'created_at', 'updated_at'].sort());
  });

  it('defaults conditions to an empty SegmentCondition JSON', () => {
    db.prepare(`INSERT INTO saved_searches (id, name) VALUES ('s-1', 'VIP')`).run();
    const row = db.prepare(`SELECT conditions FROM saved_searches WHERE id = 's-1'`).get() as { conditions: string };
    expect(JSON.parse(row.conditions)).toEqual({ operator: 'AND', rules: [] });
  });

  it('creates idx_saved_searches_account index', () => {
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_saved_searches_account'`)
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe('idx_saved_searches_account');
  });
});
