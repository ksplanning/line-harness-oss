/**
 * T-A6 (Phase B B-1) — migration 090 が ai_usage_budget を新設する検証。
 *   line_account_id / usage_date(UTC日) 別に llm/embed/image neuron と reply_count を積算。
 *   UNIQUE(line_account_id, usage_date) で 1 account/日 1 行 (UPSERT 積算の土台)。
 * additive のみ (CREATE TABLE IF NOT EXISTS / CREATE INDEX)。
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

describe('migration 090 — ai_usage_budget (additive / T-A6)', () => {
  test('期待列を持つ', () => {
    const cols = (raw.prepare(`PRAGMA table_info(ai_usage_budget)`).all() as { name: string }[]).map((c) => c.name);
    for (const c of ['id', 'line_account_id', 'usage_date', 'llm_neurons', 'embed_neurons', 'image_neurons', 'reply_count', 'created_at', 'updated_at']) {
      expect(cols).toContain(c);
    }
  });

  test('neuron / reply_count は既定 0', () => {
    raw.prepare(`INSERT INTO ai_usage_budget (id, line_account_id, usage_date) VALUES ('u1','acc-1','2026-07-10')`).run();
    const row = raw.prepare(`SELECT llm_neurons, embed_neurons, image_neurons, reply_count FROM ai_usage_budget WHERE id='u1'`).get() as Record<string, number>;
    expect(row.llm_neurons).toBe(0);
    expect(row.embed_neurons).toBe(0);
    expect(row.image_neurons).toBe(0);
    expect(row.reply_count).toBe(0);
  });

  test('UNIQUE(line_account_id, usage_date) — 同 account/日 の重複 insert は弾かれる', () => {
    raw.prepare(`INSERT INTO ai_usage_budget (id, line_account_id, usage_date) VALUES ('u1','acc-1','2026-07-10')`).run();
    expect(() =>
      raw.prepare(`INSERT INTO ai_usage_budget (id, line_account_id, usage_date) VALUES ('u2','acc-1','2026-07-10')`).run(),
    ).toThrow();
    // 別日は OK
    expect(() =>
      raw.prepare(`INSERT INTO ai_usage_budget (id, line_account_id, usage_date) VALUES ('u3','acc-1','2026-07-11')`).run(),
    ).not.toThrow();
  });

  test('idx_ai_usage_budget_date インデックスが存在', () => {
    const idx = (raw.prepare(`PRAGMA index_list(ai_usage_budget)`).all() as { name: string }[]).map((i) => i.name);
    expect(idx).toContain('idx_ai_usage_budget_date');
  });
});
