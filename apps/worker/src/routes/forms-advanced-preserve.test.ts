/**
 * formaloo-logic-fidelity Batch 1 — route end-to-end preserve 配線 (real route + in-memory D1 + stubbed Formaloo)。
 *   D-7: rawLogic 無しの初期状態から GET /:id/pull → save body carry → PUT /:id → push PATCH に raw を欠けなく再送
 *   D-8: edit-detection (fingerprint 一致=preserve / 不一致=編集で破壊 push 回避 + 明示警告 / 不在=fail-safe)
 *   D-9: legacy backfill (rawLogic 無しフォーム save 時に push 前 re-pull で raw 取得 → preserve / 不能は fail-soft)
 *   D-12: N-11 filter が compound rule の actions[] 全 target を idSet 照合 (存在参照は保持・dangling のみ除去)
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
import { semanticLogicEqual } from '@line-crm/shared';
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

function env(withFormaloo = true): Env['Bindings'] {
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'env-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
    ...(withFormaloo ? { FORMALOO_API_KEY: 'fk', FORMALOO_API_SECRET: 'fs' } : {}),
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
function call(method: string, path: string, body?: unknown, withFormaloo = true) {
  return app().request(path, {
    method,
    headers: { Authorization: OWNER, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env(withFormaloo));
}

function seedForm(id: string, slug: string | null, definition = '{"fields":[],"logic":[]}') {
  raw.prepare(`INSERT INTO formaloo_forms (id, title, definition_json, formaloo_slug) VALUES (?,?,?,?)`).run(id, id, definition, slug);
}
function readDef(id: string): Record<string, unknown> {
  const row = raw.prepare(`SELECT definition_json FROM formaloo_forms WHERE id=?`).get(id) as { definition_json: string };
  return JSON.parse(row.definition_json);
}

// R0 実 shape: bare array (AND-compound 2 条件 + numeric gt)。
const rawLogicArray = [
  { type: 'field', identifier: 'FS1', actions: [{ action: 'show', args: [{ type: 'field', identifier: 'FS2' }], when: { operation: 'and', args: [{ operation: 'is', args: [{ type: 'field', value: 'FS1' }, { type: 'choice', value: 'c1' }] }, { operation: 'gt', args: [{ type: 'field', value: 'FS2' }, { type: 'constant', value: 5 }] }] } }] },
];

// ── Formaloo stub (global fetch) ──
interface StubOpts { getLogic?: unknown; getStatus?: number }
let fetchCalls: { method: string; url: string; body: unknown }[] = [];
function stubFormaloo(opts: StubOpts = {}) {
  const getLogic = opts.getLogic ?? rawLogicArray;
  const getStatus = opts.getStatus ?? 200;
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = String(init?.body); } // auth body は form-encoded
    fetchCalls.push({ method, url: String(url), body });
    if (String(url).includes('/oauth2/authorization-token/')) {
      return new Response(JSON.stringify({ authorization_token: 'jwt-tok' }), { status: 200 });
    }
    if (String(url).match(/\/v3\.0\/forms\/[^/]+\/$/) && method === 'GET') {
      if (getStatus !== 200) return new Response('err', { status: getStatus });
      return new Response(JSON.stringify({ data: { form: { slug: 'SPIKE', fields_list: [], logic: getLogic } } }), { status: 200 });
    }
    // PATCH / PUT forms (logic push) — capture, return ok
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }));
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
  fetchCalls = [];
});
afterEach(() => vi.unstubAllGlobals());

describe('D-7 — end-to-end preserve 配線 (pull→save→push で raw を欠けなく再送)', () => {
  test('rawLogic 無し初期状態から pull→save で Formaloo に元 raw を verbatim PATCH 再送', async () => {
    seedForm('f1', 'SPIKE'); // definition_json に rawLogic 無し
    stubFormaloo();

    // 1) pull: 応答に rawLogic (bare array) + logicFingerprint
    const pullRes = await call('GET', '/api/forms-advanced/f1/pull');
    expect(pullRes.status).toBe(200);
    const pull = (await pullRes.json() as { data: { ok: boolean; rawLogic: unknown; logicFingerprint: string; logic: unknown[] } }).data;
    expect(pull.ok).toBe(true);
    expect(pull.rawLogic).toEqual(rawLogicArray); // 逐語 (欠けゼロ)
    expect(typeof pull.logicFingerprint).toBe('string');
    expect(pull.logic).toEqual([]); // Batch 1 表示不変

    // 2) save: builder が carry した rawLogic + fingerprint を同梱 (未編集 = logic は pull と同じ [])
    fetchCalls = [];
    const saveRes = await call('PUT', '/api/forms-advanced/f1', { fields: [], logic: pull.logic, rawLogic: pull.rawLogic, logicFingerprint: pull.logicFingerprint });
    expect(saveRes.status).toBe(200);

    // 3) push は PATCH /v3.0/forms/SPIKE/ に元 raw を semantic deep-equal で再送 (PUT でない)
    const patch = fetchCalls.find((c) => c.method === 'PATCH' && /\/v3\.0\/forms\/SPIKE\/$/.test(c.url));
    expect(patch).toBeDefined();
    expect(semanticLogicEqual((patch!.body as { logic: unknown }).logic, rawLogicArray)).toBe(true);
    expect(fetchCalls.some((c) => c.method === 'PUT' && /\/forms\/SPIKE\/$/.test(c.url))).toBe(false);

    // 4) definition_json に rawLogic + logicFingerprint が永続化
    const def = readDef('f1');
    expect(def.rawLogic).toEqual(rawLogicArray);
    expect(typeof def.logicFingerprint).toBe('string');
    const sync = raw.prepare(`SELECT sync_status FROM formaloo_sync_state WHERE form_id='f1'`).get() as { sync_status: string } | undefined;
    expect(sync?.sync_status ?? 'idle').toBe('idle');
  });
});

describe('D-8 — edit-detection', () => {
  test('fingerprint 一致 (未編集) → preserve (raw を PATCH 再送)', async () => {
    seedForm('f1', 'SPIKE');
    stubFormaloo();
    const pull = (await (await call('GET', '/api/forms-advanced/f1/pull')).json() as { data: { rawLogic: unknown; logicFingerprint: string; logic: unknown[] } }).data;
    fetchCalls = [];
    await call('PUT', '/api/forms-advanced/f1', { fields: [], logic: pull.logic, rawLogic: pull.rawLogic, logicFingerprint: pull.logicFingerprint });
    expect(fetchCalls.some((c) => c.method === 'PATCH' && /\/forms\/SPIKE\/$/.test(c.url))).toBe(true);
  });

  test('fingerprint 不一致 (compound を編集) → 破壊 push せず未同期 + 明示警告 (silent 消失なし)', async () => {
    seedForm('f1', 'SPIKE');
    stubFormaloo();
    const pull = (await (await call('GET', '/api/forms-advanced/f1/pull')).json() as { data: { rawLogic: unknown } }).data;
    fetchCalls = [];
    // logicFingerprint を意図的に不一致 (= builder で編集した想定)
    const res = await call('PUT', '/api/forms-advanced/f1', { fields: [], logic: [], rawLogic: pull.rawLogic, logicFingerprint: 'STALE-FINGERPRINT' });
    const data = (await res.json() as { data: { syncStatus: string; syncError: string | null } }).data;
    expect(data.syncStatus).toBe('out_of_sync');
    expect(data.syncError).toContain('複合ロジックを編集');
    // Formaloo の複合を上書きしない (logic の PATCH も PUT も送らない)
    expect(fetchCalls.some((c) => (c.method === 'PATCH' || c.method === 'PUT') && /\/forms\/SPIKE\/$/.test(c.url))).toBe(false);
  });

  test('fingerprint 不在 (レガシー/非 pull 保存) + raw あり → fail-safe で破壊 push せず (silent 消失なし)', async () => {
    seedForm('f1', 'SPIKE');
    stubFormaloo();
    fetchCalls = [];
    const res = await call('PUT', '/api/forms-advanced/f1', { fields: [], logic: [], rawLogic: rawLogicArray });
    const data = (await res.json() as { data: { syncStatus: string } }).data;
    expect(data.syncStatus).toBe('out_of_sync'); // 編集扱い (fail-safe) → compound-edit 警告経路
    expect(fetchCalls.some((c) => (c.method === 'PATCH' || c.method === 'PUT') && /\/forms\/SPIKE\/$/.test(c.url))).toBe(false);
  });
});

describe('D-9 — legacy backfill (rawLogic 無しフォーム救済)', () => {
  test('未編集 + body/D1 に raw 無し → push 前 re-pull で raw 取得 → preserve PATCH', async () => {
    seedForm('f1', 'SPIKE'); // rawLogic 無し (legacy)
    stubFormaloo(); // GET SPIKE は compound raw を返す
    fetchCalls = [];
    // legacy client 想定: rawLogic を送らず fingerprint は空 logic の hash ('[]')
    const res = await call('PUT', '/api/forms-advanced/f1', { fields: [], logic: [], logicFingerprint: '[]' });
    expect(res.status).toBe(200);
    // re-pull (GET) が起き、その raw を PATCH で再送
    expect(fetchCalls.some((c) => c.method === 'GET' && /\/forms\/SPIKE\/$/.test(c.url))).toBe(true);
    const patch = fetchCalls.find((c) => c.method === 'PATCH' && /\/forms\/SPIKE\/$/.test(c.url));
    expect(patch).toBeDefined();
    expect(semanticLogicEqual((patch!.body as { logic: unknown }).logic, rawLogicArray)).toBe(true);
    expect(readDef('f1').rawLogic).toEqual(rawLogicArray); // backfill 結果を永続化
  });

  test('re-pull 不能 (GET 5xx) → preserve せず fail-soft (logic を破壊 push しない・silent 消失なし)', async () => {
    seedForm('f1', 'SPIKE');
    stubFormaloo({ getStatus: 500 });
    fetchCalls = [];
    const res = await call('PUT', '/api/forms-advanced/f1', { fields: [], logic: [], logicFingerprint: '[]' });
    expect(res.status).toBe(200);
    // logic push (PATCH/PUT forms) は起きない (logic 空 + preserve 不成立) = Formaloo の compound を触らない
    expect(fetchCalls.some((c) => (c.method === 'PATCH' || c.method === 'PUT') && /\/forms\/SPIKE\/$/.test(c.url))).toBe(false);
  });
});

describe('D-12 — N-11 filter は compound の actions[] 全 target を idSet 照合', () => {
  test('存在 field を参照する compound は保持・dangling action target を持つ rule は除去', async () => {
    seedForm('f1', null); // Formaloo 未同期 (push しない = filter を単独検証)
    const f1 = { id: 'ff1', type: 'text', label: 'A', required: false, position: 0, config: {} };
    const f2 = { id: 'ff2', type: 'text', label: 'B', required: false, position: 1, config: {} };
    const keepRule = { id: 'rk', sourceFieldId: 'ff1', operator: 'equals', value: 'x', action: 'show', targetFieldId: 'ff1', conditions: [{ sourceFieldId: 'ff1', operator: 'is', value: 'x' }], conditionJoin: 'and', actions: [{ action: 'show', targetFieldId: 'ff1' }, { action: 'hide', targetFieldId: 'ff2' }], raw: { any: 1 } };
    const danglingRule = { id: 'rd', sourceFieldId: 'ff1', operator: 'equals', value: 'y', action: 'show', targetFieldId: 'ff1', actions: [{ action: 'show', targetFieldId: 'ff_ghost' }] };
    const res = await call('PUT', '/api/forms-advanced/f1', { fields: [f1, f2], logic: [keepRule, danglingRule] }, false);
    expect(res.status).toBe(200);
    const logic = (await res.json() as { data: { logic: Array<{ id: string }> } }).data.logic;
    expect(logic.map((r) => r.id)).toContain('rk'); // 存在参照 compound は保持
    expect(logic.map((r) => r.id)).not.toContain('rd'); // dangling action target は除去
  });
});
