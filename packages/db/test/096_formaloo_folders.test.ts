/**
 * T-C1 (F6-3) — migration 096 が formaloo_folders (ハーネス側フォルダ分類 / 入れ子可) を新設し、
 *   formaloo_forms に folder_id (NULL=未分類) を additive で足す検証。
 *   - formaloo_folders: id PK / line_account_id NOT NULL (フォルダは必ず account に属す / Codex M#3) /
 *     name NOT NULL / parent_id (NULL=トップレベル / 入れ子) / position / timestamps。
 *   - formaloo_forms.folder_id TEXT (NULL=未分類 / 後方互換)。
 *   - 既存 079-095 の formaloo_forms 行は folder_id NULL 既定で読める (無破壊 / D-1)。
 *   - 一覧絞り込み index 2 本 (folders.line_account_id / forms.folder_id)。
 *   - migration が additive-only (check-migrations 判定 / M-2)。
 *   - schema.sql / bootstrap.sql に列 + テーブル + index を宣言的同期 (drift 検出 / M-1)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { checkMigration } from '../../../scripts/check-migrations.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const BENIGN = /duplicate column name|already exists/i;
const MIGRATION_FILE = '096_formaloo_folders.sql';

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

describe('migration 096 — formaloo_folders + formaloo_forms.folder_id (additive)', () => {
  test('formaloo_folders テーブルが生成される (入れ子 + account スコープ列)', () => {
    const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((t) => t.name);
    expect(tables).toContain('formaloo_folders');
    const cols = tableCols(raw, 'formaloo_folders');
    for (const c of ['id', 'line_account_id', 'name', 'parent_id', 'position', 'created_at', 'updated_at']) {
      expect(cols).toContain(c);
    }
  });

  test('formaloo_folders.line_account_id は NOT NULL (フォルダは必ず account に属す / Codex M#3)', () => {
    const info = raw.prepare(`PRAGMA table_info(formaloo_folders)`).all() as { name: string; notnull: number }[];
    const acc = info.find((c) => c.name === 'line_account_id');
    expect(acc).toBeTruthy();
    expect(acc!.notnull).toBe(1);
    // account 無しの folder は挿入できない (NOT NULL 制約)。
    expect(() =>
      raw.prepare(`INSERT INTO formaloo_folders (id, name) VALUES ('ff_bad', 'account無し')`).run(),
    ).toThrow();
  });

  test('formaloo_folders は入れ子 (parent_id) を持てる + 挿入できる', () => {
    raw.prepare(`INSERT INTO formaloo_folders (id, line_account_id, name) VALUES ('ff_top', 'acc_A', '親')`).run();
    raw.prepare(`INSERT INTO formaloo_folders (id, line_account_id, name, parent_id) VALUES ('ff_child', 'acc_A', '子', 'ff_top')`).run();
    const child = raw.prepare(`SELECT parent_id FROM formaloo_folders WHERE id='ff_child'`).get() as { parent_id: string };
    expect(child.parent_id).toBe('ff_top');
    const top = raw.prepare(`SELECT parent_id FROM formaloo_folders WHERE id='ff_top'`).get() as { parent_id: string | null };
    expect(top.parent_id).toBeNull();
  });

  test('formaloo_forms に folder_id が足される (NULL=未分類)', () => {
    const cols = tableCols(raw, 'formaloo_forms');
    expect(cols).toContain('folder_id');
  });

  test('既存 formaloo_forms 行は folder_id NULL 既定で読める (無破壊 / D-1)', () => {
    // migration 079 相当の最小列だけで INSERT (新列を指定しない = 既存台帳の挙動)。
    raw.prepare(
      `INSERT INTO formaloo_forms (id, title, definition_json) VALUES ('fa_legacy', '既存フォーム', '{"fields":[],"logic":[]}')`,
    ).run();
    const row = raw.prepare(`SELECT folder_id, title FROM formaloo_forms WHERE id='fa_legacy'`).get() as {
      folder_id: string | null;
      title: string;
    };
    expect(row.title).toBe('既存フォーム');
    expect(row.folder_id).toBeNull();
  });

  test('一覧絞り込み index 2 本が存在する (folders.account / forms.folder)', () => {
    const idx = (raw.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as { name: string }[]).map((i) => i.name);
    expect(idx).toContain('idx_formaloo_folders_account');
    expect(idx).toContain('idx_formaloo_forms_folder');
  });

  test('migration 096 が additive-only 判定 (check-migrations / M-2)', () => {
    const sql = readFileSync(join(PKG_ROOT, 'migrations', MIGRATION_FILE), 'utf8');
    const res = checkMigration(sql, MIGRATION_FILE);
    expect(res.ok, res.ok ? '' : `violation: ${res.violation}`).toBe(true);
  });

  test('D-1: 既存 formaloo テーブル群 + F6-2 account_bindings は無改変で残る', () => {
    const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((t) => t.name);
    for (const t of ['formaloo_forms', 'formaloo_submissions', 'formaloo_field_map', 'formaloo_sync_state', 'formaloo_workspaces', 'formaloo_account_bindings']) {
      expect(tables).toContain(t);
    }
  });

  test('schema.sql に folder_id 列 + formaloo_folders + 2 index が宣言される (M-1 同期)', () => {
    const schema = readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8');
    expect(schema).toContain('formaloo_folders');
    expect(schema).toContain('folder_id');
    expect(schema).toContain('idx_formaloo_folders_account');
    expect(schema).toContain('idx_formaloo_forms_folder');
  });

  test('bootstrap.sql に folder_id 列 + formaloo_folders + 2 index が宣言される (M-1 同期 / drift 検出)', () => {
    const bootstrap = readFileSync(join(PKG_ROOT, 'bootstrap.sql'), 'utf8');
    expect(bootstrap).toContain('formaloo_folders');
    // formaloo_forms ブロックに folder_id 列 (events.folder_id と誤検知しないよう formaloo 文脈で確認)。
    expect(bootstrap).toMatch(/CREATE TABLE formaloo_forms[\s\S]*folder_id/);
    expect(bootstrap).toContain('idx_formaloo_folders_account');
    expect(bootstrap).toContain('idx_formaloo_forms_folder');
  });

  test('スキーマに平文鍵列を持たない (D-2: folders は鍵に触れない)', () => {
    const cols = tableCols(raw, 'formaloo_folders');
    for (const forbidden of ['api_key', 'api_secret', 'key', 'secret', 'key_ciphertext']) {
      expect(cols).not.toContain(forbidden);
    }
  });
});
