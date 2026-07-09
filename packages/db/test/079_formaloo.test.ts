/**
 * T-A2 (F-1) — migration 079 が Formaloo ミラー基盤 4 テーブルを additive で作る検証。
 *   - formaloo_forms       : harness id ↔ Formaloo slug + 定義キャッシュ + LINE 後処理 (§4 SoT)
 *   - formaloo_submissions : 回答ミラー (PK = Formaloo submission id で冪等 dedup / N-3)
 *   - formaloo_field_map   : field 種別マッピング (MVP subset / N-13)
 *   - formaloo_sync_state  : push/pull 同期状態 (部分 push 失敗バッジ / N-13)
 * D-1 不可侵: 既存 forms / form_submissions / form_opens は無改変。
 * M-4: 期間フィルタは julianday 比較。
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

function tableCols(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

let raw: Database.Database;
beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
});

describe('migration 079 — Formaloo ミラー基盤 (additive)', () => {
  test('4 テーブルが生成される', () => {
    const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((t) => t.name);
    for (const t of ['formaloo_forms', 'formaloo_submissions', 'formaloo_field_map', 'formaloo_sync_state']) {
      expect(tables).toContain(t);
    }
  });

  test('formaloo_forms: 台帳列 (slug/定義キャッシュ/LINE 後処理/tombstone)', () => {
    const cols = tableCols(raw, 'formaloo_forms');
    for (const c of ['id', 'formaloo_slug', 'title', 'description', 'definition_json', 'on_submit_tag_id', 'on_submit_scenario_id', 'submit_count', 'deleted', 'created_at', 'updated_at']) {
      expect(cols).toContain(c);
    }
  });

  test('formaloo_submissions: PK=submission id で冪等 upsert (N-3 dedup)', () => {
    const cols = tableCols(raw, 'formaloo_submissions');
    for (const c of ['id', 'form_id', 'formaloo_slug', 'friend_id', 'answers_json', 'submitted_at', 'synced_at']) {
      expect(cols).toContain(c);
    }
    raw.prepare(`INSERT INTO formaloo_forms (id, title) VALUES ('fa1','テスト')`).run();
    const ins = `INSERT INTO formaloo_submissions (id, form_id, answers_json, submitted_at) VALUES (?,?,?,?)
                 ON CONFLICT(id) DO UPDATE SET answers_json=excluded.answers_json`;
    raw.prepare(ins).run('sub-1', 'fa1', '{"a":1}', '2026-07-10T10:00:00+09:00');
    raw.prepare(ins).run('sub-1', 'fa1', '{"a":2}', '2026-07-10T10:00:00+09:00'); // 再送 = 重複しない
    const n = (raw.prepare(`SELECT COUNT(*) c FROM formaloo_submissions`).get() as { c: number }).c;
    expect(n).toBe(1);
    const row = raw.prepare(`SELECT answers_json FROM formaloo_submissions WHERE id='sub-1'`).get() as { answers_json: string };
    expect(row.answers_json).toBe('{"a":2}');
  });

  test('formaloo_field_map: MVP subset field 種別 + position', () => {
    const cols = tableCols(raw, 'formaloo_field_map');
    for (const c of ['id', 'form_id', 'formaloo_field_slug', 'field_type', 'label', 'position', 'config_json']) {
      expect(cols).toContain(c);
    }
  });

  test('formaloo_sync_state: 同期状態 (部分失敗バッジ)', () => {
    const cols = tableCols(raw, 'formaloo_sync_state');
    for (const c of ['form_id', 'last_pushed_at', 'last_pulled_at', 'sync_status', 'last_error']) {
      expect(cols).toContain(c);
    }
  });

  test('M-4: julianday で submitted_at の期間フィルタが効く', () => {
    raw.prepare(`INSERT INTO formaloo_forms (id, title) VALUES ('fa1','t')`).run();
    const ins = `INSERT INTO formaloo_submissions (id, form_id, answers_json, submitted_at) VALUES (?,?,?,?)`;
    raw.prepare(ins).run('s1', 'fa1', '{}', '2026-07-01T00:00:00+09:00');
    raw.prepare(ins).run('s2', 'fa1', '{}', '2026-07-09T00:00:00+09:00');
    const c = (raw.prepare(
      `SELECT COUNT(*) c FROM formaloo_submissions WHERE julianday(submitted_at) >= julianday('2026-07-05T00:00:00+09:00')`,
    ).get() as { c: number }).c;
    expect(c).toBe(1);
  });

  test('D-1: 既存 forms / form_submissions / form_opens は無改変', () => {
    const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((t) => t.name);
    for (const t of ['forms', 'form_submissions', 'form_opens']) {
      expect(tables).toContain(t);
    }
    // native forms の主要列が残っている
    const formCols = tableCols(raw, 'forms');
    for (const c of ['id', 'name', 'fields', 'on_submit_tag_id', 'on_submit_scenario_id', 'submit_count']) {
      expect(formCols).toContain(c);
    }
  });
});
