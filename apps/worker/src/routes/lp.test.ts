/**
 * lp route (harness-lp-hosting) — 公開 serve + 閲覧記録 (C3) / admin CRUD + 権限 gate (C4) /
 * mount + picker (C5)。real SQLite (better-sqlite3 + migration 102) + Map-backed R2 stub。
 *
 * 主要 done: S-2 (serve+CSP) / T-A4 (serve+record) / T-A5 (status flip) / T-A6 (delete cascade) /
 *   T-A7 (slug/traversal) / T-A9 (permission gate) / T-B1 (picker) / T-C1/T-C2 (record fail-closed) /
 *   D-3 (auth 境界) / D-4 (LP CSP・/api には付かない) / D-5 (soft-200 禁止 = D1 実測)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { permissionMiddleware } from '../middleware/permission-middleware.js';
import { rateLimitMiddleware } from '../middleware/rate-limit.js';
import { lp } from './lp.js';
import {
  createLpPage,
  createRole,
  setRolePermissions,
  createStaffMember,
  setStaffRoleId,
} from '@line-crm/db';
import { signLpViewToken } from '../services/lp-view-token.js';
import type { Env } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;
const SECRET = 'lp_friend_secret_test';

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

type StoredObj = { body: Uint8Array; contentType?: string; uploaded: Date; etag: string };
function makeR2Stub(): { r2: R2Bucket; store: Map<string, StoredObj> } {
  const store = new Map<string, StoredObj>();
  const r2 = {
    async put(key: string, value: ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string } }) {
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
      store.set(key, { body: bytes, contentType: options?.httpMetadata?.contentType, uploaded: new Date('2026-07-18T00:00:00.000Z'), etag: 'etag-' + key });
      return {} as never;
    },
    async get(key: string) {
      const item = store.get(key);
      if (!item) return null;
      return { body: item.body, httpMetadata: { contentType: item.contentType }, etag: item.etag } as never;
    },
    async delete(keys: string | string[]) { for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k); },
    async list(opts?: { prefix?: string; cursor?: string; limit?: number }) {
      const prefix = opts?.prefix ?? '';
      const all = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
      const limit = opts?.limit ?? 1000;
      const startIdx = opts?.cursor ? all.indexOf(opts.cursor) + 1 : 0;
      const page = all.slice(startIdx, startIdx + limit);
      const truncated = startIdx + limit < all.length;
      return {
        objects: page.map((key) => ({ key, size: store.get(key)!.body.byteLength, uploaded: store.get(key)!.uploaded, etag: store.get(key)!.etag })),
        truncated,
        cursor: truncated ? page[page.length - 1] : undefined,
      } as never;
    },
  } as unknown as R2Bucket;
  return { r2, store };
}

let raw: Database.Database;
let DB: D1Database;
let R2: R2Bucket;
let store: Map<string, StoredObj>;

function env(overrides: Partial<Env['Bindings']> = {}): Env['Bindings'] {
  return {
    DB, IMAGES: R2, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'env-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
    FORMALOO_FRIEND_TOKEN_SECRET: SECRET,
    ...overrides,
  } as Env['Bindings'];
}

function app(bindings: Env['Bindings'] = env()) {
  const a = new Hono<Env>();
  a.use('*', async (c, next) => { c.env = bindings; await next(); });
  a.use('*', authMiddleware);
  a.use('*', permissionMiddleware);
  a.route('/', lp);
  return a;
}

function seedFriend(id: string, name = '田中') {
  raw.prepare(`INSERT INTO friends (id, line_user_id, display_name) VALUES (?,?,?)`).run(id, `U_${id}`, name);
}

async function seedLp(slug: string, opts: { title?: string; html?: string; assets?: Record<string, { body: string; type?: string }> } = {}) {
  await createLpPage(DB, { slug, title: opts.title ?? slug, entryKey: `lp/${slug}/index.html` });
  await R2.put(`lp/${slug}/index.html`, opts.html ?? `<!DOCTYPE html><html><body>${slug}</body></html>`, { httpMetadata: { contentType: 'text/html; charset=utf-8' } });
  for (const [name, a] of Object.entries(opts.assets ?? {})) {
    await R2.put(`lp/${slug}/${name}`, a.body, { httpMetadata: { contentType: a.type ?? 'application/octet-stream' } });
  }
}

function viewRows(slug: string) {
  return raw.prepare(`SELECT * FROM lp_views WHERE lp_slug=? ORDER BY viewed_at`).all(slug) as Array<{ friend_id: string | null; friend_name: string | null }>;
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
  const stub = makeR2Stub();
  R2 = stub.r2;
  store = stub.store;
});

describe('公開 serve (S-2 / T-A4 / D-3 / D-4)', () => {
  test('active LP: GET /lp/:slug → 200 + text/html + LP CSP', async () => {
    await seedLp('promo');
    const res = await app().request('/lp/promo');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const csp = res.headers.get('Content-Security-Policy') || '';
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  test('Authorization ヘッダなしで 200 到達 (公開 / D-3)', async () => {
    await seedLp('pub');
    const res = await app().request('/lp/pub'); // no auth header
    expect(res.status).toBe(200);
  });

  test('asset serve: GET /lp/:slug/:asset → 200 + 拡張子 Content-Type + CSP', async () => {
    await seedLp('a', { assets: { 'style.css': { body: 'body{color:red}', type: 'text/css' }, 'app.js': { body: 'console.log(1)', type: 'text/javascript' } } });
    const css = await app().request('/lp/a/style.css');
    expect(css.status).toBe(200);
    expect(css.headers.get('Content-Type')).toContain('text/css');
    expect(css.headers.get('Content-Security-Policy')).toContain("connect-src 'none'");
    const js = await app().request('/lp/a/app.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('Content-Type')).toContain('javascript');
  });

  test('ネストした asset path も配信できる', async () => {
    await seedLp('n', { assets: { 'img/hero.png': { body: 'PNG', type: 'image/png' } } });
    const res = await app().request('/lp/n/img/hero.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('image/png');
  });

  test('status=stopped は 404', async () => {
    await seedLp('s');
    raw.prepare(`UPDATE lp_pages SET status='stopped' WHERE slug='s'`).run();
    expect((await app().request('/lp/s')).status).toBe(404);
  });

  test('未登録 slug は 404', async () => {
    expect((await app().request('/lp/never')).status).toBe(404);
  });

  test('registry あるが R2 実体欠落は 404', async () => {
    await createLpPage(DB, { slug: 'ghost', title: 'g', entryKey: 'lp/ghost/index.html' });
    expect((await app().request('/lp/ghost')).status).toBe(404);
  });
});

describe('slug 検証 / path traversal 拒否 (T-A7)', () => {
  test('不正 slug は serve されない (大文字/記号)', async () => {
    expect((await app().request('/lp/BadSlug')).status).toBe(404);
    expect((await app().request('/lp/has_space')).status).toBe(404);
  });

  test('asset path が prefix を脱出しようとすると拒否 (R2 key 脱出不能)', async () => {
    await seedLp('t');
    // 別 prefix の秘密ファイルを置く
    await R2.put('media/secret.png', 'SECRET', { httpMetadata: { contentType: 'image/png' } });
    // ../../media/secret.png で脱出を試みる
    const res = await app().request('/lp/t/..%2F..%2Fmedia%2Fsecret.png');
    expect(res.status).toBe(404);
    const res2 = await app().request('/lp/t/../../media/secret.png');
    expect(res2.status).toBe(404);
  });
});

describe('閲覧記録 (soft-200 禁止・D1 実測 / T-C1 / T-C2 / D-5)', () => {
  test('トークンなし → 匿名 1 行が D1 に残る', async () => {
    await seedLp('v');
    const res = await app().request('/lp/v');
    expect(res.status).toBe(200);
    const rows = viewRows('v');
    expect(rows).toHaveLength(1);
    expect(rows[0].friend_id).toBeNull();
  });

  test('有効トークン + 実在 friend → friend 紐付き 1 行 (実測)', async () => {
    await seedLp('v');
    seedFriend('fr-1', 'すず');
    const token = await signLpViewToken('fr-1', 'v', Date.now() + 3600_000, SECRET);
    const res = await app().request(`/lp/v?v=${encodeURIComponent(token!)}`);
    expect(res.status).toBe(200);
    const rows = viewRows('v');
    expect(rows).toHaveLength(1);
    expect(rows[0].friend_id).toBe('fr-1');
    expect(rows[0].friend_name).toBe('すず');
  });

  test('改ざん/不正トークン → 匿名 degrade (fail-closed)', async () => {
    await seedLp('v');
    seedFriend('fr-1');
    const res = await app().request('/lp/v?v=not-a-valid-token');
    expect(res.status).toBe(200);
    const rows = viewRows('v');
    expect(rows).toHaveLength(1);
    expect(rows[0].friend_id).toBeNull();
  });

  test('有効トークンだが friend 不在 → 匿名 degrade (T-C2 / 誤 attribution 防止)', async () => {
    await seedLp('v');
    // friend fr-x は seed しない
    const token = await signLpViewToken('fr-x', 'v', Date.now() + 3600_000, SECRET);
    const res = await app().request(`/lp/v?v=${encodeURIComponent(token!)}`);
    expect(res.status).toBe(200);
    const rows = viewRows('v');
    expect(rows).toHaveLength(1);
    expect(rows[0].friend_id).toBeNull();
  });

  test('別 LP 向けトークンは当該 LP に紐付けない (slug binding / 匿名)', async () => {
    await seedLp('v');
    seedFriend('fr-1');
    const token = await signLpViewToken('fr-1', 'other-lp', Date.now() + 3600_000, SECRET);
    const res = await app().request(`/lp/v?v=${encodeURIComponent(token!)}`);
    expect(res.status).toBe(200);
    expect(viewRows('v')[0].friend_id).toBeNull();
  });

  test('asset 配信では view を記録しない (index 閲覧のみ計測)', async () => {
    await seedLp('v', { assets: { 'x.css': { body: 'a', type: 'text/css' } } });
    await app().request('/lp/v/x.css');
    expect(viewRows('v')).toHaveLength(0);
  });
});

// ── C4: admin CRUD + 権限 gate ────────────────────────────────────────────────

function authJson(method: string, path: string, apiKey?: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return app().request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const OWNER = 'env-owner-key'; // env.API_KEY = break-glass owner

describe('admin CRUD — 登録/一覧/取得 (T-A2)', () => {
  test('POST /api/lp {slug,title} → 201 + 公開 URL', async () => {
    const res = await authJson('POST', '/api/lp', OWNER, { slug: 'promo1', title: '夏' });
    expect(res.status).toBe(201);
    const b = (await res.json()) as { data: { slug: string; url: string; status: string } };
    expect(b.data.slug).toBe('promo1');
    expect(b.data.status).toBe('active');
    expect(b.data.url).toBe('https://api.example.com/lp/promo1');
    // registry に残る (D1 実測)
    expect(raw.prepare(`SELECT slug FROM lp_pages WHERE slug='promo1'`).get()).toBeTruthy();
  });

  test('不正 slug / 空 title は 400、重複 slug は 409', async () => {
    expect((await authJson('POST', '/api/lp', OWNER, { slug: 'Bad Slug', title: 'x' })).status).toBe(400);
    expect((await authJson('POST', '/api/lp', OWNER, { slug: 'ok1', title: '' })).status).toBe(400);
    expect((await authJson('POST', '/api/lp', OWNER, { slug: 'dup', title: 'A' })).status).toBe(201);
    expect((await authJson('POST', '/api/lp', OWNER, { slug: 'dup', title: 'B' })).status).toBe(409);
  });

  test('GET /api/lp 一覧 (url + 閲覧数) / GET /api/lp/:slug 単体', async () => {
    await seedLp('one', { title: 'One' });
    await seedLp('two', { title: 'Two' });
    await recordViaServe('one'); // 匿名 1 件
    const list = (await (await authJson('GET', '/api/lp', OWNER)).json()) as { data: { items: Array<{ slug: string; url: string; views: { total: number; friendBound: number } }> } };
    expect(list.data.items.map((i) => i.slug).sort()).toEqual(['one', 'two']);
    const one = list.data.items.find((i) => i.slug === 'one')!;
    expect(one.url).toBe('https://api.example.com/lp/one');
    expect(one.views.total).toBe(1);

    const single = (await (await authJson('GET', '/api/lp/one', OWNER)).json()) as { data: { slug: string; views: { total: number } } };
    expect(single.data.slug).toBe('one');
    expect(single.data.views.total).toBe(1);
    expect((await authJson('GET', '/api/lp/nope', OWNER)).status).toBe(404);
  });
});

async function recordViaServe(slug: string, token?: string) {
  await app().request(token ? `/lp/${slug}?v=${encodeURIComponent(token)}` : `/lp/${slug}`);
}

describe('admin 最小ビュー — 直近閲覧 + 総数/紐付き分離 (T-C3)', () => {
  test('GET /api/lp/:slug/views が直近閲覧 (friend 名/時刻) と count を返す', async () => {
    await seedLp('vw', { title: 'V' });
    seedFriend('fr-9', 'ゆい');
    const token = await signLpViewToken('fr-9', 'vw', Date.now() + 3600_000, SECRET);
    await recordViaServe('vw', token!); // friend 紐付き
    await recordViaServe('vw'); // 匿名
    const res = await authJson('GET', '/api/lp/vw/views', OWNER);
    expect(res.status).toBe(200);
    const b = (await res.json()) as { data: { views: Array<{ friend_id: string | null; friend_name: string | null; viewed_at: string }>; counts: { total: number; friendBound: number } } };
    expect(b.data.counts.total).toBe(2);
    expect(b.data.counts.friendBound).toBe(1);
    expect(b.data.views.some((v) => v.friend_id === 'fr-9' && v.friend_name === 'ゆい' && typeof v.viewed_at === 'string')).toBe(true);
  });
});

describe('admin CRUD — 公開停止/再開 が serve を制御 (T-A5)', () => {
  test('PATCH status=stopped → /lp 404 / active → 200', async () => {
    await seedLp('flip');
    expect((await app().request('/lp/flip')).status).toBe(200);
    expect((await authJson('PATCH', '/api/lp/flip', OWNER, { status: 'stopped' })).status).toBe(200);
    expect((await app().request('/lp/flip')).status).toBe(404);
    expect((await authJson('PATCH', '/api/lp/flip', OWNER, { status: 'active' })).status).toBe(200);
    expect((await app().request('/lp/flip')).status).toBe(200);
  });

  test('不正 status は 400 / 未登録 slug は 404', async () => {
    await seedLp('s1');
    expect((await authJson('PATCH', '/api/lp/s1', OWNER, { status: 'bogus' })).status).toBe(400);
    expect((await authJson('PATCH', '/api/lp/none', OWNER, { status: 'stopped' })).status).toBe(404);
  });
});

describe('admin CRUD — 削除が registry と R2 を両方消す (T-A6)', () => {
  test('DELETE → registry 消 + R2 prefix 全 object 消 + /lp 404', async () => {
    await seedLp('gone', { assets: { 'a.css': { body: 'x', type: 'text/css' }, 'img/b.png': { body: 'y', type: 'image/png' } } });
    expect(store.has('lp/gone/index.html')).toBe(true);
    const res = await authJson('DELETE', '/api/lp/gone', OWNER);
    expect(res.status).toBe(200);
    // registry 消
    expect(raw.prepare(`SELECT slug FROM lp_pages WHERE slug='gone'`).get()).toBeUndefined();
    // R2 prefix objects 全消
    expect([...store.keys()].filter((k) => k.startsWith('lp/gone/'))).toEqual([]);
    expect((await app().request('/lp/gone')).status).toBe(404);
  });

  test('1000 超の object も cursor 全周で消す (orphan bytes を残さない / GAP-3)', async () => {
    await createLpPage(DB, { slug: 'big', title: 'B', entryKey: 'lp/big/index.html' });
    for (let i = 0; i < 1005; i++) await R2.put(`lp/big/f${String(i).padStart(5, '0')}.txt`, 'x', { httpMetadata: { contentType: 'text/plain' } });
    expect([...store.keys()].filter((k) => k.startsWith('lp/big/')).length).toBe(1005);
    await authJson('DELETE', '/api/lp/big', OWNER);
    expect([...store.keys()].filter((k) => k.startsWith('lp/big/'))).toEqual([]);
  });

  test('別 prefix (media/ 等) は削除で巻き込まない', async () => {
    await seedLp('scoped');
    await R2.put('media/keep.png', 'k', { httpMetadata: { contentType: 'image/png' } });
    await authJson('DELETE', '/api/lp/scoped', OWNER);
    expect(store.has('media/keep.png')).toBe(true);
  });
});

describe('admin CRUD — ファイル upload (prefix scope + size/type gate / T-A3)', () => {
  function upload(slug: string, filename: string, body: string, type = 'text/html', apiKey = OWNER, path?: string) {
    const fd = new FormData();
    fd.append('file', new File([body], filename, { type }));
    if (path) fd.append('path', path);
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    return app().request(`/api/lp/${slug}/files`, { method: 'POST', headers, body: fd });
  }

  test('upload → R2 lp/<slug>/ に put ・index.html は entry_key に記録', async () => {
    await authJson('POST', '/api/lp', OWNER, { slug: 'up', title: 'U' });
    const res = await upload('up', 'index.html', '<html></html>');
    expect(res.status).toBe(201);
    expect(store.has('lp/up/index.html')).toBe(true);
    expect(raw.prepare(`SELECT entry_key FROM lp_pages WHERE slug='up'`).get()).toMatchObject({ entry_key: 'lp/up/index.html' });
    // nested asset は path で指定
    const res2 = await upload('up', 'hero.png', 'PNG', 'image/png', OWNER, 'img/hero.png');
    expect(res2.status).toBe(201);
    expect(store.has('lp/up/img/hero.png')).toBe(true);
  });

  test('拡張子 allowlist 外 (.php) と size 上限超過は 400 reject', async () => {
    await authJson('POST', '/api/lp', OWNER, { slug: 'g', title: 'G' });
    expect((await upload('g', 'shell.php', '<?php ?>', 'application/x-php')).status).toBe(400);
    const big = 'a'.repeat(5 * 1024 * 1024 + 1);
    expect((await upload('g', 'big.js', big, 'text/javascript')).status).toBe(400);
  });

  test('traversal filename は 400 / 未登録 LP への upload は 404', async () => {
    await authJson('POST', '/api/lp', OWNER, { slug: 'tr', title: 'T' });
    expect((await upload('tr', 'x.css', 'a', 'text/css', OWNER, '../../media/evil.css')).status).toBe(400);
    expect((await upload('none', 'index.html', '<html>', 'text/html')).status).toBe(404);
  });
});

describe('権限 gate + 認証境界 (T-A9 / D-3 / D-4)', () => {
  async function seedStaffWith(features: Array<{ feature_key: string; allowed: boolean }>): Promise<string> {
    const role = await createRole(DB, { name: 'r-' + crypto.randomUUID().slice(0, 6) });
    await setRolePermissions(DB, role.id, features);
    const staff = await createStaffMember(DB, { name: 's', role: 'staff' });
    await setStaffRoleId(DB, staff.id, role.id);
    return staff.api_key;
  }

  test('analytics を持たない custom role は /api/lp で 403、持つと 200 (T-A9)', async () => {
    const noAnalytics = await seedStaffWith([{ feature_key: 'chat', allowed: true }, { feature_key: 'analytics', allowed: false }]);
    const withAnalytics = await seedStaffWith([{ feature_key: 'analytics', allowed: true }]);
    expect((await authJson('GET', '/api/lp', noAnalytics)).status).toBe(403);
    expect((await authJson('GET', '/api/lp', withAnalytics)).status).toBe(200);
  });

  test('built-in role は /api/lp で通過 (byte-identical) / 未認証は 401 (D-3)', async () => {
    const builtin = await createStaffMember(DB, { name: '社員', role: 'staff' });
    expect((await authJson('GET', '/api/lp', builtin.api_key)).status).toBe(200);
    expect((await authJson('GET', '/api/lp')).status).toBe(401); // 認証なし
  });

  test('/api/lp レスポンスに LP 用 CSP は付かない (LP 限定 / D-4)', async () => {
    const res = await authJson('GET', '/api/lp', OWNER);
    expect(res.headers.get('Content-Security-Policy')).toBeNull();
  });
});

describe('公開 /lp の rate-limit パリティ (D-6 / 既存 /images と同等)', () => {
  function rlApp() {
    const a = new Hono<Env>()
    a.use('*', async (c, next) => { c.env = env(); await next() })
    a.use('*', rateLimitMiddleware)
    a.use('*', authMiddleware)
    a.use('*', permissionMiddleware)
    a.route('/', lp)
    return a
  }

  test('/lp は skip されず IP キー UNAUTHENTICATED_MAX(100/min) で計数 = /images パリティ', async () => {
    await seedLp('rl')
    const app = rlApp()
    const headers = { 'cf-connecting-ip': '203.0.113.9' } // 専用 IP でバケット隔離
    for (let i = 0; i < 100; i++) {
      const r = await app.request('/lp/rl', { headers })
      expect(r.status).toBe(200)
    }
    // 101 発目 = 100/min 到達 → 429 (/lp が limiter を通っている = skip リスト非該当・/images と同じ IP バケット)
    const over = await app.request('/lp/rl', { headers })
    expect(over.status).toBe(429)
  })

  test('通常ロード (index + asset 数件) は 429 にならない', async () => {
    await seedLp('rl2', { assets: { 'a.css': { body: 'x', type: 'text/css' }, 'b.js': { body: 'y', type: 'text/javascript' } } })
    const app = rlApp()
    const headers = { 'cf-connecting-ip': '203.0.113.10' }
    expect((await app.request('/lp/rl2', { headers })).status).toBe(200)
    expect((await app.request('/lp/rl2/a.css', { headers })).status).toBe(200)
    expect((await app.request('/lp/rl2/b.js', { headers })).status).toBe(200)
  })
})

describe('LP ピッカー API — 公開中 LP 一覧 (route-phase2 接続 / T-B1)', () => {
  test('GET /api/lp?status=active が公開中のみ {slug,title,url} を返す', async () => {
    await seedLp('live1', { title: '公開1' });
    await seedLp('live2', { title: '公開2' });
    await seedLp('paused', { title: '停止' });
    raw.prepare(`UPDATE lp_pages SET status='stopped' WHERE slug='paused'`).run();
    const res = await authJson('GET', '/api/lp?status=active', OWNER);
    expect(res.status).toBe(200);
    const b = (await res.json()) as { data: { items: Array<{ slug: string; title: string; url: string; status: string }> } };
    expect(b.data.items.map((i) => i.slug).sort()).toEqual(['live1', 'live2']); // paused は出ない
    const one = b.data.items.find((i) => i.slug === 'live1')!;
    // picker が redirect URL フィールドに注入できる形
    expect(one.url).toBe('https://api.example.com/lp/live1');
    expect(one.title).toBe('公開1');
  });
});
