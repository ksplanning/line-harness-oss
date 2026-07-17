/**
 * form-design (Batch D) — PUT 保存で色/画像テーマを Formaloo へ反映・定義に永続・pull で復元。
 *  - 色は既存 title/description meta PATCH に合流 (hex)。画像 replace は multipart PATCH。
 *  - update 意味論: design 未提供なら PATCH に色を載せず prev design を carry。
 *  - preserve-raw / 後方互換: design 無しフォームは従来挙動不変。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
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
      const statement = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
        async run() { const info = statement.run(...(params as never[])); return { meta: { changes: info.changes } }; },
      };
      return api;
    },
  } as unknown as D1Database;
}

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(join(DB_ROOT, 'migrations')).filter((n) => n.endsWith('.sql')).sort()) {
    for (const sql of readFileSync(join(DB_ROOT, 'migrations', file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/).map((p) => p.trim()).filter(Boolean)) {
      try { db.exec(sql); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

let raw: Database.Database;
let DB: D1Database;

function env(): Env['Bindings'] {
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'design-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
    FORMALOO_API_KEY: 'design-formaloo-key', FORMALOO_API_SECRET: 'design-formaloo-secret',
  } as Env['Bindings'];
}

function app() {
  const hono = new Hono<Env>();
  hono.use('*', authMiddleware);
  hono.use('*', permissionMiddleware);
  hono.route('/', formsAdvanced);
  return hono;
}

function call(method: string, path: string, body?: unknown) {
  return app().request(path, {
    method,
    headers: { Authorization: 'Bearer design-owner-key', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env());
}

function seedForm(id: string, slug: string | null, definitionJson = '{"fields":[],"logic":[]}') {
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, description, definition_json, formaloo_slug)
     VALUES (?, 'タイトル', '説明', ?, ?)`,
  ).run(id, definitionJson, slug);
}

function definitionOf(id: string): Record<string, unknown> {
  const r = raw.prepare(`SELECT definition_json AS d FROM formaloo_forms WHERE id=?`).get(id) as { d: string };
  return JSON.parse(r.d);
}

interface ApiCall { method: string; url: string; body: unknown; multipartFields?: string[] }

function stubFormaloo(opts: { getForm?: Record<string, unknown>; imageFails?: boolean } = {}) {
  const calls: ApiCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    let multipartFields: string[] | undefined;
    if (init?.body instanceof FormData) {
      multipartFields = [...(init.body as FormData).keys()];
    } else {
      try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = undefined; }
    }
    calls.push({ method, url, body, multipartFields });

    if (url.includes('/oauth2/authorization-token/')) {
      return new Response(JSON.stringify({ authorization_token: 'design-jwt' }), { status: 200 });
    }
    if (method === 'POST' && /\/v3\.0\/forms\/$/.test(url)) {
      return new Response(JSON.stringify({ data: { form: { slug: 'CREATED' } } }), { status: 201 });
    }
    if (method === 'GET' && /\/v3\.0\/forms\/[^/]+\/$/.test(url)) {
      return new Response(JSON.stringify({ data: { form: { fields_list: [], ...(opts.getForm ?? {}) } } }), { status: 200 });
    }
    if (method === 'PATCH' && /\/v3\.0\/forms\/[^/]+\/$/.test(url)) {
      // multipart 画像 upload は S3 URL を返す (imageFails 指定時は 500)
      if (multipartFields) {
        if (opts.imageFails) return new Response(JSON.stringify({ errors: { general_errors: ['boom'] } }), { status: 500 });
        const form: Record<string, unknown> = {};
        if (multipartFields.includes('logo')) form.logo = 'https://s3/new-logo.png';
        if (multipartFields.includes('background_image')) form.background_image = 'https://s3/new-bg.png';
        return new Response(JSON.stringify({ data: { form } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: { form: body } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }));
  return calls;
}

const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

beforeEach(() => { raw = new Database(':memory:'); replayAll(raw); DB = d1(raw); });
afterEach(() => vi.unstubAllGlobals());

describe('PUT /api/forms-advanced/:id — form-design 色', () => {
  test('design 色は meta PATCH に hex で合流し、definition_json に永続、response に露出', async () => {
    seedForm('c1', 'SLUG1');
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/c1', {
      fields: [], logic: [],
      design: { themeColor: '#06C755', buttonColor: '#06C755', textColor: '#111111', presetId: 'line-green' },
    });
    expect(res.status).toBe(200);
    const patch = calls.find((e) => e.method === 'PATCH' && /\/forms\/SLUG1\/$/.test(e.url));
    expect(patch?.body).toMatchObject({ theme_color: '#06C755', button_color: '#06C755', text_color: '#111111' });
    // definition_json persist
    expect((definitionOf('c1').design as Record<string, unknown>).themeColor).toBe('#06C755');
    // response 露出
    const data = (await res.json() as { data: { design: Record<string, unknown> } }).data;
    expect(data.design.themeColor).toBe('#06C755');
    expect(data.design.presetId).toBe('line-green');
  });

  test('design 未提供の save は PATCH に色を載せず prev design を carry (update 意味論 / 後方互換)', async () => {
    seedForm('c2', 'SLUG2', JSON.stringify({ fields: [], logic: [], design: { themeColor: '#285C66' } }));
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/c2', { fields: [], logic: [], title: '新題' });
    expect(res.status).toBe(200);
    const patch = calls.find((e) => e.method === 'PATCH' && /\/forms\/SLUG2\/$/.test(e.url));
    expect(patch?.body).toEqual({ title: '新題', description: '説明' }); // 色キー無し
    // prev design carry
    expect((definitionOf('c2').design as Record<string, unknown>).themeColor).toBe('#285C66');
  });

  test('design 無しフォームは従来通り (definition_json に design キー無し)', async () => {
    seedForm('c3', 'SLUG3');
    stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/c3', { fields: [], logic: [] });
    expect(res.status).toBe(200);
    expect('design' in definitionOf('c3')).toBe(false);
  });

  // form-design-presets (D-4 / WARN6): 既存 design-present フォームの PUT で Formaloo に送る色 PATCH payload が
  //   baseline snapshot と一致することを behavioral に固定 (git-diff 非依存)。create-seed 導入 (Option A) は
  //   PUT 経路を触らないため、既存フォームの色 push 挙動は byte 不変 = 後方互換の直接証明。
  test('D-4 既存 design-present フォームの PUT → 色 PATCH payload が baseline snapshot と一致 (後方互換 byte 不変)', async () => {
    seedForm('c4', 'SLUG4', JSON.stringify({ fields: [], logic: [], design: { themeColor: '#285C66', presetId: 'deep-tide' } }));
    const calls = stubFormaloo();
    const fullDesign = {
      themeColor: '#285C66', backgroundColor: '#EEF5F4', buttonColor: '#327682', textColor: '#183A40',
      fieldColor: '#FFFFFF', borderColor: '#AFCAC8', submitTextColor: '#FFFFFF', presetId: 'deep-tide',
    };
    const res = await call('PUT', '/api/forms-advanced/c4', { fields: [], logic: [], title: 'T', description: 'D', design: fullDesign });
    expect(res.status).toBe(200);
    const patch = calls.find((e) => e.method === 'PATCH' && /\/forms\/SLUG4\/$/.test(e.url));
    // meta PATCH body の完全 snapshot: title/description + 7 色 field (hex)。presetId は色 field でないので送らない。
    expect(patch?.body).toEqual({
      title: 'T',
      description: 'D',
      theme_color: '#285C66',
      background_color: '#EEF5F4',
      button_color: '#327682',
      text_color: '#183A40',
      field_color: '#FFFFFF',
      border_color: '#AFCAC8',
      submit_text_color: '#FFFFFF',
    });
  });
});

describe('PUT /api/forms-advanced/:id — form-design 画像', () => {
  test('logo replace は multipart PATCH で送られ、返った S3 URL が design に永続', async () => {
    seedForm('i1', 'SLUGI');
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/i1', {
      fields: [], logic: [],
      design: { themeColor: '#06C755' },
      designImages: { logo: { intent: 'replace', dataUrl: DATA_URL, mimeType: 'image/png' } },
    });
    expect(res.status).toBe(200);
    const mp = calls.find((e) => e.method === 'PATCH' && e.multipartFields?.includes('logo'));
    expect(mp).toBeTruthy();
    expect((definitionOf('i1').design as Record<string, unknown>).logoUrl).toBe('https://s3/new-logo.png');
    const data = (await res.json() as { data: { design: Record<string, unknown> } }).data;
    expect(data.design.logoUrl).toBe('https://s3/new-logo.png');
  });

  test('F1: 画像 replace が失敗したら out_of_sync + D1 の logoUrl を更新しない (silent success 禁止)', async () => {
    seedForm('i3', 'SLUGF', JSON.stringify({ fields: [], logic: [], design: { logoUrl: 'https://s3/old-logo.png' } }));
    stubFormaloo({ imageFails: true });
    const res = await call('PUT', '/api/forms-advanced/i3', {
      fields: [], logic: [],
      design: { logoUrl: 'https://s3/old-logo.png' },
      designImages: { logo: { intent: 'replace', dataUrl: DATA_URL, mimeType: 'image/png' } },
    });
    expect(res.status).toBe(200);
    const data = (await res.json() as { data: { syncStatus: string; syncError: string | null } }).data;
    expect(data.syncStatus).toBe('out_of_sync'); // owner に「未同期」を surface
    expect(data.syncError).toEqual(expect.any(String));
    // D1 の logoUrl は旧値のまま (失敗 slot を確定させない)
    expect((definitionOf('i3').design as Record<string, unknown>).logoUrl).toBe('https://s3/old-logo.png');
  });

  test('cover remove は JSON PATCH {background_image:null} で送られ URL が消える', async () => {
    seedForm('i2', 'SLUGR', JSON.stringify({ fields: [], logic: [], design: { backgroundImageUrl: 'https://s3/old-bg.png' } }));
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/i2', {
      fields: [], logic: [],
      design: { backgroundImageUrl: 'https://s3/old-bg.png' },
      designImages: { cover: { intent: 'remove' } },
    });
    expect(res.status).toBe(200);
    const rm = calls.find((e) => e.method === 'PATCH' && e.body != null && (e.body as Record<string, unknown>).background_image === null);
    expect(rm).toBeTruthy();
    // 唯一の design 要素を消したので design は空 → 永続されない (key 不在)。backgroundImageUrl が消えていればよい。
    const persisted = definitionOf('i2').design as Record<string, unknown> | undefined;
    expect(persisted?.backgroundImageUrl).toBeUndefined();
  });
});

describe('GET /api/forms-advanced/:id/pull — design 復元', () => {
  test('Formaloo GET の色を design として返す', async () => {
    seedForm('p1', 'SLUGP');
    stubFormaloo({ getForm: { theme_color: '#06C755', button_color: '{"r":6,"g":199,"b":85,"a":1}' } });
    const res = await call('GET', '/api/forms-advanced/p1/pull');
    expect(res.status).toBe(200);
    const data = (await res.json() as { data: { ok: boolean; design?: Record<string, unknown> } }).data;
    expect(data.ok).toBe(true);
    expect(data.design?.themeColor).toBe('#06C755');
    expect(data.design?.buttonColor).toBe('#06C755');
  });
});
