/**
 * T-D1 (F-4) — migration 082 がデータコックピットの保存フィルタ用テーブルを additive で足す検証。
 *   formaloo_saved_filters: form 単位で「絞り込み条件 (q/field/期間/sort)」を名前付き保存 (049 saved_searches と同型)。
 * additive のみ (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS)。既存テーブルは無改変 (D-1)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(PKG_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(PKG_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      try { db.exec(stmt); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

let raw: Database.Database;
beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
});

describe('migration 082 — formaloo_saved_filters (additive / T-D1)', () => {
  test('テーブルと索引が生える', () => {
    const cols = (raw.prepare(`PRAGMA table_info(formaloo_saved_filters)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['id', 'form_id', 'name', 'filter_json', 'created_at', 'updated_at']));
  });

  test('form 単位で保存フィルタを INSERT / 既定 filter_json は空 object', () => {
    raw.prepare(`INSERT INTO formaloo_saved_filters (id, form_id, name) VALUES ('sf1','fa1','未対応のみ')`).run();
    const row = raw.prepare(`SELECT form_id, name, filter_json FROM formaloo_saved_filters WHERE id='sf1'`).get() as { form_id: string; name: string; filter_json: string };
    expect(row.form_id).toBe('fa1');
    expect(row.name).toBe('未対応のみ');
    expect(row.filter_json).toBe('{}');
  });

  test('既存テーブル (formaloo_forms/formaloo_submissions/saved_searches) は不変 (D-1)', () => {
    for (const t of ['formaloo_forms', 'formaloo_submissions', 'saved_searches']) {
      const n = (raw.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name=?`).get(t) as { n: number }).n;
      expect(n).toBe(1);
    }
  });
});
