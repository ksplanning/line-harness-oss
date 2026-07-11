/**
 * F-2 — /api/forms-advanced 統合 (real SQLite)。
 *   - T-B1 backend: create/list/get/save(定義 validate)
 *   - T-B2: 定義保存が field を MVP subset で検証 (matrix は 400) / 保存後 out_of_sync (dev=credential 未設定)
 *   - T-B3: publish gate 状態機械 (draft→publish 直行 409 / submit-for-review→publish OK / draft は embed 409 = N-7)
 *   - landmine#4: 権限なし staff (forms_advanced 無し custom role) は mutating route に 403 (specific-route gate)
 *   - D-1: native forms (/api/forms) は無改変 (本 test は forms-advanced のみ触る)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { jstNow, createRole, setRolePermissions } from '@line-crm/db';
import { authMiddleware } from '../middleware/auth.js';
import { permissionMiddleware } from '../middleware/permission-middleware.js';
import { formsAdvanced } from './forms-advanced.js';
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

function env(): Env['Bindings'] {
  // FORMALOO_API_KEY/SECRET 未設定 = dev。push は fail-soft (out_of_sync)。
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'env-owner-key',
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

const OWNER = 'Bearer env-owner-key';
function call(method: string, path: string, body?: unknown, auth = OWNER) {
  return app().request(path, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env());
}
/** env override 版 (FORMALOO_* を注入して client 配備をシミュレート)。 */
function callEnv(method: string, path: string, envOverride: Partial<Env['Bindings']>, body?: unknown, auth = OWNER) {
  return app().request(path, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, { ...env(), ...envOverride });
}
function seedStaff(id: string, role: string, apiKey: string, roleId: string | null = null) {
  const now = jstNow();
  raw.prepare(
    `INSERT INTO staff_members (id, name, email, role, api_key, is_active, created_at, updated_at, role_id)
     VALUES (?,?,?,?,?,1,?,?,?)`,
  ).run(id, id, null, role, apiKey, now, now, roleId);
}
async function createForm(title = 'テストフォーム'): Promise<string> {
  const res = await call('POST', '/api/forms-advanced', { title });
  return (await res.json() as { data: { id: string } }).data.id;
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

describe('forms-advanced CRUD (T-B1 backend)', () => {
  test('POST 作成 → draft / publicUrl は null (N-7)', async () => {
    const res = await call('POST', '/api/forms-advanced', { title: '問い合わせ' });
    expect(res.status).toBe(201);
    const d = (await res.json() as { data: { id: string; builderStatus: string; publicUrl: string | null; title: string } }).data;
    expect(d.builderStatus).toBe('draft');
    expect(d.publicUrl).toBeNull();
    expect(d.title).toBe('問い合わせ');
  });

  test('POST 名前空は 400', async () => {
    expect((await call('POST', '/api/forms-advanced', { title: '  ' })).status).toBe(400);
  });

  test('GET 一覧 / GET 詳細', async () => {
    const id = await createForm();
    const list = await call('GET', '/api/forms-advanced');
    expect((await list.json() as { data: unknown[] }).data.length).toBe(1);
    const detail = await call('GET', `/api/forms-advanced/${id}`);
    expect(detail.status).toBe(200);
    const d = (await detail.json() as { data: { fields: unknown[]; logic: unknown[] } }).data;
    expect(d.fields).toEqual([]);
    expect(d.logic).toEqual([]);
  });

  test('DELETE 論理削除 → 一覧から消える', async () => {
    const id = await createForm();
    expect((await call('DELETE', `/api/forms-advanced/${id}`)).status).toBe(200);
    const list = await call('GET', '/api/forms-advanced');
    expect((await list.json() as { data: unknown[] }).data.length).toBe(0);
  });
});

describe('forms-advanced 定義保存 (T-B2)', () => {
  test('有効な field を保存 → fields 反映 / dev では out_of_sync (fail-soft)', async () => {
    const id = await createForm();
    const res = await call('PUT', `/api/forms-advanced/${id}`, {
      fields: [
        { id: 'h1', type: 'text', label: '名前', required: true, config: { maxLength: 30 } },
        { id: 'h2', type: 'choice', label: '性別', required: true, config: { choices: ['男', '女'] } },
      ],
      logic: [{ id: 'r1', sourceFieldId: 'h2', operator: 'equals', value: '男', action: 'show', targetFieldId: 'h1' }],
    });
    expect(res.status).toBe(200);
    const d = (await res.json() as { data: { fields: Array<{ id: string; type: string }>; logic: unknown[]; syncStatus: string } }).data;
    expect(d.fields.map((f) => f.id)).toEqual(['h1', 'h2']);
    expect(d.fields[0].type).toBe('text');
    expect(d.logic.length).toBe(1);
    expect(d.syncStatus).toBe('out_of_sync'); // FORMALOO credential 未設定 dev
  });

  test('MVP subset 外の field 種別 (matrix) は 400 (N-13)', async () => {
    const id = await createForm();
    const res = await call('PUT', `/api/forms-advanced/${id}`, {
      fields: [{ id: 'h1', type: 'matrix', label: 'x', required: false, config: {} }],
    });
    expect(res.status).toBe(400);
  });

  test('孤立 logic (存在しない field 参照) は捨てられる (N-11)', async () => {
    const id = await createForm();
    const res = await call('PUT', `/api/forms-advanced/${id}`, {
      fields: [{ id: 'h1', type: 'text', label: '名前', required: false, config: {} }],
      logic: [{ id: 'r1', sourceFieldId: 'h1', operator: 'equals', value: 'x', action: 'show', targetFieldId: 'GHOST' }],
    });
    const d = (await res.json() as { data: { logic: unknown[] } }).data;
    expect(d.logic.length).toBe(0); // GHOST 参照ゆえ捨てる
  });
});

describe('forms-advanced publish gate (T-B3 / N-7)', () => {
  test('draft から publish 直行は 409 (レビュー必須)', async () => {
    const id = await createForm();
    const res = await call('POST', `/api/forms-advanced/${id}/publish`);
    expect(res.status).toBe(409);
  });

  test('draft は embed 発行不可 409 (誤配信防止 N-7)', async () => {
    const id = await createForm();
    expect((await call('GET', `/api/forms-advanced/${id}/embed`)).status).toBe(409);
  });

  test('submit-for-review → in_review → publish → published', async () => {
    const id = await createForm();
    const r1 = await call('POST', `/api/forms-advanced/${id}/submit-for-review`);
    expect(r1.status).toBe(200);
    expect((await r1.json() as { data: { builderStatus: string } }).data.builderStatus).toBe('in_review');
    const r2 = await call('POST', `/api/forms-advanced/${id}/publish`);
    expect(r2.status).toBe(200);
    const d = (await r2.json() as { data: { builderStatus: string; publishedAt: string | null } }).data;
    expect(d.builderStatus).toBe('published');
    expect(d.publishedAt).not.toBeNull();
  });

  test('published + Formaloo address 確定 → embed/publicUrl 発行 (published のみ有効)', async () => {
    const id = await createForm();
    // push 成功をシミュレート: definition_json に formalooAddress を注入
    raw.prepare(`UPDATE formaloo_forms SET definition_json=? WHERE id=?`).run(
      JSON.stringify({ fields: [], logic: [], formalooAddress: 'https://forms.formaloo.net/abc' }), id,
    );
    await call('POST', `/api/forms-advanced/${id}/submit-for-review`);
    await call('POST', `/api/forms-advanced/${id}/publish`);
    const embed = await call('GET', `/api/forms-advanced/${id}/embed`);
    expect(embed.status).toBe(200);
    const d = (await embed.json() as { data: { embedCode: string; publicUrl: string } }).data;
    expect(d.embedCode).toContain('<iframe');
    expect(d.publicUrl).toBe('https://forms.formaloo.net/abc');
  });

  test('unpublish (published→draft) で URL 即無効化', async () => {
    const id = await createForm();
    raw.prepare(`UPDATE formaloo_forms SET definition_json=? WHERE id=?`).run(
      JSON.stringify({ fields: [], logic: [], formalooAddress: 'https://forms.formaloo.net/abc' }), id,
    );
    await call('POST', `/api/forms-advanced/${id}/submit-for-review`);
    await call('POST', `/api/forms-advanced/${id}/publish`);
    const un = await call('POST', `/api/forms-advanced/${id}/unpublish`);
    expect(un.status).toBe(200);
    const d = (await un.json() as { data: { builderStatus: string; publicUrl: string | null } }).data;
    expect(d.builderStatus).toBe('draft');
    expect(d.publicUrl).toBeNull(); // 公開 URL 即無効
  });
});

describe('forms-advanced pull 再取り込み (GET /:id/pull / N-8)', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('happy-path: auth+form-detail stub → ok:true + resolver 反映 + D1 非書込み (B4)', async () => {
    const id = await createForm();
    const slug = 'formaloo_pull_happy';
    // formaloo_slug + field_map seed。formaloo_field_map.id は global UNIQUE → 毎回ユニーク field id。
    raw.prepare(`UPDATE formaloo_forms SET formaloo_slug=? WHERE id=?`).run(slug, id);
    const now = jstNow();
    const nameFieldId = `fmuniq_${id}_name`;
    raw.prepare(
      `INSERT INTO formaloo_field_map (id, form_id, formaloo_field_slug, field_type, label, position, config_json, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(nameFieldId, id, 's_name', 'short_text', '名前', 0, '{}', now, now);

    const formDetail = {
      data: {
        form: {
          slug,
          fields_list: [
            { slug: 's_name', type: 'short_text', title: '名前', required: true, position: 0, max_length: 30 },
            { slug: 's_color', type: 'choice', title: '色', required: false, position: 1,
              choice_items: [{ title: '青', position: 1, slug: 'ci2' }, { title: '赤', position: 0, slug: 'ci1' }] },
          ],
          logic: { rules: [
            { conditions: [{ field: 's_color', operator: 'equals', value: '赤' }], actions: [{ type: 'show', field: 's_name' }] },
          ] },
        },
      },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: { method?: string }) => {
      const url = String(input);
      if (url.includes('/oauth2/authorization-token/')) {
        return new Response(JSON.stringify({ authorization_token: 'jwt-test' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if ((init?.method ?? 'GET') === 'GET' && url.includes(`/v3.0/forms/${slug}/`)) {
        return new Response(JSON.stringify(formDetail), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    }));

    // D1 スナップショット (非書込み検証 / B4)
    const beforeCount = (raw.prepare(`SELECT COUNT(*) AS n FROM formaloo_field_map`).get() as { n: number }).n;
    const beforeDef = (raw.prepare(`SELECT definition_json AS d FROM formaloo_forms WHERE id=?`).get(id) as { d: string }).d;

    const res = await callEnv('GET', `/api/forms-advanced/${id}/pull`, { FORMALOO_API_KEY: 'k', FORMALOO_API_SECRET: 's' });
    expect(res.status).toBe(200);
    const d = (await res.json() as {
      data: { ok: boolean; fields: Array<{ id: string; type: string; config: { choices?: string[] } }>; logic: Array<{ sourceFieldId: string; targetFieldId: string }>; note: string };
    }).data;
    expect(d.ok).toBe(true);
    // 既知 slug は field_map の id に resolve / 未知 slug は fallback で slug 自身
    expect(d.fields.map((f) => f.id)).toEqual([nameFieldId, 's_color']);
    expect(d.fields[1].config.choices).toEqual(['赤', '青']); // choice zero-loss (position 昇順)
    expect(d.logic).toHaveLength(1);
    expect(d.logic[0].sourceFieldId).toBe('s_color');
    expect(d.logic[0].targetFieldId).toBe(nameFieldId);
    expect(d.note).toContain('重複');

    // D1 非書込み (B4): 行数・definition_json 不変
    const afterCount = (raw.prepare(`SELECT COUNT(*) AS n FROM formaloo_field_map`).get() as { n: number }).n;
    const afterDef = (raw.prepare(`SELECT definition_json AS d FROM formaloo_forms WHERE id=?`).get(id) as { d: string }).d;
    expect(afterCount).toBe(beforeCount);
    expect(afterDef).toBe(beforeDef);
  });

  test('client 未配備 (FORMALOO_* 無) → ok:false + note + 200 (500 にしない)', async () => {
    const id = await createForm();
    raw.prepare(`UPDATE formaloo_forms SET formaloo_slug=? WHERE id=?`).run('some_slug', id);
    const res = await call('GET', `/api/forms-advanced/${id}/pull`);
    expect(res.status).toBe(200);
    const d = (await res.json() as { data: { ok: boolean; note: string } }).data;
    expect(d.ok).toBe(false);
    expect(d.note).toContain('未接続');
  });

  test('formaloo_slug 無 (未同期) → ok:false + note + 200', async () => {
    const id = await createForm();
    const res = await callEnv('GET', `/api/forms-advanced/${id}/pull`, { FORMALOO_API_KEY: 'k', FORMALOO_API_SECRET: 's' });
    expect(res.status).toBe(200);
    const d = (await res.json() as { data: { ok: boolean; note: string } }).data;
    expect(d.ok).toBe(false);
    expect(d.note).toContain('未同期');
  });

  test('未知 form → 404', async () => {
    const res = await callEnv('GET', `/api/forms-advanced/NOPE/pull`, { FORMALOO_API_KEY: 'k', FORMALOO_API_SECRET: 's' });
    expect(res.status).toBe(404);
  });

  test('forms_advanced 権限なし staff → 403', async () => {
    const id = await createForm();
    const role = await createRole(DB, { name: 'チャットのみ' });
    await setRolePermissions(DB, role.id, [{ feature_key: 'forms_advanced', allowed: false }]);
    seedStaff('s_pull', 'staff', 'lh_pullkey', role.id);
    const res = await call('GET', `/api/forms-advanced/${id}/pull`, undefined, 'Bearer lh_pullkey');
    expect(res.status).toBe(403);
  });
});

describe('forms-advanced 権限 gate (landmine#4)', () => {
  test('forms_advanced 権限なし custom role の staff は mutating route に 403', async () => {
    const id = await createForm(); // owner が作成
    const role = await createRole(DB, { name: 'チャットのみ' });
    await setRolePermissions(DB, role.id, [
      { feature_key: 'chat', allowed: true },
      { feature_key: 'forms_advanced', allowed: false },
    ]);
    seedStaff('s1', 'staff', 'lh_staffkey', role.id);
    // mutating (publish) に 403
    const pub = await call('POST', `/api/forms-advanced/${id}/publish`, undefined, 'Bearer lh_staffkey');
    expect(pub.status).toBe(403);
    // 保存 (PUT) にも 403
    const put = await call('PUT', `/api/forms-advanced/${id}`, { fields: [] }, 'Bearer lh_staffkey');
    expect(put.status).toBe(403);
    // GET 一覧にも 403 (feature 丸ごと gate)
    expect((await call('GET', '/api/forms-advanced', undefined, 'Bearer lh_staffkey')).status).toBe(403);
  });

  test('forms_advanced 権限あり custom role の staff は通る (403 でない)', async () => {
    await createForm();
    const role = await createRole(DB, { name: 'フォーム担当' });
    await setRolePermissions(DB, role.id, [{ feature_key: 'forms_advanced', allowed: true }]);
    seedStaff('s2', 'staff', 'lh_formkey', role.id);
    const res = await call('GET', '/api/forms-advanced', undefined, 'Bearer lh_formkey');
    expect(res.status).toBe(200);
  });
});
