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
    // fr-id-capture-fix (T-C3): friend system field auto-push は本 test の関心外 (design 色/画像)。
    //   本 test の静的 GET mock は POST 後の field を反映しないため ensure が out_of_sync を誤 surface する。
    //   専用検証 = formaloo-sync.system-fields.test.ts。ここでは無効化して orthogonal に保つ。
    FORMALOO_SYSTEM_FIELDS_AUTOPUSH_DISABLE: '1',
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

/** spike 確定: hosted が描画する色形式 = JSON.stringify({r,g,b,a:1})。 */
function jrgba(hex: string): string {
  const h = hex.replace('#', '');
  return JSON.stringify({ r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 });
}

/**
 * Formaloo API stub。色 PATCH は remote form state に round-trip 反映され、後続 GET (= confirmDesignReflected)
 *   がそれを返す (実 Formaloo の GET-after-PATCH 挙動を模倣)。
 *   - opts.softIgnore: 色 PATCH を soft-200 で無言無視 (state に merge しない = 反映されない地雷を再現)。
 *   - opts.softIgnoreUntil: N 回目の confirm GET から反映される (bounded retry 収束を模倣)。
 */
function stubFormaloo(opts: {
  getForm?: Record<string, unknown>; imageFails?: boolean;
  softIgnore?: boolean; reflectAfterGet?: number; imageSoftIgnore?: boolean;
} = {}) {
  const calls: ApiCall[] = [];
  const state: Record<string, unknown> = { fields_list: [], ...(opts.getForm ?? {}) };
  let pendingColors: Record<string, unknown> | null = null;
  let getCount = 0;
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
      getCount += 1;
      // reflectAfterGet: N 回目以降の GET で pending 色を反映 (retry 収束模倣)。
      if (pendingColors && opts.reflectAfterGet != null && getCount >= opts.reflectAfterGet) {
        Object.assign(state, pendingColors); pendingColors = null;
      }
      return new Response(JSON.stringify({ data: { form: { ...state } } }), { status: 200 });
    }
    if (method === 'PATCH' && /\/v3\.0\/forms\/[^/]+\/$/.test(url)) {
      // multipart 画像 upload は S3 URL を返す (imageFails 指定時は 500)
      if (multipartFields) {
        if (opts.imageFails) return new Response(JSON.stringify({ errors: { general_errors: ['boom'] } }), { status: 500 });
        const form: Record<string, unknown> = {};
        if (multipartFields.includes('logo')) form.logo = 'https://s3/new-logo.png';
        if (multipartFields.includes('background_image')) form.background_image = 'https://s3/new-bg.png';
        // 実 Formaloo は upload した画像 URL を GET-after-PATCH で返す (bg-fullpage-render-fix spike 実測)。
        //   imageSoftIgnore は 200 だが永続しない soft-200 を模す (confirmBackgroundReflected の非反映検知テスト用)。
        if (!opts.imageSoftIgnore) Object.assign(state, form);
        return new Response(JSON.stringify({ data: { form } }), { status: 200 });
      }
      // 色キーを remote state に round-trip 反映 (soft-200 無視 / 遅延反映は opts で制御)。
      const colors: Record<string, unknown> = {};
      for (const [k, v] of Object.entries((body ?? {}) as Record<string, unknown>)) if (/_color$/.test(k)) colors[k] = v;
      if (Object.keys(colors).length) {
        if (opts.softIgnore) { /* soft-200: 無言無視 = state に反映しない */ }
        else if (opts.reflectAfterGet != null) pendingColors = { ...(pendingColors ?? {}), ...colors };
        else Object.assign(state, colors);
      }
      // 画像 remove (JSON PATCH {field:null}) は state から削除 (GET-after-PATCH で消える = 実 Formaloo 挙動)。
      for (const f of ['logo', 'background_image']) {
        if ((body as Record<string, unknown> | undefined)?.[f] === null) delete state[f];
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
  test('T-B2 design 色は meta PATCH に JSON-string RGBA で合流し、definition_json に永続、response に露出', async () => {
    seedForm('c1', 'SLUG1');
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/c1', {
      fields: [], logic: [],
      design: { themeColor: '#06C755', buttonColor: '#06C755', textColor: '#111111', presetId: 'line-green' },
    });
    expect(res.status).toBe(200);
    const patch = calls.find((e) => e.method === 'PATCH' && /\/forms\/SLUG1\/$/.test(e.url));
    // hosted が描画する唯一の形式 = JSON-string RGBA (hex ではない)。
    expect(patch?.body).toMatchObject({ theme_color: jrgba('#06C755'), button_color: jrgba('#06C755'), text_color: jrgba('#111111') });
    expect((patch?.body as Record<string, string>).theme_color).not.toMatch(/^#/);
    // definition_json は canonical hex で永続 (D1 正本は harness canonical)。
    expect((definitionOf('c1').design as Record<string, unknown>).themeColor).toBe('#06C755');
    // response 露出 + 反映確認成功で out_of_sync でない。
    const data = (await res.json() as { data: { design: Record<string, unknown>; syncStatus: string } }).data;
    expect(data.design.themeColor).toBe('#06C755');
    expect(data.design.presetId).toBe('line-green');
    expect(data.syncStatus).not.toBe('out_of_sync');
  });

  test('T-B2 design 未提供の save は PATCH に色を載せず prev design を carry (update 意味論 / 後方互換)', async () => {
    seedForm('c2', 'SLUG2', JSON.stringify({ fields: [], logic: [], design: { themeColor: '#285C66' } }));
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/c2', { fields: [], logic: [], title: '新題' });
    expect(res.status).toBe(200);
    const patch = calls.find((e) => e.method === 'PATCH' && /\/forms\/SLUG2\/$/.test(e.url));
    expect(patch?.body).toEqual({ title: '新題', description: '説明' }); // 色キー無し
    // prev design carry
    expect((definitionOf('c2').design as Record<string, unknown>).themeColor).toBe('#285C66');
  });

  test('design 無しフォームは従来通り (definition_json に design キー無し・meta PATCH に色ゼロ)', async () => {
    seedForm('c3', 'SLUG3');
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/c3', { fields: [], logic: [] });
    expect(res.status).toBe(200);
    expect('design' in definitionOf('c3')).toBe(false);
    const patch = calls.find((e) => e.method === 'PATCH' && /\/forms\/SLUG3\/$/.test(e.url));
    // design=null 経路: meta PATCH body に色 field が 1 つも無い (後方互換の直接証明)。
    expect(patch?.body).toEqual({ title: 'タイトル', description: '説明' });
  });

  test('T-B2 design-present フォームの PUT → meta PATCH body が 7 色 JSON-string RGBA の完全 snapshot', async () => {
    seedForm('c4', 'SLUG4', JSON.stringify({ fields: [], logic: [], design: { themeColor: '#285C66', presetId: 'deep-tide' } }));
    const calls = stubFormaloo();
    const fullDesign = {
      themeColor: '#285C66', backgroundColor: '#EEF5F4', buttonColor: '#327682', textColor: '#183A40',
      fieldColor: '#FFFFFF', borderColor: '#AFCAC8', submitTextColor: '#FFFFFF', presetId: 'deep-tide',
    };
    const res = await call('PUT', '/api/forms-advanced/c4', { fields: [], logic: [], title: 'T', description: 'D', design: fullDesign });
    expect(res.status).toBe(200);
    const patch = calls.find((e) => e.method === 'PATCH' && /\/forms\/SLUG4\/$/.test(e.url));
    // meta PATCH body の完全 snapshot: title/description + 7 色 field (JSON-string RGBA)。presetId は色 field でないので送らない。
    expect(patch?.body).toEqual({
      title: 'T',
      description: 'D',
      theme_color: jrgba('#285C66'),
      background_color: jrgba('#EEF5F4'),
      button_color: jrgba('#327682'),
      text_color: jrgba('#183A40'),
      field_color: jrgba('#FFFFFF'),
      border_color: jrgba('#AFCAC8'),
      submit_text_color: jrgba('#FFFFFF'),
    });
  });

  test('T-B1/#9 partial design update は merged 7 色を原子送 (残色破壊防止・単色変更でも全色 push)', async () => {
    // prev = 完全な deep-tide 7 色。incoming = buttonColor だけ変更。
    seedForm('c5', 'SLUG5', JSON.stringify({ fields: [], logic: [], design: {
      themeColor: '#285C66', backgroundColor: '#EEF5F4', buttonColor: '#327682', textColor: '#183A40',
      fieldColor: '#FFFFFF', borderColor: '#AFCAC8', submitTextColor: '#FFFFFF', presetId: 'deep-tide',
    } }));
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/c5', { fields: [], logic: [], title: 'T', description: 'D', design: { buttonColor: '#123456' } });
    expect(res.status).toBe(200);
    const patch = calls.find((e) => e.method === 'PATCH' && /\/forms\/SLUG5\/$/.test(e.url));
    const body = patch?.body as Record<string, string>;
    // 変えた色 + 残り 6 色すべてが JSON-string RGBA で乗る (残色が古い形式/欠落で残らない)。
    expect(body.button_color).toBe(jrgba('#123456'));
    expect(body.theme_color).toBe(jrgba('#285C66'));
    expect(body.background_color).toBe(jrgba('#EEF5F4'));
    expect(body.text_color).toBe(jrgba('#183A40'));
    expect(body.field_color).toBe(jrgba('#FFFFFF'));
    expect(body.border_color).toBe(jrgba('#AFCAC8'));
    expect(body.submit_text_color).toBe(jrgba('#FFFFFF'));
  });

  test('T-B2 soft-200: 色 PATCH が無言無視され GET-after-PATCH で不一致 → out_of_sync (殻完了防止)', async () => {
    seedForm('c6', 'SLUG6');
    stubFormaloo({ softIgnore: true }); // PATCH は 200 だが remote に反映されない
    const res = await call('PUT', '/api/forms-advanced/c6', { fields: [], logic: [], design: { buttonColor: '#06C755' } });
    expect(res.status).toBe(200);
    const data = (await res.json() as { data: { syncStatus: string; syncError: string | null } }).data;
    expect(data.syncStatus).toBe('out_of_sync'); // 「保存済に見えて hosted に出ない」を honest surface
    expect(data.syncError).toEqual(expect.any(String));
  });

  test('T-B2 反映が bounded retry で収束 → idle (eventual consistency)', async () => {
    seedForm('c7', 'SLUG7');
    stubFormaloo({ reflectAfterGet: 2 }); // 2 回目の confirm GET で反映される
    const res = await call('PUT', '/api/forms-advanced/c7', { fields: [], logic: [], design: { buttonColor: '#06C755' } });
    expect(res.status).toBe(200);
    const data = (await res.json() as { data: { syncStatus: string } }).data;
    expect(data.syncStatus).not.toBe('out_of_sync');
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

  // --- bg-fullpage-render-fix R4/T-A1: 背景(cover) replace の GET-after-PATCH 反映確認を out_of_sync に配線 ---
  test('T-A1 背景 replace が hosted に反映 (GET-after-PATCH で top-level background_image 非空) → out_of_sync でない', async () => {
    seedForm('bg1', 'SLUGBG1');
    // 実 Formaloo: multipart upload した background_image は GET-after-PATCH で返る (stub default で state 反映)。
    //   builder は常に design 同梱で送る (id198) ため design も付す = 製品経路と同型。
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/bg1', {
      fields: [], logic: [], design: { themeColor: '#06C755' },
      designImages: { cover: { intent: 'replace', dataUrl: DATA_URL, mimeType: 'image/png' } },
    });
    expect(res.status).toBe(200);
    // 背景 multipart replace が実際に送られた (背景経路に入っている裏付け)。
    expect(calls.some((e) => e.multipartFields?.includes('background_image'))).toBe(true);
    const data = (await res.json() as { data: { syncStatus: string; syncError: string | null } }).data;
    // GET-after-PATCH で top-level background_image 非空 = 反映確認 ok = honest idle (out_of_sync でない)。
    expect(data.syncStatus).not.toBe('out_of_sync');
    expect(data.syncError).toBeNull();
  });

  test('T-A1 背景 replace が soft-200 で非永続 (upload 200 だが GET-after-PATCH で background_image 空) → out_of_sync + error', async () => {
    seedForm('bg2', 'SLUGBG2');
    stubFormaloo({ imageSoftIgnore: true }); // multipart 200 だが state に永続しない = 描画されない soft-200
    const res = await call('PUT', '/api/forms-advanced/bg2', {
      fields: [], logic: [],
      designImages: { cover: { intent: 'replace', dataUrl: DATA_URL, mimeType: 'image/png' } },
    });
    expect(res.status).toBe(200);
    const data = (await res.json() as { data: { syncStatus: string; syncError: string | null } }).data;
    expect(data.syncStatus).toBe('out_of_sync'); // 「保存済に見えて背景が出ない」を honest surface (殻完了防止)
    expect(data.syncError).toEqual(expect.any(String));
  });

  // 🚨 FAIL-1 回帰: 既存背景あり → 別 URL に差し替え → soft-200 で旧 URL が残る → out_of_sync
  //   (upload は 200・新 URL を返すが GET は旧 URL のまま = owner が差し替え成功と誤認する殻完了を防ぐ)。
  test('T-A1 背景 replace で既存画像を別 URL に差し替え・soft-200 で旧 URL 残存 → out_of_sync (差し替え誤認防止)', async () => {
    seedForm('bg5', 'SLUGBG5', JSON.stringify({ fields: [], logic: [], design: { backgroundImageUrl: 'https://s3/OLD-bg.png' } }));
    // GET(state) は旧 URL のまま (imageSoftIgnore=multipart 200 だが永続せず)。multipart 応答の新 URL(applied)と不一致。
    stubFormaloo({ getForm: { background_image: 'https://s3/OLD-bg.png' }, imageSoftIgnore: true });
    const res = await call('PUT', '/api/forms-advanced/bg5', {
      fields: [], logic: [], design: { backgroundImageUrl: 'https://s3/OLD-bg.png' },
      designImages: { cover: { intent: 'replace', dataUrl: DATA_URL, mimeType: 'image/png' } },
    });
    expect(res.status).toBe(200);
    const data = (await res.json() as { data: { syncStatus: string; syncError: string | null } }).data;
    expect(data.syncStatus).toBe('out_of_sync'); // applied 新 URL ≠ GET 旧 URL = 差し替え未反映を honest surface
    expect(data.syncError).toEqual(expect.any(String));
  });

  test('T-A1 背景 remove が反映 (GET-after-PATCH で background_image が cleared) → out_of_sync でない', async () => {
    seedForm('bg3', 'SLUGBG3', JSON.stringify({ fields: [], logic: [], design: { backgroundImageUrl: 'https://s3/old-bg.png' } }));
    stubFormaloo({ getForm: { background_image: 'https://s3/old-bg.png' } });
    const res = await call('PUT', '/api/forms-advanced/bg3', {
      fields: [], logic: [],
      design: { backgroundImageUrl: 'https://s3/old-bg.png' },
      designImages: { cover: { intent: 'remove' } },
    });
    expect(res.status).toBe(200);
    const data = (await res.json() as { data: { syncStatus: string } }).data;
    expect(data.syncStatus).not.toBe('out_of_sync'); // remove が hosted に反映 = honest idle
  });

  test('T-A1 画像 intent 無し (色のみ) の save は背景反映 GET を追加しない (既存挙動不変・no-op)', async () => {
    seedForm('bg4', 'SLUGBG4');
    const calls = stubFormaloo();
    const res = await call('PUT', '/api/forms-advanced/bg4', {
      fields: [], logic: [], design: { buttonColor: '#06C755' },
    });
    expect(res.status).toBe(200);
    // designImages 無し = 背景確認は素通り。GET は色 confirm の分のみ (背景専用の追加 GET を撃たない)。
    const data = (await res.json() as { data: { syncStatus: string } }).data;
    expect(data.syncStatus).not.toBe('out_of_sync');
    // multipart は一度も呼ばれない (画像経路に入っていない = byte 不変の裏付け)。
    expect(calls.some((e) => e.multipartFields)).toBe(false);
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
