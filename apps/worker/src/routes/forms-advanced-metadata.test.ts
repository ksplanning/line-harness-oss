/**
 * form-builder-ux Batch B — 定義保存の metadata / 部分失敗 / decoration logic 契約。
 * T-B7/T-B11/T-B12: D1 先行、Formaloo title+description 同期、失敗終端状態、再試行収束。
 * T-B9: decoration は logic の source/target/conditions/actions に参加させない。
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

interface D1Faults {
  failDefinitionUpdateOnce?: boolean;
}

function d1(db: Database.Database, faults: D1Faults = {}): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
        async run() {
          if (faults.failDefinitionUpdateOnce && /UPDATE formaloo_forms SET\s+definition_json\s*=\s*\?/s.test(sql)) {
            faults.failDefinitionUpdateOnce = false;
            throw new Error('injected definition save failure');
          }
          const info = statement.run(...(params as never[]));
          return { meta: { changes: info.changes } };
        },
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
      try { db.exec(sql); } catch (error) { if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error; }
    }
  }
}

let raw: Database.Database;
let DB: D1Database;

function env(): Env['Bindings'] {
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'metadata-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
    FORMALOO_API_KEY: 'metadata-formaloo-key', FORMALOO_API_SECRET: 'metadata-formaloo-secret',
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
    headers: { Authorization: 'Bearer metadata-owner-key', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env());
}

function seedForm(id: string, slug: string | null, title = '旧タイトル', description: string | null = '旧説明') {
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, description, definition_json, formaloo_slug)
     VALUES (?, ?, ?, '{"fields":[],"logic":[]}', ?)`,
  ).run(id, title, description, slug);
}

interface ApiCall {
  method: string;
  url: string;
  body: unknown;
}

function stubFormaloo(options: {
  metadataStatuses?: number[];
  onApiCall?: (call: ApiCall) => void;
} = {}) {
  const calls: ApiCall[] = [];
  const metadataStatuses = [...(options.metadataStatuses ?? [])];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = undefined; }
    const callRecord = { method, url, body };
    calls.push(callRecord);

    if (url.includes('/oauth2/authorization-token/')) {
      return new Response(JSON.stringify({ authorization_token: 'metadata-jwt' }), { status: 200 });
    }
    options.onApiCall?.(callRecord);
    if (method === 'POST' && /\/v3\.0\/forms\/$/.test(url)) {
      return new Response(JSON.stringify({ data: { form: { slug: 'CREATED_FORM' } } }), { status: 201 });
    }
    if (method === 'PATCH' && /\/v3\.0\/forms\/[^/]+\/$/.test(url)) {
      const status = metadataStatuses.shift() ?? 200;
      return new Response(JSON.stringify({ data: { form: body } }), { status });
    }
    if (method === 'GET' && /\/v3\.0\/forms\/[^/]+\/$/.test(url)) {
      // fr-id-hardening-round2: ensureSystemHiddenFields が読む form-state。fr_id/fr_name hidden を present で返す
      //   (ensure=no-op present → idle)。旧 mock は catch-all {data:{}} を返し fields_list 不在 = 読取不能だった
      //   (silent-skip に依存)。実 Formaloo は GET forms に fields_list を返すため mock を実態に合わせる (T-C3 fail-closed)。
      return new Response(JSON.stringify({ data: { form: { slug: 'FSLUG', fields_list: [
        { slug: 'h_fr_id', alias: 'fr_id', type: 'hidden' }, { slug: 'h_fr_name', alias: 'fr_name', type: 'hidden' },
      ] } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }));
  return calls;
}

function row(id: string) {
  return raw.prepare(
    `SELECT title, description, formaloo_slug AS slug FROM formaloo_forms WHERE id=?`,
  ).get(id) as { title: string; description: string | null; slug: string | null };
}

function syncRow(id: string) {
  return raw.prepare(
    `SELECT sync_status AS status, last_error AS error, remote_definition_hash AS remoteHash,
            pending_remote_hash AS pendingHash, drift_status AS driftStatus
       FROM formaloo_sync_state WHERE form_id=?`,
  ).get(id) as {
    status: string;
    error: string | null;
    remoteHash: string | null;
    pendingHash: string | null;
    driftStatus: string;
  } | undefined;
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

afterEach(() => vi.unstubAllGlobals());

describe('PUT /api/forms-advanced/:id — title/description 保存と Formaloo metadata (T-B7/T-B12)', () => {
  test('既存 slug: D1 を先に更新し、1回の PATCH {title,description} で Formaloo を更新する', async () => {
    seedForm('existing', 'EXISTING_FORM');
    let d1WasPersistedBeforeRemote = false;
    const calls = stubFormaloo({
      onApiCall() {
        const saved = row('existing');
        d1WasPersistedBeforeRemote = saved.title === '新タイトル' && saved.description === '新説明';
      },
    });

    const response = await call('PUT', '/api/forms-advanced/existing', {
      fields: [], logic: [], title: '  新タイトル  ', description: '新説明',
    });

    expect(response.status).toBe(200);
    expect(row('existing')).toEqual({ title: '新タイトル', description: '新説明', slug: 'EXISTING_FORM' });
    expect(d1WasPersistedBeforeRemote).toBe(true);
    const metadataPatches = calls.filter((entry) => entry.method === 'PATCH' && /\/forms\/EXISTING_FORM\/$/.test(entry.url));
    expect(metadataPatches).toHaveLength(1);
    expect(metadataPatches[0].body).toEqual({ title: '新タイトル', description: '新説明' });
    expect(calls.some((entry) => entry.method === 'POST' && /\/v3\.0\/forms\/$/.test(entry.url))).toBe(false);
    expect(syncRow('existing')?.status).toBe('idle');
  });

  test('空の description は D1=null、Formaloo PATCH に description:"" の明示 clear で送る', async () => {
    seedForm('clear_desc', 'CLEAR_FORM');
    const calls = stubFormaloo();

    const response = await call('PUT', '/api/forms-advanced/clear_desc', {
      fields: [], logic: [], title: 'タイトル維持', description: '',
    });

    expect(response.status).toBe(200);
    expect(row('clear_desc').description).toBeNull();
    const patch = calls.find((entry) => entry.method === 'PATCH' && /\/forms\/CLEAR_FORM\/$/.test(entry.url));
    expect(patch?.body).toEqual({ title: 'タイトル維持', description: '' });
  });

  test('初回 slug=null: POST form と後続 metadata PATCH の両方に現在 title/description を渡し、D1 にも保持する', async () => {
    seedForm('initial', null);
    const calls = stubFormaloo({
      onApiCall() {
        expect(row('initial').title).toBe('初回タイトル');
        expect(row('initial').description).toBe('初回説明');
      },
    });

    const response = await call('PUT', '/api/forms-advanced/initial', {
      fields: [], logic: [], title: '初回タイトル', description: '初回説明',
    });

    expect(response.status).toBe(200);
    expect(row('initial')).toEqual({ title: '初回タイトル', description: '初回説明', slug: 'CREATED_FORM' });
    const create = calls.find((entry) => entry.method === 'POST' && /\/v3\.0\/forms\/$/.test(entry.url));
    expect(create?.body).toEqual({ title: '初回タイトル', description: '初回説明' });
    const patch = calls.find((entry) => entry.method === 'PATCH' && /\/forms\/CREATED_FORM\/$/.test(entry.url));
    expect(patch?.body).toEqual({ title: '初回タイトル', description: '初回説明' });
    expect(syncRow('initial')?.status).toBe('idle');
  });

  test('空白だけの title は 400 で D1/Formaloo のどちらも更新しない', async () => {
    seedForm('blank_title', 'BLANK_FORM');
    const calls = stubFormaloo();

    const response = await call('PUT', '/api/forms-advanced/blank_title', {
      fields: [], logic: [], title: '   ', description: '更新されない',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: 'フォーム名を入力してください' });
    expect(row('blank_title')).toEqual({ title: '旧タイトル', description: '旧説明', slug: 'BLANK_FORM' });
    expect(calls.filter((entry) => !entry.url.includes('/oauth2/authorization-token/'))).toEqual([]);
  });
});

describe('PUT /api/forms-advanced/:id — 部分失敗の終端状態 (T-B11)', () => {
  test('metadata PATCH 失敗は D1 を保持して out_of_sync、baseline は消さず、再試行成功時だけ idle に収束する', async () => {
    seedForm('retry', 'RETRY_FORM');
    raw.prepare(
      `INSERT INTO formaloo_sync_state
         (form_id, sync_status, remote_definition_hash, pending_remote_hash, drift_status, drift_detected_at)
       VALUES (?, 'idle', 'BASE', 'PENDING', 'detected', '2026-07-16T00:00:00')`,
    ).run('retry');
    const calls = stubFormaloo({ metadataStatuses: [500, 200] });
    const body = { fields: [], logic: [], title: '再試行タイトル', description: '再試行説明' };

    const failed = await call('PUT', '/api/forms-advanced/retry', body);
    expect(failed.status).toBe(200);
    expect(row('retry').title).toBe('再試行タイトル');
    expect(row('retry').description).toBe('再試行説明');
    expect(syncRow('retry')).toMatchObject({
      status: 'out_of_sync', error: 'フォーム情報の同期に失敗しました',
      remoteHash: 'BASE', pendingHash: 'PENDING', driftStatus: 'detected',
    });

    const retried = await call('PUT', '/api/forms-advanced/retry', body);
    expect(retried.status).toBe(200);
    expect(syncRow('retry')).toMatchObject({
      status: 'idle', error: null, remoteHash: null, pendingHash: null, driftStatus: 'none',
    });
    expect(calls.filter((entry) => entry.method === 'PATCH' && /\/forms\/RETRY_FORM\/$/.test(entry.url))).toHaveLength(2);
  });

  test('D1 定義保存が pushing 設定後に失敗しても pushing に残らない', async () => {
    seedForm('d1_failure', 'D1_FORM');
    DB = d1(raw, { failDefinitionUpdateOnce: true });
    stubFormaloo();

    const response = await call('PUT', '/api/forms-advanced/d1_failure', {
      fields: [], logic: [], title: '保存失敗タイトル', description: '保存失敗説明',
    });

    expect(response.status).toBe(500);
    expect(syncRow('d1_failure')?.status).toBe('out_of_sync');
    expect(syncRow('d1_failure')?.status).not.toBe('pushing');
  });
});

describe('PUT /api/forms-advanced/:id — decoration の logic 構造除外 (T-B9)', () => {
  test('decoration id を flat source/target・conditions[] source・actions[] target に持つ rule をすべて除外する', async () => {
    seedForm('logic_decor', null);
    const fields = [
      { id: 'input_a', type: 'text', label: 'A', required: false, position: 0, config: {} },
      { id: 'input_b', type: 'text', label: 'B', required: false, position: 1, config: {} },
      { id: 'section_1', type: 'section', label: '見出し', required: false, position: 2, config: { text: '本文' } },
      { id: 'page_1', type: 'page_break', label: '改ページ', required: false, position: 3, config: {} },
    ];
    const base = { operator: 'equals', value: 'x', action: 'show' };
    const response = await call('PUT', '/api/forms-advanced/logic_decor', {
      fields,
      logic: [
        { ...base, id: 'keep', sourceFieldId: 'input_a', targetFieldId: 'input_b' },
        { ...base, id: 'flat_source', sourceFieldId: 'section_1', targetFieldId: 'input_b' },
        { ...base, id: 'flat_target', sourceFieldId: 'input_a', targetFieldId: 'page_1' },
        { ...base, id: 'condition_source', sourceFieldId: 'input_a', targetFieldId: 'input_b', conditions: [{ sourceFieldId: 'section_1', operator: 'equals', value: 'x' }] },
        { ...base, id: 'action_target', sourceFieldId: 'input_a', targetFieldId: 'input_b', actions: [{ action: 'show', targetFieldId: 'page_1' }] },
      ],
    });

    expect(response.status).toBe(200);
    const logic = (await response.json() as { data: { logic: Array<{ id: string }> } }).data.logic;
    expect(logic.map((rule) => rule.id)).toEqual(['keep']);
  });

  test('既存の入力 rule に decoration を追加しても rule 数を変えない', async () => {
    seedForm('logic_keep', null);
    const response = await call('PUT', '/api/forms-advanced/logic_keep', {
      fields: [
        { id: 'input_a', type: 'text', label: 'A', required: false, position: 0, config: {} },
        { id: 'input_b', type: 'text', label: 'B', required: false, position: 1, config: {} },
        { id: 'section_1', type: 'section', label: '追加見出し', required: false, position: 2, config: { text: '' } },
      ],
      logic: [
        { id: 'keep', sourceFieldId: 'input_a', operator: 'equals', value: 'x', action: 'show', targetFieldId: 'input_b' },
      ],
    });

    expect(response.status).toBe(200);
    const logic = (await response.json() as { data: { logic: Array<{ id: string }> } }).data.logic;
    expect(logic).toHaveLength(1);
    expect(logic[0].id).toBe('keep');
  });
});
