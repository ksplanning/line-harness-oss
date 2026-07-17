/**
 * form-post-edit (弾M / T-B2) — PATCH /api/forms-advanced/:id/rows/:rowId ①管理者編集 endpoint。
 *   gate(allow_post_edit AND FORM_POST_EDIT_ENABLED) 403 / flat slug PATCH / persist 確認成功のみ mirror 更新 +
 *   edit 記録 / client null・row_slug 不能・非2xx・persist 未確認 は D1 を書かず正直エラー (殻完了禁止)。
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
    for (const sql of readFileSync(join(DB_ROOT, 'migrations', file), 'utf8').split(/;\s*(?:\r?\n|$)/).map((p) => p.trim()).filter(Boolean)) {
      try { db.exec(sql); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

let raw: Database.Database;
let DB: D1Database;

function env(overrides: Partial<Env['Bindings']> = {}): Env['Bindings'] {
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'pe-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
    FORMALOO_API_KEY: 'pe-fkey', FORMALOO_API_SECRET: 'pe-fsecret',
    FORM_POST_EDIT_ENABLED: 'true',
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

function call(method: string, path: string, body?: unknown, envOverrides: Partial<Env['Bindings']> = {}) {
  return app().request(path, {
    method,
    headers: { Authorization: 'Bearer pe-owner-key', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env(envOverrides));
}

/** definition_json (fields) + formaloo_field_map (id→slug) + allow_post_edit を持つ form を seed。 */
function seedForm(id: string, slug: string | null, allowPostEdit: number) {
  const fields = [
    { id: 'q_name', type: 'text', label: '名前', required: true, position: 0, config: {} },
    { id: 'q_note', type: 'textarea', label: 'メモ', required: false, position: 1, config: {} },
    { id: 'q_pick', type: 'choice', label: '選択', required: false, position: 2, config: {} },
  ];
  raw.prepare(
    `INSERT INTO formaloo_forms (id, formaloo_slug, title, builder_status, definition_json, allow_post_edit)
     VALUES (?,?,?,?,?,?)`,
  ).run(id, slug, 'テスト', 'published', JSON.stringify({ fields, logic: [] }), allowPostEdit);
  const map: [string, string, string][] = [
    ['q_name', 'nameSlug', 'text'],
    ['q_note', 'noteSlug', 'textarea'],
    ['q_pick', 'pickSlug', 'choice'],
  ];
  for (const [fid, fslug, ftype] of map) {
    raw.prepare(
      `INSERT INTO formaloo_field_map (id, form_id, formaloo_field_slug, field_type, label, position, config_json, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(fid, id, fslug, ftype, fid, 0, '{}', '2026-07-17T00:00:00+09:00', '2026-07-17T00:00:00+09:00');
  }
}
function seedSub(id: string, formId: string, answers: Record<string, unknown>, rowSlug: string | null) {
  raw.prepare(
    `INSERT INTO formaloo_submissions (id, form_id, answers_json, submitted_at, formaloo_row_slug) VALUES (?,?,?,?,?)`,
  ).run(id, formId, JSON.stringify(answers), '2026-07-17T00:00:00+09:00', rowSlug);
}

function answersOf(id: string): Record<string, unknown> {
  return JSON.parse((raw.prepare('SELECT answers_json AS a FROM formaloo_submissions WHERE id=?').get(id) as { a: string }).a);
}
function editCount(subId: string): number {
  return (raw.prepare('SELECT COUNT(*) n FROM formaloo_submission_edits WHERE submission_id=?').get(subId) as { n: number }).n;
}
function rowSlugOf(id: string): string | null {
  return (raw.prepare('SELECT formaloo_row_slug v FROM formaloo_submissions WHERE id=?').get(id) as { v: string | null }).v;
}

/**
 * stateful Formaloo stub: rowStore[slug] を PATCH で merge・GET で返す (real persist を模す)。
 * opts.softFail=true で PATCH 200 だが GET が更新前値を返す (soft-200 模擬)。opts.patchStatus で PATCH の HTTP。
 * opts.rowsList で GET /forms/{slug}/rows/ の返す rows を指定 (legacy resolver 用)。
 */
function stubFormaloo(rowStore: Record<string, Record<string, unknown>>, opts: {
  softFail?: boolean; patchStatus?: number; rowsList?: Array<Record<string, unknown>>;
} = {}) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = undefined; }
    calls.push({ method, url, body });
    if (url.includes('/oauth2/authorization-token/')) {
      return new Response(JSON.stringify({ authorization_token: 'jwt' }), { status: 200 });
    }
    // rows-list (legacy resolver)
    const rowsListMatch = url.match(/\/v3\.0\/forms\/[^/]+\/rows\/\?/);
    if (method === 'GET' && rowsListMatch) {
      return new Response(JSON.stringify({ data: { rows: opts.rowsList ?? [] } }), { status: 200 });
    }
    // row PATCH
    const patchMatch = url.match(/\/v3\.0\/rows\/([^/]+)\/$/);
    if (method === 'PATCH' && patchMatch) {
      const slug = patchMatch[1];
      const status = opts.patchStatus ?? 200;
      if (status < 300 && !opts.softFail) {
        rowStore[slug] = { ...(rowStore[slug] ?? {}), ...(body as Record<string, unknown>) };
      }
      return new Response(JSON.stringify({ data: rowStore[slug] ?? {} }), { status });
    }
    // row GET (persist 確認)
    if (method === 'GET' && patchMatch) {
      const slug = patchMatch[1];
      return new Response(JSON.stringify({ data: rowStore[slug] ?? {} }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }));
  return calls;
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});
afterEach(() => vi.unstubAllGlobals());

describe('T-B2 gate (allow_post_edit AND FORM_POST_EDIT_ENABLED)', () => {
  test('allow_post_edit=0 → 403 (env 有効でも編集経路を残さない)', async () => {
    seedForm('f1', 'form_abc', 0);
    seedSub('s1', 'f1', { nameSlug: '田中' }, 'ROW1');
    stubFormaloo({ ROW1: { nameSlug: '田中' } });
    const res = await call('PATCH', '/api/forms-advanced/f1/rows/s1', { answers: { nameSlug: '山田' } });
    expect(res.status).toBe(403);
    expect(answersOf('s1').nameSlug).toBe('田中'); // 未変更
    expect(editCount('s1')).toBe(0);
  });

  test('FORM_POST_EDIT_ENABLED 未設定 → 403 (allow_post_edit=1 でも)', async () => {
    seedForm('f1', 'form_abc', 1);
    seedSub('s1', 'f1', { nameSlug: '田中' }, 'ROW1');
    stubFormaloo({ ROW1: { nameSlug: '田中' } });
    const res = await call('PATCH', '/api/forms-advanced/f1/rows/s1', { answers: { nameSlug: '山田' } }, { FORM_POST_EDIT_ENABLED: undefined });
    expect(res.status).toBe(403);
    expect(answersOf('s1').nameSlug).toBe('田中');
  });
});

describe('T-B2 正常系: flat PATCH + persist 確認 + mirror 更新 + edit 記録', () => {
  test('編集保存 → flat slug body で PATCH (data ラッパ無し) + D1 mirror 更新 + edit 記録', async () => {
    seedForm('f1', 'form_abc', 1);
    seedSub('s1', 'f1', { nameSlug: '田中', noteSlug: '旧' }, 'ROW1');
    const calls = stubFormaloo({ ROW1: { nameSlug: '田中', noteSlug: '旧' } });

    const res = await call('PATCH', '/api/forms-advanced/f1/rows/s1', { answers: { nameSlug: '山田' } });
    expect(res.status).toBe(200);

    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toContain('/v3.0/rows/ROW1/');
    expect(patch?.body).toEqual({ nameSlug: '山田' });   // flat top-level
    expect(patch?.body).not.toHaveProperty('data');       // soft-200 回避 = data ラッパ厳禁

    expect(answersOf('s1').nameSlug).toBe('山田');         // mirror 反映
    expect(answersOf('s1').noteSlug).toBe('旧');           // 他フィールド保持
    expect(editCount('s1')).toBe(1);                       // ④ 監査記録
    const data = (await res.json() as { data: { lastEdit: { editorName: string; editedAt: string } } }).data;
    expect(data.lastEdit.editorName).toBe('Owner');        // env-owner
  });

  test('legacy row_slug=NULL は rows-list submit_code 照合で解決し backfill する', async () => {
    seedForm('f1', 'form_abc', 1);
    seedSub('legrow', 'f1', { nameSlug: '田中' }, null); // row_slug 未 capture
    const calls = stubFormaloo(
      { RESOLVED: { nameSlug: '田中' } },
      { rowsList: [{ slug: 'RESOLVED', submit_code: 'legrow' }] },
    );
    const res = await call('PATCH', '/api/forms-advanced/f1/rows/legrow', { answers: { nameSlug: '花子' } });
    expect(res.status).toBe(200);
    expect(calls.find((c) => c.method === 'PATCH')?.url).toContain('/v3.0/rows/RESOLVED/');
    expect(rowSlugOf('legrow')).toBe('RESOLVED'); // backfill された
  });
});

describe('T-B2 正直エラー (殻完了禁止・D1 を書かない)', () => {
  test('必須項目を空にすると 400 + PATCH せず未変更', async () => {
    seedForm('f1', 'form_abc', 1);
    seedSub('s1', 'f1', { nameSlug: '田中' }, 'ROW1');
    const calls = stubFormaloo({ ROW1: { nameSlug: '田中' } });
    const res = await call('PATCH', '/api/forms-advanced/f1/rows/s1', { answers: { nameSlug: '' } });
    expect(res.status).toBe(400);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(answersOf('s1').nameSlug).toBe('田中');
    expect(editCount('s1')).toBe(0);
  });

  test('選択式のみの編集は 400 (free-value でない = 対象外)', async () => {
    seedForm('f1', 'form_abc', 1);
    seedSub('s1', 'f1', { pickSlug: 'A' }, 'ROW1');
    const calls = stubFormaloo({ ROW1: { pickSlug: 'A' } });
    const res = await call('PATCH', '/api/forms-advanced/f1/rows/s1', { answers: { pickSlug: 'B' } });
    expect(res.status).toBe(400);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  test('row_slug 解決不能 (legacy + rows-list 該当なし) → 422 + D1 未更新', async () => {
    seedForm('f1', 'form_abc', 1);
    seedSub('ghost', 'f1', { nameSlug: '田中' }, null);
    stubFormaloo({}, { rowsList: [{ slug: 'OTHER', submit_code: 'someoneelse' }] });
    const res = await call('PATCH', '/api/forms-advanced/f1/rows/ghost', { answers: { nameSlug: '花子' } });
    expect(res.status).toBe(422);
    expect(answersOf('ghost').nameSlug).toBe('田中');
    expect(editCount('ghost')).toBe(0);
  });

  test('Formaloo client 未接続 (API_KEY 無し) → 502 + D1 未更新 (誤送信防止)', async () => {
    seedForm('f1', 'form_abc', 1);
    seedSub('s1', 'f1', { nameSlug: '田中' }, 'ROW1');
    stubFormaloo({ ROW1: { nameSlug: '田中' } });
    const res = await call('PATCH', '/api/forms-advanced/f1/rows/s1', { answers: { nameSlug: '山田' } }, { FORMALOO_API_KEY: undefined, FORMALOO_API_SECRET: undefined });
    expect(res.status).toBe(502);
    expect(answersOf('s1').nameSlug).toBe('田中');
    expect(editCount('s1')).toBe(0);
  });

  test('PATCH 非2xx → 502 + D1 未更新', async () => {
    seedForm('f1', 'form_abc', 1);
    seedSub('s1', 'f1', { nameSlug: '田中' }, 'ROW1');
    stubFormaloo({ ROW1: { nameSlug: '田中' } }, { patchStatus: 400 });
    const res = await call('PATCH', '/api/forms-advanced/f1/rows/s1', { answers: { nameSlug: '山田' } });
    expect(res.status).toBe(502);
    expect(answersOf('s1').nameSlug).toBe('田中');
  });

  test('soft-200 (PATCH 200 だが persist 未確認) → 502 + D1 未更新 (反映されない編集を成功と見せない)', async () => {
    seedForm('f1', 'form_abc', 1);
    seedSub('s1', 'f1', { nameSlug: '田中' }, 'ROW1');
    stubFormaloo({ ROW1: { nameSlug: '田中' } }, { softFail: true }); // GET は更新前値を返す
    const res = await call('PATCH', '/api/forms-advanced/f1/rows/s1', { answers: { nameSlug: '山田' } });
    expect(res.status).toBe(502);
    expect(answersOf('s1').nameSlug).toBe('田中'); // mirror 未更新 = 殻完了なし
    expect(editCount('s1')).toBe(0);
  });
});
