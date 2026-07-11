/**
 * T-A2 (F6-1) — migration 094 が formaloo_workspaces を additive で作る検証。
 *   - envelope 暗号化キー管理の台帳: 平文鍵列を持たず、暗号文列 (key/secret の ciphertext+iv) のみ保持。
 *   - kek_version 列 (Codex gap #4): 将来の KEK ローテーションを破壊的 migration なしで足す前方互換。
 *   - is_active 列: enable/disable (soft-delete) — F6-1 の「切替」= 有効化/無効化。
 * D-1 不可侵: 既存 formaloo_forms / formaloo_submissions は無改変で残る。
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

describe('migration 094 — formaloo_workspaces (envelope 暗号化キー管理 / additive)', () => {
  test('テーブルが生成される', () => {
    const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((t) => t.name);
    expect(tables).toContain('formaloo_workspaces');
  });

  test('暗号文列 + メタ列を持つ (id/label/business_slug/暗号文/kek_version/is_active)', () => {
    const cols = tableCols(raw, 'formaloo_workspaces');
    for (const c of ['id', 'label', 'business_slug', 'key_ciphertext', 'key_iv', 'secret_ciphertext', 'secret_iv', 'kek_version', 'is_active', 'created_at', 'updated_at']) {
      expect(cols).toContain(c);
    }
  });

  test('平文鍵列を持たない (D-2: 生 KEY/SECRET を D1 に置かない)', () => {
    const cols = tableCols(raw, 'formaloo_workspaces');
    // 暗号文専用列 (`*_ciphertext`) 以外に鍵らしき平文列が無いこと。
    for (const forbidden of ['api_key', 'api_secret', 'key', 'secret', 'apikey', 'apisecret']) {
      expect(cols).not.toContain(forbidden);
    }
  });

  test('kek_version は default 1 (Codex gap #4 ローテーション前方互換)', () => {
    raw.prepare(
      `INSERT INTO formaloo_workspaces (id, label, key_ciphertext, key_iv, secret_ciphertext, secret_iv)
       VALUES ('ws1','A社','ck','iv1','cs','iv2')`,
    ).run();
    const row = raw.prepare(`SELECT kek_version, is_active FROM formaloo_workspaces WHERE id='ws1'`).get() as { kek_version: number; is_active: number };
    expect(row.kek_version).toBe(1);
    expect(row.is_active).toBe(1);
  });

  test('is_active soft-delete で無効化できる (F6-1 の「切替」= enable/disable)', () => {
    raw.prepare(
      `INSERT INTO formaloo_workspaces (id, label, key_ciphertext, key_iv, secret_ciphertext, secret_iv)
       VALUES ('ws1','A社','ck','iv1','cs','iv2')`,
    ).run();
    raw.prepare(`UPDATE formaloo_workspaces SET is_active=0 WHERE id='ws1'`).run();
    const active = (raw.prepare(`SELECT COUNT(*) c FROM formaloo_workspaces WHERE is_active=1`).get() as { c: number }).c;
    expect(active).toBe(0);
  });

  test('D-1: 既存 formaloo_forms / formaloo_submissions は無改変', () => {
    const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((t) => t.name);
    for (const t of ['formaloo_forms', 'formaloo_submissions', 'formaloo_field_map', 'formaloo_sync_state']) {
      expect(tables).toContain(t);
    }
    const formCols = tableCols(raw, 'formaloo_forms');
    for (const c of ['id', 'formaloo_slug', 'title', 'definition_json', 'builder_status']) {
      expect(formCols).toContain(c);
    }
  });
});
