/**
 * route-terminal-submit (T-C3/T-C4/T-C5/T-A8/T-D1) — worker route の submit action-aware 経路。
 *   T-C3: save filter が submit(target 空) を drop しない
 *   T-C4: pull filter(B5) が submit rule を drop しない + success_page 混入で crash しない
 *   T-C5: 最後の submit 削除で remote logic を PATCH {logic:[]} でクリア
 *   T-A8: terminal-only raw の編集は安全再生成 push / 混在 compound は refuse
 *   T-D1: route-terminal 警告を save レスポンス warnings に additive 合流 (純 show/hide 0 件)
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
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'env-owner-key',
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
const OWNER = 'Bearer env-owner-key';
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

// ── Formaloo stub (global fetch) ──
let fetchCalls: { method: string; url: string; body: unknown }[] = [];
function stubFormaloo(opts: { getLogic?: unknown; getFieldsList?: unknown[] } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = String(init?.body); }
    fetchCalls.push({ method, url: String(url), body });
    if (String(url).includes('/oauth2/authorization-token/')) {
      return new Response(JSON.stringify({ authorization_token: 'jwt-tok' }), { status: 200 });
    }
    // form detail GET
    if (String(url).match(/\/v3\.0\/forms\/[^/]+\/$/) && method === 'GET') {
      return new Response(JSON.stringify({ data: { form: { slug: 'SLUG', fields_list: opts.getFieldsList ?? [], logic: opts.getLogic ?? [] } } }), { status: 200 });
    }
    // field probe GET → 200 (既存扱い)
    if (String(url).match(/\/v3\.0\/fields\/[^/]+\/$/) && method === 'GET') {
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }));
}
function isLogicPatch(c: { method: string; url: string; body: unknown }): boolean {
  return c.method === 'PATCH' && /\/v3\.0\/forms\/[^/]+\/$/.test(c.url)
    && !!c.body && typeof c.body === 'object' && Object.prototype.hasOwnProperty.call(c.body, 'logic');
}

const A2 = { id: 'A2', type: 'text', label: 'A2', required: true, position: 0, config: {} };

beforeEach(() => { raw = new Database(':memory:'); replayAll(raw); DB = d1(raw); fetchCalls = []; });
afterEach(() => vi.unstubAllGlobals());

describe('T-C3 — save filter action-aware (submit target 空を保持)', () => {
  test('submit rule (target 空) は logic filter で drop されず definition_json に残る', async () => {
    seedForm('f1', 'SLUG');
    stubFormaloo();
    const logic = [{ id: 's1', sourceFieldId: 'A2', operator: 'equals', value: '', action: 'submit', targetFieldId: '', terminalTrigger: 'on_answered' }];
    const res = await call('PUT', '/api/forms-advanced/f1', { fields: [A2], logic, formType: 'multi_step' });
    expect(res.status).toBe(200);
    const def = readDef('f1');
    expect((def.logic as Array<{ action: string }>).some((r) => r.action === 'submit')).toBe(true);
  });

  test('非 submit の孤立 target (存在しない field) は従来どおり drop (回帰)', async () => {
    seedForm('f1', 'SLUG');
    stubFormaloo();
    const logic = [{ id: 'r1', sourceFieldId: 'A2', operator: 'equals', value: 'x', action: 'show', targetFieldId: 'ghost' }];
    await call('PUT', '/api/forms-advanced/f1', { fields: [A2], logic });
    expect((readDef('f1').logic as unknown[]).length).toBe(0);
  });
});

describe('T-C5 — 最後の submit 削除で remote logic を空へ', () => {
  test('submit を削除して logic 空 → PATCH {logic:[]} を送る', async () => {
    seedForm('f1', 'SLUG', JSON.stringify({
      fields: [A2],
      logic: [{ id: 's1', sourceFieldId: 'A2', operator: 'equals', value: '', action: 'submit', targetFieldId: '', terminalTrigger: 'on_answered' }],
      logicFingerprint: 'PREV',
    }));
    stubFormaloo();
    fetchCalls = [];
    // logic=[] へ編集 (fingerprint 不一致・raw 無し = 純ハーネス編集)
    const res = await call('PUT', '/api/forms-advanced/f1', { fields: [A2], logic: [], logicFingerprint: 'STALE', formType: 'multi_step' });
    expect(res.status).toBe(200);
    const emptyPatch = fetchCalls.find((c) => isLogicPatch(c) && Array.isArray((c.body as { logic: unknown[] }).logic) && (c.body as { logic: unknown[] }).logic.length === 0);
    expect(emptyPatch).toBeDefined();
  });

  test('submit を未編集で save (fingerprint 一致) → remote logic をクリアせず preserve (submit 保持)', async () => {
    const submitRaw = [
      { type: 'field', identifier: 'A2', actions: [{ action: 'submit', args: [], when: { operation: 'is_answered', args: [{ type: 'field', value: 'A2' }] } }] },
    ];
    seedForm('f1', 'SLUG');
    stubFormaloo({ getLogic: submitRaw, getFieldsList: [{ type: 'short_text', slug: 'A2', title: 'A2', required: true, position: 0 }] });
    // pull で display logic + rawLogic + fingerprint を得る
    const pull = (await (await call('GET', '/api/forms-advanced/f1/pull')).json() as { data: { logic: unknown[]; rawLogic: unknown; logicFingerprint: string } }).data;
    fetchCalls = [];
    // 未編集 save (fingerprint 一致 = preserve)
    await call('PUT', '/api/forms-advanced/f1', { fields: [A2], logic: pull.logic, rawLogic: pull.rawLogic, logicFingerprint: pull.logicFingerprint, design: { themeColor: '#123456' } });
    // 送られる logic PATCH は preserve (submit を含む非空) = クリアしていない
    const logicPatch = fetchCalls.find(isLogicPatch);
    expect(logicPatch).toBeDefined();
    expect((logicPatch!.body as { logic: unknown[] }).logic.length).toBeGreaterThan(0);
  });
});

describe('T-A8 — terminal-only raw は安全再生成 / 混在 compound は refuse', () => {
  const terminalRaw = [
    { type: 'field', identifier: 'A2', actions: [{ action: 'submit', args: [], when: { operation: 'is_answered', args: [{ type: 'field', value: 'A2' }] } }] },
  ];
  const compoundRaw = [
    { type: 'field', identifier: 'A2', actions: [{ action: 'show', args: [{ type: 'field', identifier: 'B2' }], when: { operation: 'and', args: [{ operation: 'is', args: [{ type: 'field', value: 'A2' }, { type: 'choice', value: 'c' }] }, { operation: 'gt', args: [{ type: 'field', value: 'B2' }, { type: 'constant', value: 5 }] }] } }] },
  ];

  test('terminal-only raw を編集 → 再生成 push (複合警告を出さない)', async () => {
    seedForm('f1', 'SLUG', JSON.stringify({
      fields: [A2],
      logic: [{ id: 's1', sourceFieldId: 'A2', operator: 'equals', value: '', action: 'submit', targetFieldId: '', terminalTrigger: 'on_answered' }],
      rawLogic: terminalRaw, logicFingerprint: 'PREV',
    }));
    stubFormaloo();
    fetchCalls = [];
    const res = await call('PUT', '/api/forms-advanced/f1', {
      fields: [A2],
      logic: [{ id: 's1', sourceFieldId: 'A2', operator: 'equals', value: '', action: 'submit', targetFieldId: '', terminalTrigger: 'on_answered' }],
      rawLogic: terminalRaw, logicFingerprint: 'STALE', formType: 'multi_step',
    });
    const data = (await res.json() as { data: { syncError: string | null } }).data;
    expect(data.syncError ?? '').not.toContain('複合ロジックを編集');
    expect(fetchCalls.some(isLogicPatch)).toBe(true);
  });

  test('混在 compound raw を編集 → refuse (未同期 + 複合警告・logic PATCH 送らない)', async () => {
    seedForm('f1', 'SLUG', JSON.stringify({ fields: [A2], logic: [], rawLogic: compoundRaw, logicFingerprint: 'PREV' }));
    stubFormaloo();
    fetchCalls = [];
    const res = await call('PUT', '/api/forms-advanced/f1', { fields: [A2], logic: [], rawLogic: compoundRaw, logicFingerprint: 'STALE' });
    const data = (await res.json() as { data: { syncStatus: string; syncError: string | null } }).data;
    expect(data.syncError ?? '').toContain('複合ロジックを編集');
    expect(fetchCalls.some(isLogicPatch)).toBe(false);
  });
});

describe('T-D1 — save warnings 合流 + 誤警告なし', () => {
  test('jump ルート未閉鎖 → save warnings に なだれ込み 警告が合流', async () => {
    seedForm('f1', 'SLUG');
    stubFormaloo();
    const fields = [
      { id: 'q1', type: 'choice', label: 'Q', required: false, position: 0, config: { choices: ['A', 'B'] } },
      { id: 'pbA', type: 'page_break', label: 'Aページ', required: false, position: 1, config: {} },
      { id: 'A1', type: 'text', label: 'A1', required: false, position: 2, config: {} },
      { id: 'pbB', type: 'page_break', label: 'Bページ', required: false, position: 3, config: {} },
      { id: 'B1', type: 'text', label: 'B1', required: false, position: 4, config: {} },
    ];
    const logic = [
      { id: 'j1', sourceFieldId: 'q1', operator: 'equals', value: 'A', action: 'jump', targetFieldId: 'pbA' },
      { id: 'j2', sourceFieldId: 'q1', operator: 'equals', value: 'B', action: 'jump', targetFieldId: 'pbB' },
    ];
    const res = await call('PUT', '/api/forms-advanced/f1', { fields, logic, formType: 'multi_step' });
    const json = await res.json() as { warnings?: string[] };
    expect(json.warnings?.some((w) => /なだれ込み/.test(w))).toBe(true);
  });

  test('純 show/hide フォームは route-terminal 警告が付かない', async () => {
    seedForm('f1', 'SLUG');
    stubFormaloo();
    const fields = [A2, { id: 'B2', type: 'text', label: 'B2', required: false, position: 1, config: {} }];
    const logic = [{ id: 'r1', sourceFieldId: 'A2', operator: 'equals', value: 'x', action: 'show', targetFieldId: 'B2' }];
    const res = await call('PUT', '/api/forms-advanced/f1', { fields, logic });
    const json = await res.json() as { warnings?: string[] };
    expect((json.warnings ?? []).some((w) => /なだれ込み|データ損失|送信でき/.test(w))).toBe(false);
  });
});

describe('T-C4 — pull filter action-aware + success_page 防御', () => {
  test('submit rule(target 空) を pull display から drop しない + success_page 混入で crash しない', async () => {
    // Formaloo GET が submit logic + fields_list に success_page 混入を返す
    const getLogic = [
      { type: 'field', identifier: 'A2', actions: [{ action: 'submit', args: [], when: { operation: 'is_answered', args: [{ type: 'field', value: 'A2' }] } }] },
    ];
    const getFieldsList = [
      { type: 'short_text', slug: 'A2', title: 'A2', required: true, position: 0 },
      { type: 'success_page', slug: 'sp1', title: 'THANKS', description: 'done', is_default: false, position: 1 },
    ];
    seedForm('f1', 'SLUG');
    stubFormaloo({ getLogic, getFieldsList });
    const res = await call('GET', '/api/forms-advanced/f1/pull');
    expect(res.status).toBe(200);
    const data = (await res.json() as { data: { ok: boolean; logic: Array<{ action: string; sourceFieldId: string }>; fields: unknown[] } }).data;
    expect(data.ok).toBe(true);
    // success_page は harness field 化しない (null-drop) = fields は A2 のみ
    expect(data.fields.length).toBe(1);
    // submit rule は drop されず表示される
    expect(data.logic.some((r) => r.action === 'submit' && r.sourceFieldId === 'A2')).toBe(true);
  });
});
