/**
 * form-response-display-fix (T-B1) — GET /api/forms-advanced/:id/stats を reconcile 対称化。
 *   回答データ画面の「総回答数」(= /stats の COUNT) が実表示件数より 1 件少ない (off-by-1) 根因は、
 *   /rows は COUNT 前に reconcileFormalooRows (Formaloo pull→ミラー充填) するのに /stats は reconcile せず
 *   直接 COUNT していたこと。piecemaker は webhook 未配線ゆえミラーは /rows reconcile でしか埋まらず、
 *   並列ロードで /stats が未充填ミラーを COUNT → 総回答数 < 実表示。
 *   修理: /stats も COUNT の前に同じ bounded reconcile を実行 (/rows と対称・同一 env flag・fail-soft・冪等)。
 *
 * fixture は S-1 live 実測 shape (rows-reconcile.test.ts と同型)。
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
import { signFriendToken } from '../services/formaloo-friend-token.js';
import type { Env } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;
const FRIEND_TOKEN_SECRET = 'stats_reconcile_friend_metadata_test_secret';
const PAYMENT_FIELD = 'BjEp0J2J';
const FRIEND_METADATA_MAPPINGS = JSON.stringify([
  { formalooFieldKey: PAYMENT_FIELD, friendMetadataKey: '入金確認' },
]);

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

/** upsert(INSERT INTO formaloo_submissions) だけ throw させ、SELECT は素通し (fail-soft 例外経路の検証)。 */
function d1ThrowingUpsert(db: Database.Database): D1Database {
  const base = d1(db);
  return {
    prepare(sql: string) {
      if (/INSERT INTO formaloo_submissions/i.test(sql)) {
        return { bind() { return { async run() { throw new Error('boom-upsert'); } }; } } as unknown as ReturnType<D1Database['prepare']>;
      }
      return base.prepare(sql);
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

function env(overrides: Partial<Env['Bindings']> = {}): Env['Bindings'] {
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'rc-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
    FORMALOO_API_KEY: 'rc-fkey', FORMALOO_API_SECRET: 'rc-fsecret',
    ...overrides,
  } as Env['Bindings'];
}

function app() {
  const a = new Hono<Env>();
  a.use('*', authMiddleware);
  a.use('*', permissionMiddleware);
  a.route('/', formsAdvanced);
  return a;
}
function call(method: string, path: string, envOverrides: Partial<Env['Bindings']> = {}) {
  return app().request(path, { method, headers: { Authorization: 'Bearer rc-owner-key' } }, env(envOverrides));
}

function seedForm(id: string, slug: string | null = null) {
  raw.prepare(`INSERT INTO formaloo_forms (id, formaloo_slug, title, builder_status) VALUES (?,?,?,?)`)
    .run(id, slug ?? `slug_${id}`, 'テスト', 'published');
}
function seedMappedForm(id: string, slug: string) {
  raw.prepare(
    `INSERT INTO formaloo_forms
       (id, formaloo_slug, title, builder_status, friend_metadata_mappings_json)
     VALUES (?,?,?,?,?)`,
  ).run(id, slug, 'テスト', 'published', FRIEND_METADATA_MAPPINGS);
}
function seedFriend(id: string, metadata: Record<string, unknown>) {
  raw.prepare(`INSERT INTO friends (id, line_user_id, display_name, metadata) VALUES (?,?,?,?)`)
    .run(id, `U_${id}`, '田中', JSON.stringify(metadata));
}
function friendMetadata(id: string): Record<string, unknown> {
  const row = raw.prepare('SELECT metadata FROM friends WHERE id=?').get(id) as { metadata: string };
  return JSON.parse(row.metadata) as Record<string, unknown>;
}
function seedSub(id: string, formId: string, answers: Record<string, unknown>, submittedAt: string) {
  raw.prepare(`INSERT INTO formaloo_submissions (id, form_id, answers_json, submitted_at) VALUES (?,?,?,?)`)
    .run(id, formId, JSON.stringify(answers), submittedAt);
}
function mirrorCount(formId: string): number {
  return (raw.prepare('SELECT COUNT(*) n FROM formaloo_submissions WHERE form_id=?').get(formId) as { n: number }).n;
}

function realRow(slug: string, submitCode: string, answers: Record<string, unknown>, createdAt: string): Record<string, unknown> {
  return {
    form: 'GMOxoMtK', row_tags: [], rendered_data: [], data: answers,
    slug, submit_code: submitCode, tracking_code: null, created_at: createdAt, updated_at: createdAt, status: 'active',
  };
}
async function signedMappedRow(slug: string, friendId: string, paymentStatus: string): Promise<Record<string, unknown>> {
  const token = await signFriendToken(friendId, FRIEND_TOKEN_SECRET);
  const row = realRow(slug, `submit_${slug}`, { [PAYMENT_FIELD]: paymentStatus }, '2026-07-19T14:00:00+09:00');
  row.rendered_data = [
    { slug: PAYMENT_FIELD, type: 'text', value: paymentStatus, raw_value: paymentStatus },
    { slug: 'friend_token_field', alias: 'fr_id', type: 'hidden', value: token, raw_value: token },
  ];
  row.data = { ...(row.data as Record<string, unknown>), friend_token_field: token };
  return row;
}
function listBody(rows: Array<Record<string, unknown>>, page: number, pageSize: number) {
  return {
    status: 200, errors: { general_errors: [], form_errors: {} },
    data: { count: rows.length, next: null, previous: null, rows, page_size: pageSize, page_count: 1, current_page: String(page) },
  };
}

/**
 * Formaloo fetch stub。rows-list は pageRows(page) を返す。/stats/ ドリルは空 data を返す。
 * calls[] で rows-list GET 回数を検査 (reconcile skip = 0 call の検証)。
 */
function stubFormaloo(pageRows: (page: number) => Array<Record<string, unknown>>, opts: { listStatus?: number; throwList?: boolean } = {}) {
  const calls: { method: string; url: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url });
    if (url.includes('/oauth2/authorization-token/')) {
      return new Response(JSON.stringify({ authorization_token: 'jwt' }), { status: 200 });
    }
    const m = url.match(/\/v3\.0\/forms\/[^/]+\/rows\/\?page=(\d+)/);
    if (method === 'GET' && m) {
      if (opts.throwList) throw new Error('network-down');
      const page = Number(m[1]);
      const status = opts.listStatus ?? 200;
      if (status >= 300) return new Response('err', { status });
      return new Response(JSON.stringify(listBody(pageRows(page), page, 50)), { status });
    }
    // /stats/ ドリル等
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }));
  return calls;
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});
afterEach(() => { vi.unstubAllGlobals(); });

