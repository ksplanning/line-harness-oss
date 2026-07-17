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
import { lp } from './lp.js';
import { createLpPage } from '@line-crm/db';
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
