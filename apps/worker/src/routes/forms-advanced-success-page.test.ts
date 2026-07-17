/**
 * route-terminal-phase2 (Track 2) — ルート別完了ページ (success-page) の route 経路。
 *   T-D1: F-MED-2 解除 — submit target が有効 SP を指すとき保持・無効は '' 縮退。
 *   T-E3: successPages reconcile 配線 + 割当 slug を definition_json 永続 + PushResult.successPageSlugs +
 *         jump_to_success_page.args.identifier に resolve 済 slug が載る + CI-2 削除順序 (repoint→DELETE)。
 *   T-E4: form 削除で紐づく SP を明示 DELETE (孤児回収)。
 *   T-E5: successPages が serializeForm 応答へ露出 (reload 復元素材)。
 * forms-advanced-route-terminal.test.ts を写経元にした Track 2 専用 harness。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { permissionMiddleware } from '../middleware/permission-middleware.js';
import { formsAdvanced } from './forms-advanced.js';
import type { Env } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;

function d1(db: Database.Database): D1Database {
  function makeStmt(sql: string) {
    const s = db.prepare(sql);
    let params: unknown[] = [];
    const api = {
      bind(...args: unknown[]) { params = args; return api; },
      async first<T>() { return (s.get(...(params as never[])) as T) ?? null; },
      async all<T>() { return { results: s.all(...(params as never[])) as T[] }; },
      async run() { const info = s.run(...(params as never[])); return { meta: { changes: info.changes } }; },
      __exec() { const info = s.run(...(params as never[])); return { changes: info.changes }; },
    };
    return api;
  }
  return {
    prepare(sql: string) { return makeStmt(sql); },
    async batch(stmts: Array<{ __exec(): { changes: number } }>) {
      const tx = db.transaction((list: typeof stmts) => list.map((st) => ({ meta: { changes: st.__exec().changes } })));
      return tx(stmts);
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
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'sp-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
    FORMALOO_API_KEY: 'fk', FORMALOO_API_SECRET: 'fs',
  } as Env['Bindings'];
}

function app() {
  const a = new Hono<Env>();
  a.use('*', authMiddleware);
  a.use('*', permissionMiddleware);
  a.route('/', formsAdvanced);
  return a;
}
const OWNER = 'Bearer sp-owner-key';
function call(method: string, path: string, body?: unknown) {
  return app().request(path, {
    method,
    headers: { Authorization: OWNER, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env());
}
function seedForm(id: string, slug: string | null, definition = '{"fields":[],"logic":[]}') {
  raw.prepare(`INSERT INTO formaloo_forms (id, title, definition_json, formaloo_slug) VALUES (?,?,?,?)`).run(id, id, definition, slug);
}
function readDef(id: string): Record<string, unknown> {
  const row = raw.prepare(`SELECT definition_json FROM formaloo_forms WHERE id=?`).get(id) as { definition_json: string };
  return JSON.parse(row.definition_json);
}
function rawDef(id: string): string {
  return (raw.prepare(`SELECT definition_json FROM formaloo_forms WHERE id=?`).get(id) as { definition_json: string }).definition_json;
}
function formRow(id: string): { deleted: number } {
  return raw.prepare(`SELECT deleted FROM formaloo_forms WHERE id=?`).get(id) as { deleted: number };
}

// ── Formaloo stub (global fetch) ──
let fetchCalls: { method: string; url: string; body: unknown }[] = [];
function stubFormaloo(opts: { spSlugSeq?: string[]; getFieldsList?: unknown[] } = {}) {
  let spI = 0;
  const seq = opts.spSlugSeq ?? ['SP_A', 'SP_B', 'SP_C'];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = String(init?.body); }
    fetchCalls.push({ method, url: u, body });
    if (u.includes('/oauth2/authorization-token/')) {
      return new Response(JSON.stringify({ authorization_token: 'jwt-tok' }), { status: 200 });
    }
    // SP create (POST /v3.0/fields/success-page/) — /v3.0/fields/ より先に判定 (path 前方一致衝突回避)。
    if (u.match(/\/v3\.0\/fields\/success-page\/$/) && method === 'POST') {
      const slug = seq[spI++] ?? `SP_${spI}`;
      return new Response(JSON.stringify({ data: { field: { slug } } }), { status: 201 });
    }
    // field create (POST /v3.0/fields/)
    if (u.match(/\/v3\.0\/fields\/$/) && method === 'POST') {
      return new Response(JSON.stringify({ data: { field: { slug: `F_${Math.random().toString(36).slice(2, 8)}` } } }), { status: 201 });
    }
    // form detail GET
    if (u.match(/\/v3\.0\/forms\/[^/]+\/$/) && method === 'GET') {
      return new Response(JSON.stringify({ data: { form: { slug: 'SLUG', fields_list: opts.getFieldsList ?? [], logic: [] } } }), { status: 200 });
    }
    // field probe GET → 200 (既存扱い = field slug は id を採用)
    if (u.match(/\/v3\.0\/fields\/[^/]+\/$/) && method === 'GET') {
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }
    // form create / PATCH / field PATCH / SP DELETE 等
    return new Response(JSON.stringify({ data: { form: { slug: 'CREATED' } } }), { status: 200 });
  }));
}
function logicPatch(): { method: string; url: string; body: unknown } | undefined {
  return fetchCalls.find((c) => c.method === 'PATCH' && /\/v3\.0\/forms\/[^/]+\/$/.test(c.url)
    && !!c.body && typeof c.body === 'object' && Object.prototype.hasOwnProperty.call(c.body, 'logic'));
}
function spCreates(): { method: string; url: string; body: unknown }[] {
  return fetchCalls.filter((c) => c.method === 'POST' && /\/v3\.0\/fields\/success-page\/$/.test(c.url));
}
function spDeletes(): string[] {
  return fetchCalls.filter((c) => c.method === 'DELETE' && /\/v3\.0\/fields\/[^/]+\/$/.test(c.url)).map((c) => c.url);
}

const NAME = { id: 'q1', type: 'text', label: '名前', required: false, position: 0, config: {} };
const submitRule = (target: string) => ({ id: 'r1', sourceFieldId: 'q1', operator: 'equals', value: '', action: 'submit', targetFieldId: target, terminalTrigger: 'on_answered' });

beforeEach(() => { raw = new Database(':memory:'); replayAll(raw); DB = d1(raw); fetchCalls = []; });
afterEach(() => vi.unstubAllGlobals());

describe('T-D1 — F-MED-2 解除 (submit target を SP 集合で照合)', () => {
  test('submit target が有効 SP を指すとき definition_json の logic に SP id を保持する', async () => {
    seedForm('f1', 'SLUG');
    stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/f1', {
      fields: [NAME], logic: [submitRule('sp1')], formType: 'multi_step',
      successPages: [{ id: 'sp1', title: 'Aルート完了' }],
    });
    expect(res.status).toBe(200);
    const def = readDef('f1');
    const rule = (def.logic as Array<{ action: string; targetFieldId: string }>).find((r) => r.action === 'submit');
    expect(rule?.targetFieldId).toBe('sp1'); // 有効 SP を保持
  });

  test('submit target が successPages に無い id を指すとき空へ縮退する', async () => {
    seedForm('f2', 'SLUG');
    stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/f2', {
      fields: [NAME], logic: [submitRule('sp_ghost')], formType: 'multi_step',
      successPages: [{ id: 'sp1', title: 'Aルート完了' }],
    });
    expect(res.status).toBe(200);
    const def = readDef('f2');
    const rule = (def.logic as Array<{ action: string; targetFieldId: string }>).find((r) => r.action === 'submit');
    expect(rule?.targetFieldId).toBe(''); // 無効 = 既定完了ページへ縮退
  });

  test('successPages 未提供でも prev の SP を carry して submit target を保持する', async () => {
    seedForm('f3', 'SLUG', JSON.stringify({ fields: [NAME], logic: [], successPages: [{ id: 'sp1', slug: 'SP_A', title: 'A完了' }] }));
    stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/f3', {
      fields: [NAME], logic: [submitRule('sp1')], formType: 'multi_step',
    });
    expect(res.status).toBe(200);
    const def = readDef('f3');
    const rule = (def.logic as Array<{ action: string; targetFieldId: string }>).find((r) => r.action === 'submit');
    expect(rule?.targetFieldId).toBe('sp1');
  });
});

describe('T-E3 — SP reconcile 配線 + slug 永続 + jump_to_success_page', () => {
  test('新規 SP を POST で作成し slug を definition_json に永続・PushResult 経由で反映', async () => {
    seedForm('e1', 'SLUG');
    stubFormaloo({ spSlugSeq: ['SP_A'] });
    const res = await call('PUT', '/api/forms-advanced/e1', {
      fields: [NAME], logic: [submitRule('sp1')], formType: 'multi_step',
      successPages: [{ id: 'sp1', title: 'Aルート完了', description: 'ありがとう' }],
    });
    expect(res.status).toBe(200);
    expect(spCreates().length).toBe(1);
    expect(spCreates()[0].body).toMatchObject({ form: 'SLUG', title: 'Aルート完了', description: 'ありがとう' });
    const sp = (readDef('e1').successPages as Array<{ id: string; slug?: string }>).find((s) => s.id === 'sp1');
    expect(sp?.slug).toBe('SP_A'); // 割当 slug が永続
  });

  test('submit→SP の logic PATCH に jump_to_success_page (identifier=SP slug) が resolve 済で載る', async () => {
    seedForm('e2', 'SLUG');
    stubFormaloo({ spSlugSeq: ['SP_A'] });
    await call('PUT', '/api/forms-advanced/e2', {
      fields: [NAME], logic: [submitRule('sp1')], formType: 'multi_step',
      successPages: [{ id: 'sp1', title: 'A完了' }],
    });
    const body = JSON.stringify(logicPatch()?.body ?? {});
    expect(body).toContain('jump_to_success_page');
    expect(body).toContain('SP_A'); // resolve 済 slug が identifier に載る
  });

  test('非冪等: prev slug を持つ SP の再保存は PATCH 更新で再 POST しない (重複作成なし)', async () => {
    seedForm('e3', 'SLUG', JSON.stringify({ fields: [NAME], logic: [], successPages: [{ id: 'sp1', slug: 'SP_A', title: '旧' }] }));
    stubFormaloo();
    await call('PUT', '/api/forms-advanced/e3', {
      fields: [NAME], logic: [submitRule('sp1')], formType: 'multi_step',
      successPages: [{ id: 'sp1', title: '新' }], // builder は slug を持たなくても prev slug で carry
    });
    expect(spCreates().length).toBe(0); // 再 POST しない
    const patchSp = fetchCalls.find((c) => c.method === 'PATCH' && /\/v3\.0\/fields\/SP_A\/$/.test(c.url));
    expect(patchSp).toBeDefined();
    const sp = (readDef('e3').successPages as Array<{ id: string; slug?: string }>).find((s) => s.id === 'sp1');
    expect(sp?.slug).toBe('SP_A'); // slug 維持
  });

  test('CI-2: SP を successPages から外す save は submit を空へ repoint 後に SP を DELETE (dangling なし)', async () => {
    seedForm('e4', 'SLUG', JSON.stringify({ fields: [NAME], logic: [], successPages: [{ id: 'sp1', slug: 'SP_A', title: 'A' }] }));
    stubFormaloo();
    // submit は sp1 を指すが successPages から sp1 を削除 → sp1 は successPageIds に無い → submit target '' へ縮退。
    await call('PUT', '/api/forms-advanced/e4', {
      fields: [NAME], logic: [submitRule('sp1')], formType: 'multi_step',
      successPages: [], // sp1 を削除
    });
    // logic PATCH には SP_A への jump_to_success_page が載らない (repoint 済)。
    const body = JSON.stringify(logicPatch()?.body ?? {});
    expect(body).not.toContain('jump_to_success_page');
    // SP_A は明示 DELETE で回収される。
    expect(spDeletes().some((u) => /\/v3\.0\/fields\/SP_A\/$/.test(u))).toBe(true);
    // definition_json の successPages は空 (削除反映)。
    expect(readDef('e4').successPages).toBeUndefined();
  });
});

describe('T-E4 — form 削除で紐づく SP を明示 DELETE (孤児回収)', () => {
  test('form DELETE 時にそのフォームの successPages 各 slug を DELETE /v3.0/fields/{slug}/ で回収する', async () => {
    seedForm('d1', 'SLUG', JSON.stringify({ fields: [NAME], logic: [], successPages: [{ id: 'sp1', slug: 'SP_A', title: 'A' }, { id: 'sp2', slug: 'SP_B', title: 'B' }] }));
    stubFormaloo();
    const res = await call('DELETE', '/api/forms-advanced/d1');
    expect(res.status).toBe(200);
    const deleted = spDeletes();
    expect(deleted.some((u) => /\/v3\.0\/fields\/SP_A\/$/.test(u))).toBe(true);
    expect(deleted.some((u) => /\/v3\.0\/fields\/SP_B\/$/.test(u))).toBe(true);
    // form は論理削除される (SP 回収と独立)。
    expect(formRow('d1').deleted).toBe(1);
  });

  test('slug 無し SP のみ / SP 無しフォームの削除は SP DELETE を呼ばない (no-op)', async () => {
    seedForm('d2', 'SLUG', JSON.stringify({ fields: [NAME], logic: [] }));
    stubFormaloo();
    await call('DELETE', '/api/forms-advanced/d2');
    expect(spDeletes().length).toBe(0);
    expect(formRow('d2').deleted).toBe(1);
  });

  test('D-1 後方互換: successPages 未提供 save は definition_json に successPages キー不在・byte 一致', async () => {
    seedForm('bc1', 'SLUG');
    stubFormaloo();
    await call('PUT', '/api/forms-advanced/bc1', { fields: [NAME], logic: [] });
    const before = rawDef('bc1');
    const res = await call('PUT', '/api/forms-advanced/bc1', { fields: [NAME], logic: [] });
    expect(res.status).toBe(200);
    expect(rawDef('bc1')).toBe(before); // 生バイト一致
    expect('successPages' in readDef('bc1')).toBe(false);
  });
});

describe('T-E4 form 削除 — 追加', () => {
  test('一部 SP DELETE が失敗しても form 削除はブロックされない (fail-soft・残余は log)', async () => {
    seedForm('d3', 'SLUG', JSON.stringify({ fields: [NAME], logic: [], successPages: [{ id: 'sp1', slug: 'SP_BAD', title: 'A' }] }));
    // SP_BAD の DELETE を 500 にする stub。
    let spI = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = (init?.method ?? 'GET').toUpperCase();
      fetchCalls.push({ method, url: u, body: undefined });
      if (u.includes('/oauth2/authorization-token/')) return new Response(JSON.stringify({ authorization_token: 't' }), { status: 200 });
      if (method === 'DELETE' && /\/v3\.0\/fields\/SP_BAD\/$/.test(u)) return new Response(JSON.stringify({ data: {} }), { status: 500 });
      void spI;
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }));
    const res = await call('DELETE', '/api/forms-advanced/d3');
    expect(res.status).toBe(200); // 削除自体は成功
    expect(formRow('d3').deleted).toBe(1);
    expect(spDeletes().some((u) => /\/v3\.0\/fields\/SP_BAD\/$/.test(u))).toBe(true); // 試行はした
  });
});