const rowsListCalls = (calls: { url: string }[]) => calls.filter((c) => /\/rows\/\?page=/.test(c.url)).length;

describe('T-B1 /stats reconcile 対称化 (RED: 現行はミラー直 COUNT / GREEN: COUNT 前に reconcile)', () => {
  test('ミラー空 + Formaloo 4 行 → /stats total=4 (COUNT 前に reconcile) ∧ ミラー充填', async () => {
    seedForm('fa1', 'GMOxoMtK');
    const rows = [
      realRow('slugA', 'scA', { '9x3BCNZW': 'a' }, '2026-07-18T10:00:00.000000'),
      realRow('slugB', 'scB', { '9x3BCNZW': 'b' }, '2026-07-18T11:00:00.000000'),
      realRow('slugC', 'scC', { '9x3BCNZW': 'c' }, '2026-07-18T12:00:00.000000'),
      realRow('slugD', 'scD', { '9x3BCNZW': 'd' }, '2026-07-18T13:00:00.000000'),
    ];
    stubFormaloo((p) => (p === 1 ? rows : []));
    expect(mirrorCount('fa1')).toBe(0); // 前提: ミラー空

    const res = await call('GET', '/api/forms-advanced/fa1/stats');
    expect(res.status).toBe(200);
    const d = (await res.json() as { data: { total: number } }).data;
    expect(d.total).toBe(4); // reconcile 後の COUNT
    expect(mirrorCount('fa1')).toBe(4); // 充填された
  });

  test("env flag ='true' → /stats が rows-list を叩かず (reconcile skip) mirror-only を COUNT", async () => {
    seedForm('fa1', 'GMOxoMtK');
    seedSub('m1', 'fa1', { name: 'ミラーのみ' }, '2026-07-18T01:00:00+09:00');
    const calls = stubFormaloo(() => [realRow('slugA', 'scA', { name: 'live' }, '2026-07-18T10:00:00.000000')]);
    const res = await call('GET', '/api/forms-advanced/fa1/stats', { FORMS_ADVANCED_ROWS_LIVE_RECONCILE_DISABLE: 'true' });
    expect(res.status).toBe(200);
    expect((await res.json() as { data: { total: number } }).data.total).toBe(1); // mirror のまま
    expect(rowsListCalls(calls)).toBe(0); // reconcile skip = rows-list 未接触
    expect(mirrorCount('fa1')).toBe(1); // 充填していない
  });

  test('fail-soft: client null (鍵未配備) → rows-list 未接触・mirror COUNT・500 で落ちない', async () => {
    seedForm('fa1', 'GMOxoMtK');
    seedSub('m1', 'fa1', { name: 'ミラー既存' }, '2026-07-18T01:00:00+09:00');
    const calls = stubFormaloo(() => [realRow('slugA', 'scA', { name: 'live' }, '2026-07-18T10:00:00.000000')]);
    const res = await call('GET', '/api/forms-advanced/fa1/stats', { FORMALOO_API_KEY: undefined, FORMALOO_API_SECRET: undefined });
    expect(res.status).toBe(200);
    expect((await res.json() as { data: { total: number } }).data.total).toBe(1);
    expect(rowsListCalls(calls)).toBe(0);
  });

  test('fail-soft: Formaloo rows-list 非 2xx → mirror COUNT・500 で落ちない', async () => {
    seedForm('fa1', 'GMOxoMtK');
    seedSub('m1', 'fa1', { name: 'ミラー既存' }, '2026-07-18T01:00:00+09:00');
    stubFormaloo(() => [], { listStatus: 500 });
    const res = await call('GET', '/api/forms-advanced/fa1/stats');
    expect(res.status).toBe(200);
    expect((await res.json() as { data: { total: number } }).data.total).toBe(1);
  });

  test('fail-soft: reconcile 中例外 (upsert throw) → /stats は 500 でなく mirror COUNT', async () => {
    seedForm('fa1', 'GMOxoMtK');
    seedSub('m1', 'fa1', { name: 'ミラー既存' }, '2026-07-18T01:00:00+09:00');
    stubFormaloo((p) => (p === 1 ? [realRow('slugA', 'scA', { name: 'live' }, '2026-07-18T10:00:00.000000')] : []));
    const res = await app().request('/api/forms-advanced/fa1/stats', {
      method: 'GET', headers: { Authorization: 'Bearer rc-owner-key' },
    }, env({ DB: d1ThrowingUpsert(raw) }));
    expect(res.status).toBe(200);
    expect((await res.json() as { data: { total: number } }).data.total).toBe(1);
  });

  test('verified / daily は既存どおり返す (reconcile 追加で非退行)', async () => {
    seedForm('fa1', 'GMOxoMtK');
    // reconcile を skip して既存集計のみ検証 (flag ON)。
    seedSub('s1', 'fa1', { name: '田中' }, '2026-07-01T10:00:00+09:00');
    seedSub('s2', 'fa1', { name: '鈴木' }, '2026-07-01T12:00:00+09:00');
    raw.prepare(`UPDATE formaloo_submissions SET verified=1 WHERE id='s1'`).run();
    stubFormaloo(() => []);
    const d = (await (await call('GET', '/api/forms-advanced/fa1/stats', { FORMS_ADVANCED_ROWS_LIVE_RECONCILE_DISABLE: 'true' })).json() as { data: { total: number; verified: number; daily: Array<{ day: string; count: number }> } }).data;
    expect(d.total).toBe(2);
    expect(d.verified).toBe(1);
    expect(d.daily).toEqual([{ day: '2026-07-01', count: 2 }]);
  });
});

describe('D-2 /stats reconcile — 署名 fr_id の mapped row を friend.metadata へ反映', () => {
  test('/stats 単独の reconcile でも valid HMAC mapping を本人の入金確認へ反映する', async () => {
    seedMappedForm('fa1', 'GMOxoMtK');
    seedFriend('frA', { 入金確認: '未', 備考: '手動値を保持' });
    const row = await signedMappedRow('statsPaidRow', 'frA', '済');
    stubFormaloo((page) => (page === 1 ? [row] : []));

    const res = await call('GET', '/api/forms-advanced/fa1/stats', {
      FORMALOO_FRIEND_TOKEN_SECRET: FRIEND_TOKEN_SECRET,
    });

    expect(res.status).toBe(200);
    expect((await res.json() as { data: { total: number } }).data.total).toBe(1);
    expect(friendMetadata('frA')).toMatchObject({
      入金確認: '済',
      備考: '手動値を保持',
      __formaloo_friend_metadata_sync: {
        入金確認: {
          formId: 'fa1',
          rowId: 'statsPaidRow',
          formalooFieldKey: PAYMENT_FIELD,
          value: '済',
        },
      },
    });
  });
});
