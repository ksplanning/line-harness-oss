/**
 * T-B2 / T-B4 (F6-2) — 表示スコープ read 経路の db 層検証。
 *   - listFormalooForms(db, lineAccountId) が (line_account_id=? OR line_account_id IS NULL) で絞る
 *     (指定アカウント form + 共通 NULL のみ / 別アカウント form 除外 / broadcasts:152 と同型)。
 *   - listFormalooForms(db) (無引数) は従来通り全件 (後方互換 / D-1)。
 *   - createFormalooForm が lineAccountId/workspaceId を記録できる (C3 write 経路の db 基盤)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { listFormalooForms } from './formaloo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const BENIGN = /duplicate column name|already exists/i;

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const s = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (s.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: s.all(...(params as never[])) as T[] }; },
        async run() { const info = s.run(...(params as never[])); return { meta: { changes: info.changes } }; },
      };
      return api;
    },
  } as unknown as D1Database;
}

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(PKG_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(PKG_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      try { db.exec(stmt); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

let raw: Database.Database;
let DB: D1Database;

/** 表示スコープ列を直接指定して form を seed (createFormalooForm 経由でない低レベル seed)。 */
function seedForm(id: string, title: string, lineAccountId: string | null, workspaceId: string | null, deleted = 0) {
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, definition_json, line_account_id, workspace_id, deleted)
     VALUES (?,?,'{"fields":[],"logic":[]}',?,?,?)`,
  ).run(id, title, lineAccountId, workspaceId, deleted);
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

describe('listFormalooForms — 表示スコープ絞り込み (T-B2)', () => {
  test('lineAccountId 指定で (line_account_id=? OR IS NULL) に絞る (別アカウント除外)', async () => {
    seedForm('fa_A', 'A社フォーム', 'acc_A', 'fw_shared');
    seedForm('fa_B', 'B社フォーム', 'acc_B', 'fw_shared');
    seedForm('fa_common', '共通フォーム', null, null);

    const forA = await listFormalooForms(DB, 'acc_A');
    const idsA = forA.map((f) => f.id);
    expect(idsA).toContain('fa_A');
    expect(idsA).toContain('fa_common'); // NULL 共通は全アカウントで表示
    expect(idsA).not.toContain('fa_B'); // 別アカウント form は出ない
  });

  test('無引数は従来通り全件 (deleted=0 のみ / 後方互換 D-1)', async () => {
    seedForm('fa_A', 'A社', 'acc_A', null);
    seedForm('fa_B', 'B社', 'acc_B', null);
    seedForm('fa_del', '削除済', 'acc_A', null, 1);

    const all = await listFormalooForms(DB);
    const ids = all.map((f) => f.id);
    expect(ids).toContain('fa_A');
    expect(ids).toContain('fa_B');
    expect(ids).not.toContain('fa_del'); // deleted は従来通り除外
  });

  test('undefined を明示しても従来 SQL (後方互換)', async () => {
    seedForm('fa_A', 'A社', 'acc_A', null);
    seedForm('fa_B', 'B社', 'acc_B', null);
    const all = await listFormalooForms(DB, undefined);
    expect(all.map((f) => f.id).sort()).toEqual(['fa_A', 'fa_B']);
  });
});
