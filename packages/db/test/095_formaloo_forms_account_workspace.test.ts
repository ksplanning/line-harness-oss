/**
 * T-B1 (F6-2) — migration 095 が formaloo_forms に表示スコープ列 (line_account_id / workspace_id) を
 *   additive で足し、作成時の既定 workspace 解決台帳 formaloo_account_bindings を新設する検証。
 *   - line_account_id TEXT (NULL=全アカウント共通表示 / 後方互換) / workspace_id TEXT (NULL=env 鍵 fallback)。
 *   - 既存 079-094 の formaloo_forms 行は両列 NULL 既定で読める (無破壊 / D-1)。
 *   - formaloo_account_bindings (line_account_id PK → default_workspace_id) を軽量新設。
 *   - 一覧絞り込み index を追加。
 *   - schema.sql / bootstrap.sql に 2 列 + index + account_bindings を宣言的同期 (index drift 検出 / M-1)。
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

describe('migration 095 — formaloo_forms 表示スコープ + account_bindings (additive)', () => {
  test('formaloo_forms に line_account_id / workspace_id が足される', () => {
    const cols = tableCols(raw, 'formaloo_forms');
    expect(cols).toContain('line_account_id');
    expect(cols).toContain('workspace_id');
  });

  test('既存 formaloo_forms 行は両列 NULL 既定で読める (無破壊 / D-1)', () => {
    // migration 079 相当の最小列だけで INSERT (新列を指定しない = 既存台帳の挙動)。
    raw.prepare(
      `INSERT INTO formaloo_forms (id, title, definition_json) VALUES ('fa_legacy', '既存フォーム', '{"fields":[],"logic":[]}')`,
    ).run();
    const row = raw.prepare(`SELECT line_account_id, workspace_id, title FROM formaloo_forms WHERE id='fa_legacy'`).get() as {
      line_account_id: string | null;
      workspace_id: string | null;
      title: string;
    };
    expect(row.title).toBe('既存フォーム');
    expect(row.line_account_id).toBeNull();
    expect(row.workspace_id).toBeNull();
  });

  test('formaloo_account_bindings テーブルが line_account_id PK → default_workspace_id で生成される', () => {
    const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((t) => t.name);
    expect(tables).toContain('formaloo_account_bindings');
    const cols = tableCols(raw, 'formaloo_account_bindings');
    for (const c of ['line_account_id', 'default_workspace_id', 'created_at', 'updated_at']) {
      expect(cols).toContain(c);
    }
    // line_account_id が PK (upsert 既定解決の要)。
    const pk = (raw.prepare(`PRAGMA table_info(formaloo_account_bindings)`).all() as { name: string; pk: number }[]).filter((c) => c.pk > 0).map((c) => c.name);
    expect(pk).toEqual(['line_account_id']);
  });

  test('account_binding は default_workspace_id NULL でも投入でき、UPSERT できる', () => {
    raw.prepare(`INSERT INTO formaloo_account_bindings (line_account_id, default_workspace_id) VALUES ('acc_A', 'fw_1')`).run();
    raw.prepare(
      `INSERT INTO formaloo_account_bindings (line_account_id, default_workspace_id) VALUES ('acc_A', 'fw_2')
       ON CONFLICT(line_account_id) DO UPDATE SET default_workspace_id = excluded.default_workspace_id`,
    ).run();
    const row = raw.prepare(`SELECT default_workspace_id FROM formaloo_account_bindings WHERE line_account_id='acc_A'`).get() as { default_workspace_id: string };
    expect(row.default_workspace_id).toBe('fw_2');
  });

  test('一覧絞り込み index idx_formaloo_forms_account が存在する', () => {
    const idx = (raw.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as { name: string }[]).map((i) => i.name);
    expect(idx).toContain('idx_formaloo_forms_account');
  });

  test('D-1: 既存 formaloo テーブル群は無改変で残る', () => {
    const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((t) => t.name);
    for (const t of ['formaloo_forms', 'formaloo_submissions', 'formaloo_field_map', 'formaloo_sync_state', 'formaloo_workspaces']) {
      expect(tables).toContain(t);
    }
  });

  test('schema.sql に 2 列 + index + account_bindings が宣言される (M-1 同期)', () => {
    const schema = readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8');
    expect(schema).toContain('line_account_id');
    expect(schema).toContain('workspace_id');
    expect(schema).toContain('idx_formaloo_forms_account');
    expect(schema).toContain('formaloo_account_bindings');
  });

  test('bootstrap.sql に 2 列 + index + account_bindings が宣言される (M-1 同期 / index drift 検出)', () => {
    const bootstrap = readFileSync(join(PKG_ROOT, 'bootstrap.sql'), 'utf8');
    expect(bootstrap).toContain('line_account_id');
    expect(bootstrap).toContain('workspace_id');
    expect(bootstrap).toContain('idx_formaloo_forms_account');
    expect(bootstrap).toContain('formaloo_account_bindings');
  });

  test('スキーマに平文鍵列を持たない (D-2: account_bindings も暗号文/鍵を保持しない)', () => {
    const cols = tableCols(raw, 'formaloo_account_bindings');
    for (const forbidden of ['api_key', 'api_secret', 'key', 'secret', 'key_ciphertext']) {
      expect(cols).not.toContain(forbidden);
    }
  });
});
