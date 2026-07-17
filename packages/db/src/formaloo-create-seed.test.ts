/**
 * form-design-presets ② (T-B1 / D-2) — createFormalooForm の create-time design seed。
 *   デザイン未設定の新規フォームが Formaloo 暗色デフォルト (#37352F 同色 = 入力欄不可視) に落ちる罠を、
 *   作成時に既定 design を definition_json へ seed して根絶する (Option A / plan §3)。
 *   後方互換の芯:
 *     - design 省略 / 空 object → definition_json は旧リテラル '{"fields":[],"logic":[]}' と byte 一致。
 *     - packages/db は shared 非依存を維持 (FormDesign を import しない = 構造型で受ける / BLOCKING2)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { createFormalooForm, getFormalooForm } from './formaloo.js';

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

function rawDefinition(id: string): string {
  return (raw.prepare('SELECT definition_json AS d FROM formaloo_forms WHERE id=?').get(id) as { d: string }).d;
}

const OLD_LITERAL = '{"fields":[],"logic":[]}';

// 既定 seed 相当 (defaultFormDesign() の形。DAO は構造型で受けるため shared を import しない)。
const SEED_DESIGN = {
  themeColor: '#06C755', backgroundColor: '#F4FBF7', buttonColor: '#06C755', textColor: '#17352A',
  fieldColor: '#FFFFFF', borderColor: '#B7DCC8', submitTextColor: '#FFFFFF', presetId: 'line-green',
};

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

describe('createFormalooForm — create-time design seed (T-B1)', () => {
  test('design を渡すと definition_json.design に seed され、getFormalooForm で往復する', async () => {
    const form = await createFormalooForm(DB, { title: 'seed フォーム', design: SEED_DESIGN });
    const parsed = JSON.parse(rawDefinition(form.id)) as { fields: unknown[]; logic: unknown[]; design: Record<string, string> };
    expect(parsed.fields).toEqual([]);
    expect(parsed.logic).toEqual([]);
    expect(parsed.design.presetId).toBe('line-green');
    expect(parsed.design.fieldColor).toBe('#FFFFFF');
    expect(parsed.design.textColor).toBe('#17352A');
    // 7 色キー + presetId が全て乗る (Formaloo push 到達の起点)。
    for (const k of ['themeColor', 'backgroundColor', 'buttonColor', 'textColor', 'fieldColor', 'borderColor', 'submitTextColor']) {
      expect(parsed.design[k]).toMatch(/^#[0-9A-F]{6}$/);
    }
    // getFormalooForm 経由でも保持される。
    const fetched = await getFormalooForm(DB, form.id);
    expect(JSON.parse(fetched!.definition_json).design.presetId).toBe('line-green');
  });
});

describe('createFormalooForm — 後方互換 (D-2)', () => {
  test('design 省略 create は旧リテラル "{fields:[],logic:[]}" と byte 一致 (既存 caller 不変)', async () => {
    const form = await createFormalooForm(DB, { title: 'design 無し' });
    expect(rawDefinition(form.id)).toBe(OLD_LITERAL);
  });

  test('design:{} (空 object) を渡しても design key は生えず旧リテラル byte 一致 (既存 null 不可触の DAO 側担保)', async () => {
    const form = await createFormalooForm(DB, { title: '空 design', design: {} });
    expect(rawDefinition(form.id)).toBe(OLD_LITERAL);
  });

  test('packages/db は @line-crm/shared に依存しない (FormDesign を import しない構造型契約 / BLOCKING2)', () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const deps = pkg.dependencies ?? {};
    expect('@line-crm/shared' in deps).toBe(false);
  });
});
