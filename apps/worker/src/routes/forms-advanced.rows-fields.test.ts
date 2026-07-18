/**
 * form-response-display-fix (T-A1) — GET /api/forms-advanced/:id/rows が field slug→label リストを返す。
 *   回答データ画面の列ヘッダーが内部 field-slug (9x3BCNZW 等) のまま表示される根因は、/rows レスポンスに
 *   label が含まれず、cockpit が answers キー (slug) をそのまま描画していたこと。
 *   /rows に fields:[{slug,label}] を additive 付与する (formaloo_field_map の formaloo_field_slug × 定義 label の
 *   join・装飾除外・slug 非 null・定義順)。既存 {rows,total,page,pageSize} は不変 (後方互換)。
 *
 * client 未配備 (FORMALOO キー無し) で reconcile を skip (mirror-only) し、fields 付与のみを検証する。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { permissionMiddleware } from '../middleware/permission-middleware.js';
import { formsAdvanced } from './forms-advanced.js';
import { buildFieldLabelList } from '../services/formaloo-row-edit.js';
import type { Env } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
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
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(DB_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(DB_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      try { db.exec(stmt); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

let raw: Database.Database;
let DB: D1Database;

// FORMALOO キー無し → resolveFormalooClient=null → reconcile skip (fields 付与のみを孤立検証)。
function env(): Env['Bindings'] {
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'rc-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
  } as Env['Bindings'];
}

function app() {
  const a = new Hono<Env>();
  a.use('*', authMiddleware);
  a.use('*', permissionMiddleware);
  a.route('/', formsAdvanced);
  return a;
}
function call(method: string, path: string) {
  return app().request(path, { method, headers: { Authorization: 'Bearer rc-owner-key' } }, env());
}

// 定義 (harness id + label + type) を definition_json に載せる。
const DEF_FIELDS = [
  { id: 'f_name', type: 'text', label: 'お名前', required: true, position: 0, config: {} },
  { id: 'f_mail', type: 'email', label: 'メールアドレス', required: false, position: 1, config: {} },
  { id: 'f_note', type: 'textarea', label: 'ご要望', required: false, position: 2, config: {} },
  { id: 'f_sec', type: 'section', label: '区切り(装飾)', required: false, position: 3, config: {} },
];
function seedForm(id: string) {
  raw.prepare(`INSERT INTO formaloo_forms (id, formaloo_slug, title, definition_json, builder_status) VALUES (?,?,?,?,?)`)
    .run(id, `slug_${id}`, 'テスト', JSON.stringify({ fields: DEF_FIELDS, logic: [] }), 'published');
}
function seedFieldMap(id: string, formId: string, slug: string | null, type: string, position: number) {
  raw.prepare(
    `INSERT INTO formaloo_field_map (id, form_id, formaloo_field_slug, field_type, label, position, config_json, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?, '2026-07-18T00:00:00+09:00','2026-07-18T00:00:00+09:00')`,
  ).run(id, formId, slug, type, `map_${id}`, position, '{}');
}
function seedSub(id: string, formId: string, answers: Record<string, unknown>, submittedAt: string) {
  raw.prepare(`INSERT INTO formaloo_submissions (id, form_id, answers_json, submitted_at) VALUES (?,?,?,?)`)
    .run(id, formId, JSON.stringify(answers), submittedAt);
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

describe('T-A1 buildFieldLabelList (純関数 join)', () => {
  test('field_map slug × 定義 label を join・装飾/slug 無しを除外・定義順を保持', () => {
    const fieldMap = [
      { id: 'f_name', formaloo_field_slug: '9x3BCNZW' },
      { id: 'f_mail', formaloo_field_slug: 'N31hP5KP' },
      { id: 'f_note', formaloo_field_slug: null }, // 未 push → slug 無し → 除外
      { id: 'f_sec', formaloo_field_slug: 'iAGKWaBX' }, // 装飾 → 除外
    ];
    const out = buildFieldLabelList(fieldMap, DEF_FIELDS);
    expect(out).toEqual([
      { slug: '9x3BCNZW', label: 'お名前' },
      { slug: 'N31hP5KP', label: 'メールアドレス' },
    ]);
  });

  test('field_map が空なら fields は空 (label 解決不能 = ヘッダーは slug fallback に委ねる)', () => {
    expect(buildFieldLabelList([], DEF_FIELDS)).toEqual([]);
  });
});

describe('T-A1 GET /rows が fields:[{slug,label}] を additive 返す', () => {
  test('/rows レスポンスに join 済 fields が含まれ、既存 {rows,total,page,pageSize} は不変', async () => {
    seedForm('fa1');
    seedFieldMap('f_name', 'fa1', '9x3BCNZW', 'text', 0);
    seedFieldMap('f_mail', 'fa1', 'N31hP5KP', 'email', 1);
    seedFieldMap('f_note', 'fa1', null, 'textarea', 2); // slug 無し → 除外
    seedFieldMap('f_sec', 'fa1', 'iAGKWaBX', 'section', 3); // 装飾 → 除外
    seedSub('r1', 'fa1', { '9x3BCNZW': 'てすと', N31hP5KP: 'a@b.example.com' }, '2026-07-18T08:18:33Z');

    const res = await call('GET', '/api/forms-advanced/fa1/rows');
    expect(res.status).toBe(200);
    const d = (await res.json() as {
      data: { rows: Array<{ id: string }>; total: number; page: number; pageSize: number; fields: Array<{ slug: string; label: string }> };
    }).data;

    // additive fields (定義順・装飾/slug 無し除外)
    expect(d.fields).toEqual([
      { slug: '9x3BCNZW', label: 'お名前' },
      { slug: 'N31hP5KP', label: 'メールアドレス' },
    ]);
    // 既存契約は不変
    expect(d.total).toBe(1);
    expect(d.page).toBe(1);
    expect(d.pageSize).toBeGreaterThan(0);
    expect(d.rows.map((r) => r.id)).toEqual(['r1']);
  });
});
