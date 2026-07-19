/**
 * submissions-visibility-fix — GET /api/forms-advanced/:id/rows の Formaloo live reconcile。
 *   piecemaker で回答が Formaloo に実在するのに D1 ミラーが空 (webhook 未配線) → 一覧が「回答がありません」。
 *   兄弟 /stats・/rows/:rowId と同じ「Formaloo=SoT / ミラー=cache」モデルへ揃える: rows-list を bounded pull →
 *   既存 upsertFormalooSubmission でミラー充填 → 既存 queryFormalooSubmissions で返す (fail-soft / env flag)。
 *
 * fixture は S-1 live 実測 shape をミラー (2026-07-17 / form GMOxoMtK 実 4 行):
 *   rows-list body = { status, errors, data: { count, next, previous, rows:[...], page_size, page_count, current_page } }
 *   row            = { form, row_tags:[], rendered_data:[...], data:{<field_slug>:value}, slug(20ch 可 addressable),
 *                      submit_code(20ch), created_at(ISO), ... }
 *   answers は row.data (field-slug キーの flat map) / addressable id は row.slug / submittedAt は row.created_at。
 *   (fixture-vs-reality 事故防止 = id-191/id-160 教訓。実 shape は sidecar S-1 節に実測証跡。)
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
import { mapFormalooListRowToUpsert } from '../services/formaloo-row-edit.js';
import { signFriendToken } from '../services/formaloo-friend-token.js';
import type { Env } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;
const FRIEND_TOKEN_SECRET = 'rows_reconcile_friend_metadata_test_secret';
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

/** upsert(INSERT INTO formaloo_submissions) だけ throw させ、SELECT は素通し (fail-soft 例外経路の検証用)。 */
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
    // client 解決に要る (workspace_id=NULL の form → env 単一鍵 fallback で createFormalooClient)。
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
  return app().request(path, {
    method,
    headers: { Authorization: 'Bearer rc-owner-key', 'Content-Type': 'application/json' },
  }, env(envOverrides));
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
function mirrorRow(id: string): { answers_json: string; formaloo_row_slug: string | null; verified: number; friend_id: string | null } | undefined {
  return raw.prepare('SELECT answers_json, formaloo_row_slug, verified, friend_id FROM formaloo_submissions WHERE id=?').get(id) as never;
}
function receiptRow(id: string): { tracking_code: string | null; submit_number: string | null; pdf_link: string | null } | undefined {
  return raw.prepare('SELECT tracking_code, submit_number, pdf_link FROM formaloo_submissions WHERE id=?').get(id) as never;
}

/** S-1 実測 shape の rows-list row を作る (load-bearing field のみ・実形を忠実に反映)。 */
function realRow(slug: string, submitCode: string, answers: Record<string, unknown>, createdAt: string): Record<string, unknown> {
  return {
    form: 'GMOxoMtK',
    row_tags: [],
    rendered_data: Object.keys(answers).map((k, i) => ({ form: 'GMOxoMtK', slug: k, type: 'text', title: `Q${i}`, value: answers[k], raw_value: answers[k] })),
    data: answers, // ← answers は row.data (field-slug キー flat map / S-1 実測)
    slug, // ← addressable id (20ch 相当)。/v3.0/rows/{slug}/ が 200 で解決 (S-1 実測)
    submit_code: submitCode,
    tracking_code: null,
    created_at: createdAt, // ← submittedAt
    updated_at: createdAt,
    status: 'active',
  };
}

async function signedMappedRow(
  slug: string,
  friendId: string,
  paymentStatus: string,
  createdAt = '2026-07-19T14:00:00+09:00',
): Promise<Record<string, unknown>> {
  const token = await signFriendToken(friendId, FRIEND_TOKEN_SECRET);
  const row = realRow(slug, `submit_${slug}`, { [PAYMENT_FIELD]: paymentStatus }, createdAt);
  row.rendered_data = [
    ...(row.rendered_data as unknown[]),
    { slug: 'friend_token_field', alias: 'fr_id', type: 'hidden', value: token, raw_value: token },
  ];
  row.data = { ...(row.data as Record<string, unknown>), friend_token_field: token };
  return row;
}

