/**
 * form-post-edit (弾M / T-A1) — migration 100 additive: formaloo_row_slug 列 + formaloo_submission_edits 表。
 *   ①管理者編集の row addressing (row_slug) と ④最小監査 (edits 表) の台帳基盤。
 *   additive のみ (NULL 列 + CREATE TABLE/INDEX)・既存行不変・POLICY_CUTOFF=041 準拠。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS_DIR, f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      try { db.exec(stmt); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

let raw: Database.Database;

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
});

describe('form-post-edit — migration 100 additive (T-A1)', () => {
  test('formaloo_submissions に formaloo_row_slug 列が存在し NULL 可', () => {
    const cols = raw.prepare("PRAGMA table_info(formaloo_submissions)").all() as { name: string; notnull: number }[];
    const col = cols.find((c) => c.name === 'formaloo_row_slug');
    expect(col).toBeTruthy();
    expect(col!.notnull).toBe(0); // NULL 可 (既存行 = NULL = legacy backfill 対象)
  });

  test('既存 submission 行は formaloo_row_slug = NULL (additive 無破壊)', () => {
    raw.prepare(
      `INSERT INTO formaloo_submissions (id, form_id, answers_json, submitted_at) VALUES ('s1','f1','{}','2026-07-17T00:00:00+09:00')`,
    ).run();
    const row = raw.prepare('SELECT formaloo_row_slug AS v FROM formaloo_submissions WHERE id=?').get('s1') as { v: string | null };
    expect(row.v).toBeNull();
  });

  test('formaloo_submission_edits 表が期待列で存在する (④監査)', () => {
    const cols = (raw.prepare("PRAGMA table_info(formaloo_submission_edits)").all() as { name: string }[]).map((c) => c.name).sort();
    expect(cols).toEqual(
      ['edited_at', 'editor_staff_id', 'field_slug', 'form_id', 'id', 'new_value', 'old_value', 'submission_id'].sort(),
    );
  });

  test('formaloo_submission_edits へ 1 行 round-trip できる', () => {
    raw.prepare(
      `INSERT INTO formaloo_submission_edits (id, submission_id, form_id, editor_staff_id, edited_at, field_slug, old_value, new_value)
       VALUES ('e1','s1','f1','staff1','2026-07-17T01:00:00+09:00','fld_a','before','after')`,
    ).run();
    const row = raw.prepare('SELECT * FROM formaloo_submission_edits WHERE id=?').get('e1') as Record<string, string>;
    expect(row.old_value).toBe('before');
    expect(row.new_value).toBe('after');
    expect(row.editor_staff_id).toBe('staff1');
  });

  test('friend 最新 row 検索用の複合インデックスが存在する', () => {
    const idx = (raw.prepare("PRAGMA index_list('formaloo_submissions')").all() as { name: string }[]).map((i) => i.name);
    expect(idx).toContain('idx_formaloo_submissions_friend_latest');
  });

  test('migration 100 は additive のみ (DROP/RENAME/CHECK/ADD COLUMN NOT NULL を含まない)', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '100_formaloo_row_slug_and_edits.sql'), 'utf8')
      // -- 行コメントを剥がす (POLICY 準拠判定は DDL 本体のみ)
      .split('\n').map((l) => { const i = l.indexOf('--'); return i === -1 ? l : l.slice(0, i); }).join('\n');
    expect(sql).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(sql).not.toMatch(/\bRENAME\s+(COLUMN|TO)\b/i);
    expect(sql).not.toMatch(/\bALTER\s+COLUMN\s+\S+\s+TYPE\b/i);
    // ADD COLUMN ... NOT NULL without DEFAULT (既存行を壊す)
    expect(sql).not.toMatch(/\bADD\s+COLUMN\s+\S+[^,;]*?\bNOT\s+NULL\b(?![^,;]*\bDEFAULT\b)/i);
  });
});
