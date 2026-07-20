/**
 * authMiddleware の method-aware 公開 skip (G64 / T-A8 / Codex CRITICAL-2) — real SQLite。
 *   - GET /api/forms/:id は無認証公開のまま (LIFF 定義取得 / 無回帰)
 *   - PUT/DELETE /api/forms/:id は無認証 401 + custom role (form 禁止) で 403 (method-blind な穴を塞ぐ)
 *   - POST /api/forms/:id/submit は公開 POST のまま
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createRole, setRolePermissions, createStaffMember, setStaffRoleId } from '@line-crm/db';
import { authMiddleware } from './auth.js';
import { permissionMiddleware } from './permission-middleware.js';
import { isPublicApiRoute } from './permission-map.js';
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
  a.get('/api/forms/:id', (c) => c.json({ ok: 'get' }));
  a.put('/api/forms/:id', (c) => c.json({ ok: 'put' }));
  a.delete('/api/forms/:id', (c) => c.json({ ok: 'delete' }));
  a.post('/api/forms/:id/submit', (c) => c.json({ ok: 'submit' }));
  a.get('/api/postal-lookup', (c) => c.json({ ok: 'postal-get' }));
  a.post('/api/postal-lookup', (c) => c.json({ ok: 'postal-post' }));
  return a;
}

function req(method: string, path: string, apiKey?: string) {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return app().request(path, { method, headers }, env());
}

async function seedNoFormStaff(): Promise<string> {
  const role = await createRole(DB, { name: 'チャットのみ' });
  await setRolePermissions(DB, role.id, [
    { feature_key: 'chat', allowed: true },
    { feature_key: 'form', allowed: false },
  ]);
  const s = await createStaffMember(DB, { name: '外注', role: 'staff' });
  await setStaffRoleId(DB, s.id, role.id);
  return s.api_key;
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

describe('isPublicApiRoute 分類 (単体)', () => {
  test('GET /api/forms/:id は公開 / PUT・DELETE は非公開', () => {
    expect(isPublicApiRoute('/api/forms/abc', 'GET')).toBe(true);
    expect(isPublicApiRoute('/api/forms/abc', 'PUT')).toBe(false);
    expect(isPublicApiRoute('/api/forms/abc', 'DELETE')).toBe(false);
    expect(isPublicApiRoute('/api/forms/abc/submit', 'POST')).toBe(true);
    expect(isPublicApiRoute('/api/forms/abc/submit', 'GET')).toBe(false);
    expect(isPublicApiRoute('/api/postal-lookup', 'GET')).toBe(true);
    expect(isPublicApiRoute('/api/postal-lookup', 'POST')).toBe(false);
    expect(isPublicApiRoute('/api/staff', 'GET')).toBe(false);
  });
});

describe('authMiddleware method-aware 公開 skip (T-A8)', () => {
  test('GET /api/forms/:id は無認証公開のまま (LIFF 無回帰)', async () => {
    const res = await req('GET', '/api/forms/abc');
    expect(res.status).toBe(200); // 認証 skip → handler 到達
  });

  test('POST /api/forms/:id/submit は公開 POST のまま', async () => {
    const res = await req('POST', '/api/forms/abc/submit');
    expect(res.status).toBe(200);
  });

  test('GET /api/postal-lookup だけを無認証公開する', async () => {
    expect((await req('GET', '/api/postal-lookup')).status).toBe(200);
    expect((await req('POST', '/api/postal-lookup')).status).toBe(401);
  });

  test('PUT /api/forms/:id は無認証で 401 (method-blind な穴を塞ぐ)', async () => {
    expect((await req('PUT', '/api/forms/abc')).status).toBe(401);
  });

  test('DELETE /api/forms/:id は無認証で 401', async () => {
    expect((await req('DELETE', '/api/forms/abc')).status).toBe(401);
  });

  test('PUT /api/forms/:id は custom role (form 禁止) で 403', async () => {
    const key = await seedNoFormStaff();
    expect((await req('PUT', '/api/forms/abc', key)).status).toBe(403);
  });

  test('PUT /api/forms/:id は built-in staff で 200 (byte-identical に通す)', async () => {
    const s = await createStaffMember(DB, { name: '社員', role: 'staff' });
    expect((await req('PUT', '/api/forms/abc', s.api_key)).status).toBe(200);
  });

  test('GET /api/forms/:id は custom role でも公開のまま (permission 層に来ない)', async () => {
    const key = await seedNoFormStaff();
    // 公開 GET は authMiddleware で skip されるため form 禁止でも 200 (LIFF 定義取得の互換維持)。
    expect((await req('GET', '/api/forms/abc', key)).status).toBe(200);
  });
});
