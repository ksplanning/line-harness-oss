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
  for (const file of readdirSync(join(DB_ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    for (const sql of readFileSync(join(DB_ROOT, 'migrations', file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean)) {
      try { db.exec(sql); } catch (error) {
        if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
  }
}

let raw: Database.Database;
let DB: D1Database;

function env(overrides: Partial<Env['Bindings']> = {}): Env['Bindings'] {
  return {
    DB,
    IMAGES: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's',
    LINE_CHANNEL_ACCESS_TOKEN: 't',
    API_KEY: 'reapply-owner-key',
    LIFF_URL: 'https://liff.example.test',
    LINE_CHANNEL_ID: 'c',
    LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls',
    WORKER_URL: 'https://api.example.test',
    FORMALOO_API_KEY: 'reapply-formaloo-key',
    FORMALOO_API_SECRET: 'reapply-formaloo-secret',
    ...overrides,
  } as Env['Bindings'];
}

function app() {
  const hono = new Hono<Env>();
  hono.use('*', authMiddleware);
  hono.use('*', permissionMiddleware);
  hono.route('/', formsAdvanced);
  return hono;
}

function call(
  id: string,
  body?: unknown,
  overrides?: Partial<Env['Bindings']>,
  authenticated = true,
) {
  return app().request(`/api/forms-advanced/${id}/reapply-hosted`, {
    method: 'POST',
    headers: {
      ...(authenticated ? { Authorization: 'Bearer reapply-owner-key' } : {}),
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env(overrides));
}

function seedForm(
  id: string,
  slug: string | null,
  definition: Record<string, unknown> = { fields: [], logic: [] },
) {
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, description, definition_json, formaloo_slug)
     VALUES (?, 'タイトル', '説明', ?, ?)`,
  ).run(id, JSON.stringify(definition), slug);
}

function seedFieldMap(formId: string, fieldId: string, slug: string, fieldType = 'video') {
  raw.prepare(
    `INSERT INTO formaloo_field_map
      (id, form_id, formaloo_field_slug, field_type, label, position, config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, '動画', 0, '{}', datetime('now'), datetime('now'))`,
  ).run(fieldId, formId, slug, fieldType);
}

function rawDefinition(id: string): string {
  return (raw.prepare('SELECT definition_json AS value FROM formaloo_forms WHERE id = ?').get(id) as { value: string }).value;
}

function fieldMapRows(id: string): unknown[] {
  return raw.prepare('SELECT * FROM formaloo_field_map WHERE form_id = ? ORDER BY position').all(id);
}

function syncState(id: string): { sync_status: string; last_error: string | null } | undefined {
  return raw.prepare('SELECT sync_status, last_error FROM formaloo_sync_state WHERE form_id = ?').get(id) as
    | { sync_status: string; last_error: string | null }
    | undefined;
}

interface ApiCall { method: string; url: string; body?: unknown }

function stubFormaloo(initialForm: Record<string, unknown> = {}) {
  const calls: ApiCall[] = [];
  const state: Record<string, unknown> = {
    fields_list: [],
    ...JSON.parse(JSON.stringify(initialForm)) as Record<string, unknown>,
  };
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = undefined; }
    calls.push({ method, url, body });
    if (url.includes('/oauth2/authorization-token/')) {
      return new Response(JSON.stringify({ authorization_token: 'reapply-jwt' }), { status: 200 });
    }
    if (method === 'GET' && /\/v3\.0\/forms\/[^/]+\/$/.test(url)) {
      return new Response(JSON.stringify({ data: { form: state } }), { status: 200 });
    }
    if (method === 'PATCH' && /\/v3\.0\/forms\/[^/]+\/$/.test(url)) {
      Object.assign(state, body as Record<string, unknown>);
      return new Response(JSON.stringify({ data: { form: state } }), { status: 200 });
    }
    const fieldMatch = url.match(/\/v3\.0\/fields\/([^/]+)\/$/);
    if (method === 'PATCH' && fieldMatch) {
      const remote = (state.fields_list as Record<string, unknown>[])
        .find((field) => field.slug === fieldMatch[1]);
      if (!remote) return new Response(JSON.stringify({ detail: 'not found' }), { status: 404 });
      Object.assign(remote, body as Record<string, unknown>);
      return new Response(JSON.stringify({ data: { field: remote } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }));
  return { calls, state };
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

afterEach(() => vi.unstubAllGlobals());

describe('POST /api/forms-advanced/:id/reapply-hosted', () => {
  test('未認証は 401', async () => {
    seedForm('auth', 'AUTH');
    const { calls } = stubFormaloo();

    const response = await call('auth', undefined, undefined, false);

    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  test('現デプロイ D1 に存在しない id は 404 で、body の slug/workspace を信用せず外部通信しない', async () => {
    const { calls } = stubFormaloo();

    const response = await call('other-tenant-id', { formalooSlug: 'ATTACK', workspaceId: 'ATTACK' });

    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });

  test('保存済み slug/workspace と field map だけで全 part を再反映し、定義・map を変更しない', async () => {
    const definition = {
      fields: [
        { id: 'rating-1', type: 'rating', label: '満足度', required: false, position: 0, config: {} },
        { id: 'video-1', type: 'video', label: '動画', required: false, position: 1, config: { videoUrl: 'https://definition/ignored' } },
      ],
      logic: [{ id: 'logic-1', sourceFieldId: 'rating-1', operator: 'equals', value: '5', action: 'show', targetFieldId: 'rating-1' }],
      design: { backgroundColor: '#1A1917', ratingStarColor: '#F5B301' },
      formCopy: { buttonText: '送信' },
      localizationJa: true,
    };
    seedForm('ok', 'OWN-SLUG', definition);
    seedFieldMap('ok', 'video-1', 'REMOTE-VIDEO');
    const beforeDefinition = rawDefinition('ok');
    const beforeMap = JSON.stringify(fieldMapRows('ok'));
    const { calls } = stubFormaloo({
      custom_css: '.foreign{}',
      localized_content: { tenant_banner: '残す' },
      fields_list: [{
        slug: 'REMOTE-VIDEO', type: 'oembed', title: '保持', required: false, position: 9,
        url: 'https://remote/current', config: { height: '100px', provider: 'youtube' },
      }],
    });

    const response = await call('ok', { formalooSlug: 'ATTACK-SLUG', workspaceId: 'ATTACK-WORKSPACE' });
    const payload = await response.json() as { success: boolean; data: { ok: boolean; parts: Record<string, { ok: boolean }> } };

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data.ok).toBe(true);
    expect(Object.values(payload.data.parts).every((part) => part.ok)).toBe(true);
    expect(calls.some((call) => call.url.includes('ATTACK-SLUG'))).toBe(false);
    expect(calls.filter((call) => call.method === 'PATCH' && call.url.includes('/forms/OWN-SLUG/'))).toHaveLength(1);
    expect(calls.find((call) => call.method === 'PATCH' && call.url.includes('/fields/REMOTE-VIDEO/'))?.body).toEqual({
      url: 'https://remote/current',
      config: { height: '250px', provider: 'youtube' },
    });
    expect(rawDefinition('ok')).toBe(beforeDefinition);
    expect(JSON.stringify(fieldMapRows('ok'))).toBe(beforeMap);
    expect(syncState('ok')).toMatchObject({ sync_status: 'idle', last_error: null });
  });

  test('動画 field map 欠落の部分失敗は response の videoHeight と sync out_of_sync に surface する', async () => {
    seedForm('partial', 'PARTIAL', {
      fields: [{ id: 'video-no-map', type: 'video', label: '動画', required: false, position: 0, config: { videoUrl: 'https://definition/ignored' } }],
      logic: [],
      design: { textColor: '#222222' },
    });
    stubFormaloo({
      fields_list: [{ slug: 'UNRELATED', type: 'oembed', url: 'https://remote/current', config: { height: '100px' } }],
    });

    const response = await call('partial');
    const payload = await response.json() as {
      success: boolean;
      data: { ok: boolean; parts: { color: { ok: boolean }; videoHeight: { ok: boolean; failedFieldIds: string[] } } };
    };

    expect(response.status).toBe(200);
    expect(payload.success).toBe(false);
    expect(payload.data.ok).toBe(false);
    expect(payload.data.parts.color.ok).toBe(true);
    expect(payload.data.parts.videoHeight).toMatchObject({ ok: false, failedFieldIds: ['video-no-map'] });
    expect(syncState('partial')?.sync_status).toBe('out_of_sync');
    expect(syncState('partial')?.last_error).toContain('videoHeight');
  });

  test("FORMALOO_REAPPLY_DISABLE='1' は DB lookup/sync 更新・Formaloo 通信より前に短絡する", async () => {
    seedForm('disabled', 'DISABLED');
    const before = rawDefinition('disabled');
    const { calls } = stubFormaloo();

    const response = await call(
      'disabled',
      undefined,
      { FORMALOO_REAPPLY_DISABLE: '1' } as Partial<Env['Bindings']>,
    );

    expect(response.status).toBe(503);
    expect(calls).toEqual([]);
    expect(syncState('disabled')).toBeUndefined();
    expect(rawDefinition('disabled')).toBe(before);
  });

  test("FORMALOO_LOCALIZATION_DISABLE='1' は localization だけ skip し、color は再反映する", async () => {
    seedForm('loc-disabled', 'LOC-DISABLED', {
      fields: [], logic: [], design: { textColor: '#222222' }, localizationJa: true,
    });
    const { calls } = stubFormaloo({ localized_content: { foreign: '残す' } });

    const response = await call(
      'loc-disabled',
      undefined,
      { FORMALOO_LOCALIZATION_DISABLE: '1' } as Partial<Env['Bindings']>,
    );
    const payload = await response.json() as {
      success: boolean;
      data: { parts: { color: { ok: boolean; skipped: boolean }; localization: { ok: boolean; skipped: boolean } } };
    };

    expect(response.status).toBe(200);
    expect(payload.success).toBe(true);
    expect(payload.data.parts.color).toMatchObject({ ok: true, skipped: false });
    expect(payload.data.parts.localization).toMatchObject({ ok: true, skipped: true });
    const meta = calls.find((call) => call.method === 'PATCH' && call.url.includes('/forms/'))?.body as Record<string, unknown>;
    expect(meta).toHaveProperty('text_color');
    expect(meta).not.toHaveProperty('localized_content');
  });

  test('保存済み workspace_id が未登録なら env 単一鍵へ fallback せず fail-closed にする', async () => {
    seedForm('foreign-workspace', 'FOREIGN-SLUG');
    raw.prepare('UPDATE formaloo_forms SET workspace_id = ? WHERE id = ?').run('not-registered-here', 'foreign-workspace');
    const { calls } = stubFormaloo();

    const response = await call('foreign-workspace');

    expect(response.status).toBe(503);
    expect(calls).toEqual([]);
    expect(syncState('foreign-workspace')).toMatchObject({ sync_status: 'out_of_sync' });
  });

  test('formaloo_slug 未確定フォームは 409 で外部通信しない', async () => {
    seedForm('no-slug', null);
    const { calls } = stubFormaloo();

    const response = await call('no-slug');

    expect(response.status).toBe(409);
    expect(calls).toEqual([]);
  });
});
