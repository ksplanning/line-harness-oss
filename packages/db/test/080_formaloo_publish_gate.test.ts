/**
 * T-B3 (F-2) — migration 080 が formaloo_forms に publish gate 状態列を additive で足す検証。
 *   - builder_status  : draft | in_review | published (状態機械 / 既定 draft)
 *   - published_at    : 初回公開時刻 (NULL = 未公開 → 公開 URL 無効 / N-7)
 * additive (ADD COLUMN nullable or DEFAULT)。既存 formaloo_forms 行の挙動は不変。
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

describe('migration 080 — formaloo_forms publish gate 状態 (additive / N-7)', () => {
  test('builder_status / published_at 列が生える', () => {
    const cols = (raw.prepare(`PRAGMA table_info(formaloo_forms)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('builder_status');
    expect(cols).toContain('published_at');
  });

  test('新規 formaloo_forms は既定 draft / published_at=NULL (公開 URL 無効の初期状態)', () => {
    raw.prepare(`INSERT INTO formaloo_forms (id, title) VALUES ('fa1','新規')`).run();
    const row = raw.prepare(`SELECT builder_status, published_at FROM formaloo_forms WHERE id='fa1'`).get() as { builder_status: string; published_at: string | null };
    expect(row.builder_status).toBe('draft');
    expect(row.published_at).toBeNull();
  });

  test('published へ遷移し published_at を記録できる', () => {
    raw.prepare(`INSERT INTO formaloo_forms (id, title) VALUES ('fa1','x')`).run();
    raw.prepare(`UPDATE formaloo_forms SET builder_status='published', published_at='2026-07-10T12:00:00+09:00' WHERE id='fa1'`).run();
    const row = raw.prepare(`SELECT builder_status, published_at FROM formaloo_forms WHERE id='fa1'`).get() as { builder_status: string; published_at: string };
    expect(row.builder_status).toBe('published');
    expect(row.published_at).toBe('2026-07-10T12:00:00+09:00');
  });

  test('既存 079 列は不変 (definition_json/on_submit_tag_id/deleted)', () => {
    const cols = (raw.prepare(`PRAGMA table_info(formaloo_forms)`).all() as { name: string }[]).map((c) => c.name);
    for (const c of ['id', 'formaloo_slug', 'definition_json', 'on_submit_tag_id', 'on_submit_scenario_id', 'submit_count', 'deleted']) {
      expect(cols).toContain(c);
    }
  });
});
