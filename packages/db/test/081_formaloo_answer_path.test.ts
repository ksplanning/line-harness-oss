/**
 * T-C1 (F-3) — migration 081 が formaloo_submissions に回答経路の状態列を additive で足す検証。
 *   - line_processed : LINE 後処理 (tag/scenario/flex) が発火済か。既定 0。再送で二重発火させないための claim フラグ (N-3)。
 *   - verified       : 署名 or rows API pull-verify 済か。既定 0。未署名 webhook は verified=0 で隔離 (N-12)。
 * additive のみ (ADD COLUMN NOT NULL DEFAULT)。既存 formaloo_submissions 行 (079) の挙動は不変 (D-1 併存)。
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

describe('migration 081 — formaloo_submissions 回答経路状態 (additive / N-3・N-12)', () => {
  test('line_processed / verified 列が生える', () => {
    const cols = (raw.prepare(`PRAGMA table_info(formaloo_submissions)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('line_processed');
    expect(cols).toContain('verified');
  });

  test('新規 submission は既定 line_processed=0 / verified=0 (未処理・未検証)', () => {
    raw.prepare(`INSERT INTO formaloo_submissions (id, form_id, submitted_at) VALUES ('s1','fa1','2026-07-10T00:00:00+09:00')`).run();
    const row = raw.prepare(`SELECT line_processed, verified FROM formaloo_submissions WHERE id='s1'`).get() as { line_processed: number; verified: number };
    expect(row.line_processed).toBe(0);
    expect(row.verified).toBe(0);
  });

  test('claim: line_processed を 0→1 に更新でき、2 回目の claim は 0 件 (再送二重発火なしの土台 / N-3)', () => {
    raw.prepare(`INSERT INTO formaloo_submissions (id, form_id, submitted_at) VALUES ('s1','fa1','x')`).run();
    const r1 = raw.prepare(`UPDATE formaloo_submissions SET line_processed=1 WHERE id='s1' AND line_processed=0`).run();
    expect(r1.changes).toBe(1);
    const r2 = raw.prepare(`UPDATE formaloo_submissions SET line_processed=1 WHERE id='s1' AND line_processed=0`).run();
    expect(r2.changes).toBe(0);
  });

  test('既存 079 列は不変 (id/form_id/answers_json/submitted_at 等)', () => {
    const cols = (raw.prepare(`PRAGMA table_info(formaloo_submissions)`).all() as { name: string }[]).map((c) => c.name);
    for (const c of ['id', 'form_id', 'formaloo_slug', 'friend_id', 'answers_json', 'submitted_at', 'synced_at']) {
      expect(cols).toContain(c);
    }
  });
});
