/**
 * form-media-limits (Batch C / T-C1・T-C2) — allow_post_edit 列の additive 追加 + save→get round-trip。
 *   ③ 編集禁止トグル (弾M あと編集の前提スイッチ)。Formaloo 対応プロパティ不在 (soft-200 実証) ゆえ
 *   harness 側 additive 列に保存のみ・push しない。既定 0 (=編集不可=現状 hosted 挙動と一致)。
 *   T-C1 migration が allow_post_edit を additive 追加 (既定 0)
 *   T-C2 FormalooForm interface + saveFormalooDefinition が present-key 更新で往復
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { createFormalooForm, getFormalooForm, saveFormalooDefinition } from './formaloo.js';

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

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

describe('form-media-limits — allow_post_edit 列 additive (T-C1)', () => {
  test('formaloo_forms に allow_post_edit 列が存在する', () => {
    const cols = raw.prepare("PRAGMA table_info(formaloo_forms)").all() as { name: string }[];
    expect(cols.some((c) => c.name === 'allow_post_edit')).toBe(true);
  });

  test('allow_post_edit 未指定作成は既定 0 (=編集不可=現状挙動)', async () => {
    const form = await createFormalooForm(DB, { title: '既定フォーム' });
    const fetched = await getFormalooForm(DB, form.id);
    expect(fetched?.allow_post_edit).toBe(0);
  });
});

describe('form-media-limits — saveFormalooDefinition.allowPostEdit round-trip (T-C2)', () => {
  test('allowPostEdit=1 を保存すると getFormalooForm で往復する', async () => {
    const form = await createFormalooForm(DB, { title: '編集許可フォーム' });
    await saveFormalooDefinition(DB, form.id, {
      definitionJson: '{"fields":[],"logic":[]}',
      fields: [],
      allowPostEdit: 1,
    });
    const saved = await getFormalooForm(DB, form.id);
    expect(saved?.allow_post_edit).toBe(1);
  });

  test('allowPostEdit 未指定 save は当該フォームの allow_post_edit を変えない (present-key)', async () => {
    const form = await createFormalooForm(DB, { title: '保持フォーム' });
    // 先に 1 に上げる
    await saveFormalooDefinition(DB, form.id, { definitionJson: '{"fields":[],"logic":[]}', fields: [], allowPostEdit: 1 });
    // allowPostEdit 未指定の save (title のみ) は値を変えない
    await saveFormalooDefinition(DB, form.id, { definitionJson: '{"fields":[],"logic":[]}', fields: [], title: '改題' });
    const saved = await getFormalooForm(DB, form.id);
    expect(saved?.allow_post_edit).toBe(1);
    expect(saved?.title).toBe('改題');
  });
});

describe('edit-branch-editability — allow_branch_edit additive migration (D-1)', () => {
  test('formaloo_forms に NOT NULL DEFAULT 0 の allow_branch_edit 列が存在する', () => {
    const cols = raw.prepare("PRAGMA table_info(formaloo_forms)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    expect(cols.find((column) => column.name === 'allow_branch_edit')).toMatchObject({
      notnull: 1,
      dflt_value: '0',
    });
  });

  test('allowBranchEdit=1 を保存すると往復し、未指定 save は値を保持する', async () => {
    const form = await createFormalooForm(DB, { title: '分岐編集フォーム' });
    expect((await getFormalooForm(DB, form.id))?.allow_branch_edit).toBe(0);

    await saveFormalooDefinition(DB, form.id, {
      definitionJson: '{"fields":[],"logic":[]}',
      fields: [],
      allowBranchEdit: 1,
    });
    expect((await getFormalooForm(DB, form.id))?.allow_branch_edit).toBe(1);

    await saveFormalooDefinition(DB, form.id, {
      definitionJson: '{"fields":[],"logic":[]}',
      fields: [],
      title: '改題',
    });
    expect((await getFormalooForm(DB, form.id))?.allow_branch_edit).toBe(1);
  });
});