/** rows-list body を S-1 実測どおりに包む (data.rows・extractRows が data.data.rows を解決)。 */
function listBody(rows: Array<Record<string, unknown>>, page: number, pageSize: number) {
  return {
    status: 200,
    errors: { general_errors: [], form_errors: {} },
    data: { count: rows.length, next: null, previous: null, rows, page_size: pageSize, page_count: 1, current_page: String(page) },
  };
}

/**
 * Formaloo fetch stub。pageRows(page) が各ページの row 群を返す。
 * opts.listStatus で rows-list の HTTP を上書き (非2xx fail-soft 検証)。opts.throwList=true で fetch 例外。
 * 返す calls[] で rows-list GET 回数・URL を検査 (bounded cap / env flag off の 0 call 検証)。
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

// ── T-A6: mapper 単体 (S-1 実測 shape の写像) ──
describe('T-A6 mapFormalooListRowToUpsert', () => {
  test('row → upsert 入力へ S-1 実測 shape どおり写像 (id=slug / answers=row.data / submittedAt=created_at)', async () => {
    const form = { id: 'fa1', formaloo_slug: 'GMOxoMtK' };
    const row = realRow('rowSlug20chAaaaaaaaa', 'submitCode20chBbbbbb', { '9x3BCNZW': 'eee', N31hP5KP: 'a@b.example.com' }, '2026-07-17T12:00:00.000000');
    const input = (await mapFormalooListRowToUpsert(row, form))!;
    expect(input.id).toBe('rowSlug20chAaaaaaaaa');
    expect(input.rowSlug).toBe('rowSlug20chAaaaaaaaa');
    expect(input.formId).toBe('fa1');
    expect(input.formalooSlug).toBe('GMOxoMtK');
    expect(JSON.parse(input.answersJson)).toEqual({ '9x3BCNZW': 'eee', N31hP5KP: 'a@b.example.com' });
    expect(input.submittedAt).toBe('2026-07-17T12:00:00.000000');
    expect(input.friendId).toBeNull();
    expect(input.verified).toBe(false);
  });
  test('slug 欠落 row は null (addressable でない = 書けない)', async () => {
    const form = { id: 'fa1', formaloo_slug: 'GMOxoMtK' };
    expect(await mapFormalooListRowToUpsert({ data: { a: 1 }, submit_code: 'x' }, form)).toBeNull();
  });
  test('data 欠落は answers={} / created_at 欠落は fallback (空でなく truthy)', async () => {
    const form = { id: 'fa1', formaloo_slug: 'GMOxoMtK' };
    const input = (await mapFormalooListRowToUpsert({ slug: 'sOnly' }, form))!;
    expect(input.answersJson).toBe('{}');
    expect(typeof input.submittedAt).toBe('string');
    expect(input.submittedAt.length).toBeGreaterThan(0);
  });
  test('submit-time 控え metadata は row root の完全一致キーだけを取込み、回答内の同名キーは無視する', async () => {
    const form = { id: 'fa1', formaloo_slug: 'GMOxoMtK' };
    const row = realRow(
      'receipt-row',
      'sc',
      { tracking_code: '回答欄の値', submit_number: '回答欄の値', pdf_link: 'https://wrong.example/answer.pdf' },
      '2026-07-17T12:00:00.000000',
    );
    Object.assign(row, {
      tracking_code: '  TRACK-001  ',
      submit_number: 42,
      pdf_link: ' https://cdn.example.test/receipt.pdf ',
    });
    const input = (await mapFormalooListRowToUpsert(row, form))!;
    expect(input.trackingCode).toBe('TRACK-001');
    expect(input.submitNumber).toBe('42');
    expect(input.pdfLink).toBe('https://cdn.example.test/receipt.pdf');

    const collisionOnly = (await mapFormalooListRowToUpsert({
      slug: 'collision-only',
      data: { tracking_code: 'answer-only', submit_number: 'answer-only', pdf_link: 'https://wrong.example/answer.pdf' },
    }, form))!;
    expect(collisionOnly.trackingCode).toBeNull();
    expect(collisionOnly.submitNumber).toBeNull();
    expect(collisionOnly.pdfLink).toBeNull();
  });
});

// ── T-A1: reconcile 本線 (Formaloo に rows / ミラー空 → 一覧が非空) ──
describe('T-A1 /rows reconcile (RED: 現行は空を返す / GREEN: Formaloo から充填)', () => {
  test('Formaloo に 4 行・ミラー空 → 一覧が 4 行を返し、ミラーが充填される', async () => {
    seedForm('fa1', 'GMOxoMtK');
    const rows = [
      realRow('slugA', 'scA', { '9x3BCNZW': 'eee' }, '2026-07-17T10:00:00.000000'),
      realRow('slugB', 'scB', { '9x3BCNZW': 'rrr' }, '2026-07-17T11:00:00.000000'),
      realRow('slugC', 'scC', { '9x3BCNZW': 'sssssssss' }, '2026-07-17T12:00:00.000000'),
      realRow('slugD', 'scD', { '9x3BCNZW': 'test' }, '2026-07-17T13:00:00.000000'),
    ];
    stubFormaloo((p) => (p === 1 ? rows : []));
    expect(mirrorCount('fa1')).toBe(0); // 前提: ミラー空

    const res = await call('GET', '/api/forms-advanced/fa1/rows');
    expect(res.status).toBe(200);
    const d = (await res.json() as { data: { rows: Array<{ id: string; answers: Record<string, unknown> }>; total: number } }).data;
    expect(d.total).toBe(4);
    expect(new Set(d.rows.map((r) => r.id))).toEqual(new Set(['slugA', 'slugB', 'slugC', 'slugD']));
    // ミラーが充填され answers=row.data / row_slug=slug が入る (詳細/編集 = 弾M の前提充足)
    expect(mirrorCount('fa1')).toBe(4);
    expect(JSON.parse(mirrorRow('slugA')!.answers_json)).toEqual({ '9x3BCNZW': 'eee' });
    expect(mirrorRow('slugA')!.formaloo_row_slug).toBe('slugA');
    expect(mirrorRow('slugA')!.verified).toBe(0);
    expect(mirrorRow('slugA')!.friend_id).toBeNull();
  });

  test('reconcile pull が tracking_code / submit_number / pdf_link を D1 ミラーへ保存する', async () => {
    seedForm('fa-receipt', 'RECEIPT_FORM');
    const row = realRow('receipt-slug', 'sc-receipt', { answer: 'ok' }, '2026-07-17T14:00:00.000000');
    Object.assign(row, {
      tracking_code: 'TRACK-900',
      submit_number: '000123',
      pdf_link: 'https://cdn.example.test/receipt-900.pdf',
    });
    stubFormaloo((page) => (page === 1 ? [row] : []));

    const res = await call('GET', '/api/forms-advanced/fa-receipt/rows');
    expect(res.status).toBe(200);
    expect(receiptRow('receipt-slug')).toEqual({
      tracking_code: 'TRACK-900',
      submit_number: '000123',
      pdf_link: 'https://cdn.example.test/receipt-900.pdf',
    });
  });

  test('idempotent: 2 回 reconcile しても 1 行 (ON CONFLICT(id))', async () => {
    seedForm('fa1', 'GMOxoMtK');
    stubFormaloo((p) => (p === 1 ? [realRow('slugA', 'scA', { '9x3BCNZW': 'eee' }, '2026-07-17T10:00:00.000000')] : []));
    await call('GET', '/api/forms-advanced/fa1/rows');
    await call('GET', '/api/forms-advanced/fa1/rows');
    expect(mirrorCount('fa1')).toBe(1);
  });
});

describe('D-2 /rows reconcile — 署名 fr_id の mapped row を friend.metadata へ反映', () => {
  test('有効 HMAC + form mapping の「済」を本人の入金確認だけに反映する', async () => {
    seedMappedForm('fa1', 'GMOxoMtK');
    seedFriend('frA', { 入金確認: '未', 備考: '手動値を保持' });
    const row = await signedMappedRow('paidRow', 'frA', '済');
    stubFormaloo((page) => (page === 1 ? [row] : []));

    const res = await call('GET', '/api/forms-advanced/fa1/rows', {
      FORMALOO_FRIEND_TOKEN_SECRET: FRIEND_TOKEN_SECRET,
    });

    expect(res.status).toBe(200);
    expect(mirrorRow('paidRow')?.friend_id).toBe('frA');
    expect(friendMetadata('frA')).toMatchObject({
      入金確認: '済',
      備考: '手動値を保持',
      __formaloo_friend_metadata_sync: {
        入金確認: {
          formId: 'fa1',
          rowId: 'paidRow',
          formalooFieldKey: PAYMENT_FIELD,
          value: '済',
        },
      },
    });
  });

  test('friend-link kill-switch 中は valid token でも friend.metadata を変更しない', async () => {
    seedMappedForm('fa1', 'GMOxoMtK');
    const before = { 入金確認: '未', 備考: '手動値を保持' };
    seedFriend('frA', before);
    const row = await signedMappedRow('disabledRow', 'frA', '済');
    stubFormaloo((page) => (page === 1 ? [row] : []));

    const res = await call('GET', '/api/forms-advanced/fa1/rows', {
      FORMALOO_FRIEND_TOKEN_SECRET: FRIEND_TOKEN_SECRET,
      FORMALOO_RECONCILE_FRIEND_LINK_DISABLE: 'true',
    });

    expect(res.status).toBe(200);
    expect(mirrorRow('disabledRow')?.friend_id).toBeNull();
    expect(friendMetadata('frA')).toEqual(before);
  });
});

// ── T-A2: reconcile 後も検索/ソート/ページングが効く ──
describe('T-A2 reconcile 後の q/sort/paging 保持', () => {
  beforeEach(() => {
    seedForm('fa1', 'GMOxoMtK');
    stubFormaloo((p) => (p === 1 ? [
      realRow('slugA', 'scA', { name: '田中' }, '2026-07-01T10:00:00.000000'),
      realRow('slugB', 'scB', { name: '鈴木' }, '2026-07-05T10:00:00.000000'),
      realRow('slugC', 'scC', { name: '田中太郎' }, '2026-07-09T10:00:00.000000'),
    ] : []));
  });
  test('q フィルタが reconcile 済ミラーに効く', async () => {
    const d = (await (await call('GET', '/api/forms-advanced/fa1/rows?q=田中')).json() as { data: { total: number } }).data;
    expect(d.total).toBe(2);
  });
  test('sort=asc + paging が効く', async () => {
    const d = (await (await call('GET', '/api/forms-advanced/fa1/rows?sort=asc&pageSize=2&page=1')).json() as { data: { rows: Array<{ id: string }>; total: number } }).data;
    expect(d.rows.map((r) => r.id)).toEqual(['slugA', 'slugB']);
    expect(d.total).toBe(3);
    const p2 = (await (await call('GET', '/api/forms-advanced/fa1/rows?sort=asc&pageSize=2&page=2')).json() as { data: { rows: Array<{ id: string }> } }).data;
    expect(p2.rows.map((r) => r.id)).toEqual(['slugC']);
  });
});

// ── T-A3: fail-soft (client null / 非2xx / 空 / 例外 → ミラーそのまま) ──
describe('T-A3 fail-soft (現行非退行)', () => {
  test('client null (鍵未配備) → Formaloo を叩かずミラーを返す', async () => {
    seedForm('fa1', 'GMOxoMtK');
    seedSub('m1', 'fa1', { name: 'ミラー既存' }, '2026-07-01T10:00:00+09:00');
    const calls = stubFormaloo(() => [realRow('slugA', 'scA', { name: 'live' }, '2026-07-17T10:00:00.000000')]);
    const res = await call('GET', '/api/forms-advanced/fa1/rows', { FORMALOO_API_KEY: undefined, FORMALOO_API_SECRET: undefined });
    expect(res.status).toBe(200);
    const d = (await res.json() as { data: { rows: Array<{ id: string }>; total: number } }).data;
    expect(d.total).toBe(1);
    expect(d.rows[0].id).toBe('m1');
    expect(calls.filter((c) => /\/rows\/\?page=/.test(c.url)).length).toBe(0);
  });
  test('Formaloo 非 2xx → ミラーそのまま (500 で落ちない)', async () => {
    seedForm('fa1', 'GMOxoMtK');
    seedSub('m1', 'fa1', { name: 'ミラー既存' }, '2026-07-01T10:00:00+09:00');
    stubFormaloo(() => [], { listStatus: 500 });
    const res = await call('GET', '/api/forms-advanced/fa1/rows');
    expect(res.status).toBe(200);
    expect((await res.json() as { data: { total: number } }).data.total).toBe(1);
  });
  test('extractRows 空 → ミラーそのまま', async () => {
    seedForm('fa1', 'GMOxoMtK');
    seedSub('m1', 'fa1', { name: 'ミラー既存' }, '2026-07-01T10:00:00+09:00');
    stubFormaloo(() => []);
    const res = await call('GET', '/api/forms-advanced/fa1/rows');
    expect((await res.json() as { data: { total: number } }).data.total).toBe(1);
  });
  test('pull 中例外 (upsert throw) → 一覧は 500 でなくミラーを返す', async () => {
    seedForm('fa1', 'GMOxoMtK');
    seedSub('m1', 'fa1', { name: 'ミラー既存' }, '2026-07-01T10:00:00+09:00');
    stubFormaloo((p) => (p === 1 ? [realRow('slugA', 'scA', { name: 'live' }, '2026-07-17T10:00:00.000000')] : []));
    // upsert だけ throw する DB に差し替え (SELECT は素通し) → reconcile 例外 → fail-soft
    const res = await app().request('/api/forms-advanced/fa1/rows', {
      method: 'GET', headers: { Authorization: 'Bearer rc-owner-key' },
    }, env({ DB: d1ThrowingUpsert(raw) }));
    expect(res.status).toBe(200);
    expect((await res.json() as { data: { total: number } }).data.total).toBe(1);
  });
});

// ── T-A4: bounded page cap ──
describe('T-A4 bounded page cap (無限走査しない)', () => {
  test('rows が尽きない (毎ページ満杯) mock でも rows-list GET は cap 回で停止', async () => {
    seedForm('fa1', 'GMOxoMtK');
    // 各ページ 50 行 (満杯) を無限に返す → cap で止まる
    const calls = stubFormaloo((p) => Array.from({ length: 50 }, (_v, i) => realRow(`p${p}r${i}`, `sc${p}-${i}`, { n: `${p}-${i}` }, '2026-07-17T10:00:00.000000')));
    await call('GET', '/api/forms-advanced/fa1/rows');
    const listCalls = calls.filter((c) => /\/rows\/\?page=/.test(c.url)).length;
    expect(listCalls).toBeGreaterThan(1);
    expect(listCalls).toBeLessThanOrEqual(8); // MAX_RECONCILE_PAGES
  });
});

// ── T-A5: env flag で mirror-only へ即 rollback ──
describe('T-A5 FORMS_ADVANCED_ROWS_LIVE_RECONCILE_DISABLE', () => {
  test("='true' → Formaloo を一切叩かず (client.get 0) mirror-only を返す", async () => {
    seedForm('fa1', 'GMOxoMtK');
    seedSub('m1', 'fa1', { name: 'ミラーのみ' }, '2026-07-01T10:00:00+09:00');
    const calls = stubFormaloo(() => [realRow('slugA', 'scA', { name: 'live' }, '2026-07-17T10:00:00.000000')]);
    const res = await call('GET', '/api/forms-advanced/fa1/rows', { FORMS_ADVANCED_ROWS_LIVE_RECONCILE_DISABLE: 'true' });
    expect(res.status).toBe(200);
    const d = (await res.json() as { data: { rows: Array<{ id: string }>; total: number } }).data;
    expect(d.total).toBe(1);
    expect(d.rows[0].id).toBe('m1');
    expect(calls.length).toBe(0); // auth も rows-list も 0 (Formaloo 未接触)
    expect(mirrorCount('fa1')).toBe(1); // 充填していない
  });
});
