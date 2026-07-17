/**
 * form-edit-mail-link (弾L / T-B2·T-B3·T-B4·T-C2) — 公開編集ルート (worker-rendered HTML)。
 *   最重要 = 「編集 URL が他人の回答を開けない」(AC-1): 有効 token は指す 1 submission だけ / 改ざん・期限切れ・別鍵・
 *   epoch 不一致・OFF・row 削除は編集画面を出さず正直エラー。
 *   T-B2 save: 弾M 純関数 → flat PATCH → persist 確認成功のみ mirror 更新 / 非 persist は soft-200 を出さない。
 *   T-B3 allowlist: 現行 def の可視 free-value slug だけ PATCH (hidden/未知/choice/file は client が送っても drop)。
 *   T-B4: 開封時 live gate 再チェック / 失効 epoch / no-store・no-referrer / 楽観的排他 / 現行スキーマ解決。
 *   T-C2: free-value 編集可・choice/file read-only・必須空は保存停止・無効 token は正直エラー。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { permissionMiddleware } from '../middleware/permission-middleware.js';
import { formalooPublic } from './formaloo-public.js';
import { signEditToken, editTokenExp } from '../services/formaloo-edit-token.js';
import type { Env } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;
const EDIT_SECRET = 'edittok_route_secret';

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
    FORMALOO_API_KEY: 'fk', FORMALOO_API_SECRET: 'fs',
    FORMALOO_EDIT_TOKEN_SECRET: EDIT_SECRET,
  } as Env['Bindings'];
}

function app() {
  const a = new Hono<Env>();
  a.use('*', authMiddleware);
  a.use('*', permissionMiddleware);
  a.route('/', formalooPublic);
  return a;
}

interface FieldSpec { id: string; slug: string | null; type: string; label: string; required?: boolean }

/** allow_post_edit/allow_edit_mail/epoch + definition fields + field_map を持つ form を seed。 */
function seedForm(id: string, slug: string, fields: FieldSpec[], opts: { postEdit?: number; editMail?: number; epoch?: number } = {}) {
  const definition = JSON.stringify({
    fields: fields.map((f) => ({ id: f.id, type: f.type, label: f.label, required: f.required ?? false, config: {} })),
    logic: [],
  });
  raw.prepare(
    `INSERT INTO formaloo_forms (id, formaloo_slug, title, definition_json, builder_status, allow_post_edit, allow_edit_mail, edit_link_epoch)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(id, slug, 'テスト', definition, 'published', opts.postEdit ?? 1, opts.editMail ?? 1, opts.epoch ?? 0);
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    raw.prepare(
      `INSERT INTO formaloo_field_map (id, form_id, formaloo_field_slug, field_type, label, position, config_json, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?, '2026-07-17T00:00:00+09:00','2026-07-17T00:00:00+09:00')`,
    ).run(f.id, id, f.slug, f.type, f.label, i, '{}');
  }
}

function seedSubmission(id: string, formId: string, slug: string, answers: Record<string, unknown>, rowSlug: string | null, syncedAt = 'V1') {
  raw.prepare(
    `INSERT INTO formaloo_submissions (id, form_id, formaloo_slug, answers_json, submitted_at, synced_at, line_processed, verified, formaloo_row_slug)
     VALUES (?,?,?,?, '2026-07-17T00:00:00+09:00', ?, 1, 1, ?)`,
  ).run(id, formId, slug, JSON.stringify(answers), syncedAt, rowSlug);
}

async function mkToken(formId: string, rowRef: string, opts: { epoch?: number; expired?: boolean; secret?: string } = {}): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const exp = opts.expired ? nowSec - 10 : editTokenExp(nowSec, 30);
  const t = await signEditToken({ formId, rowRef, exp, epoch: opts.epoch ?? 0 }, opts.secret ?? EDIT_SECRET);
  return t!;
}

interface ApiCall { method: string; url: string; body: unknown }
function stubFormaloo(opts: { persist?: boolean } = {}): { calls: ApiCall[] } {
  const persist = opts.persist ?? true;
  const calls: ApiCall[] = [];
  const store: Record<string, Record<string, unknown>> = {};
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    try { body = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { body = undefined; }
    calls.push({ method, url, body });
    if (url.includes('/oauth2/authorization-token/') || url.includes('/authorization-token/')) {
      return new Response(JSON.stringify({ authorization_token: 'jwt' }), { status: 200 });
    }
    // rows-list (legacy resolver): /v3.0/forms/{slug}/rows/?... は空 list (row_slug は stored を使う)。
    if (method === 'GET' && /\/v3\.0\/forms\/[^/]+\/rows\/\?/.test(url)) {
      return new Response(JSON.stringify({ data: { rows: [] } }), { status: 200 });
    }
    // 単一 row PATCH/GET: client は HTTP body を .data に包む。実 Formaloo GET /v3.0/rows/{slug}/ の実応答
    // (closer live smoke 実測) は { data: { row: { data: <flat slug map>, readable_data, rendered_data } } }。
    // route は verifyRes.data.data.row.data の flat slug map を読む。旧 stub は { data: <flat> } と 1 階層浅く、
    // 実 API と乖離していたため persist 確認バグ (常に「保存できませんでした」) を検出できなかった (再発防止 pin)。
    const m = url.match(/\/v3\.0\/rows\/([^/]+)\/$/);
    if (m) {
      const slug = m[1];
      if (method === 'PATCH' && persist) {
        store[slug] = { ...(store[slug] ?? {}), ...(body as Record<string, unknown>) };
      }
      const rowData = store[slug] ?? {};
      return new Response(JSON.stringify({ data: { row: { data: rowData, readable_data: rowData, rendered_data: [] } } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  }));
  return { calls };
}

const FIELDS: FieldSpec[] = [
  { id: 'q_name', slug: 'name_slug', type: 'text', label: 'お名前', required: true },
  { id: 'q_mail', slug: 'mail_slug', type: 'email', label: 'メール' },
  { id: 'q_pick', slug: 'pick_slug', type: 'choice', label: '選択' },
];
const ANSWERS = { name_slug: '田中', mail_slug: 't@x.com', pick_slug: 'A' };

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});
afterEach(() => vi.unstubAllGlobals());

async function getFe(token: string) {
  return app().request(`/fe/${token}`, { method: 'GET' }, env());
}
async function saveFe(token: string, body: unknown) {
  return app().request(`/fe/${token}/save`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env());
}

describe('弾L 公開編集 — GET /fe/:token 開封 (T-B2 / T-C2 / AC-1)', () => {
  test('有効 token は指す submission の free-value を編集可・choice は read-only で描画', async () => {
    seedForm('f1', 'SLUG1', FIELDS);
    seedSubmission('sub1', 'f1', 'SLUG1', ANSWERS, 'ROW1');
    const res = await getFe(await mkToken('f1', 'sub1'));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('お名前');
    expect(html).toContain('田中');      // 現在値が入った編集フォーム
    expect(html).toContain('t@x.com');
    // choice は編集不可 (input name に pick_slug を持たない = 保存対象にならない)
    expect(html).not.toMatch(/name="pick_slug"/);
  });

  test('no-store + no-referrer ヘッダ (T-B4b token 漏洩面抑制)', async () => {
    seedForm('f1', 'SLUG1', FIELDS);
    seedSubmission('sub1', 'f1', 'SLUG1', ANSWERS, 'ROW1');
    const res = await getFe(await mkToken('f1', 'sub1'));
    expect(res.headers.get('Cache-Control')).toMatch(/no-store/);
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  });
});

describe('弾L 公開編集 — 他人の回答を開けない (AC-1 最重要 / T-B2)', () => {
  test('改ざん token は編集画面を出さず正直エラー (他 submission を load しない)', async () => {
    seedForm('f1', 'SLUG1', FIELDS);
    seedSubmission('sub1', 'f1', 'SLUG1', ANSWERS, 'ROW1');
    seedSubmission('victim', 'f1', 'SLUG1', { name_slug: '被害者' }, 'ROWV');
    const good = await mkToken('f1', 'sub1');
    const [payloadB64, sig] = good.split('.');
    const decoded = JSON.parse(Buffer.from(payloadB64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    decoded.r = 'victim';
    const tampered = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const res = await getFe(`${tampered}.${sig}`);
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain('被害者'); // 他人の回答を絶対に出さない
  });

  test('別鍵で署名した token は拒否', async () => {
    seedForm('f1', 'SLUG1', FIELDS);
    seedSubmission('sub1', 'f1', 'SLUG1', ANSWERS, 'ROW1');
    const res = await getFe(await mkToken('f1', 'sub1', { secret: 'ATTACKER_KEY' }));
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain('田中');
  });

  test('期限切れ token は拒否', async () => {
    seedForm('f1', 'SLUG1', FIELDS);
    seedSubmission('sub1', 'f1', 'SLUG1', ANSWERS, 'ROW1');
    const res = await getFe(await mkToken('f1', 'sub1', { expired: true }));
    expect(res.status).not.toBe(200);
  });

  test('未知 token / 区切り無しは拒否', async () => {
    const res = await getFe('garbage-no-dot');
    expect(res.status).not.toBe(200);
  });
});

describe('弾L 公開編集 — 開封時 live gate 再チェック (T-B4a / G-5)', () => {
  test('allow_edit_mail=0 は失効 (署名有効でも編集画面を出さない)', async () => {
    seedForm('f1', 'SLUG1', FIELDS, { editMail: 0 });
    seedSubmission('sub1', 'f1', 'SLUG1', ANSWERS, 'ROW1');
    const res = await getFe(await mkToken('f1', 'sub1'));
    expect(res.status).not.toBe(200);
  });

  test('allow_post_edit=0 は失効', async () => {
    seedForm('f1', 'SLUG1', FIELDS, { postEdit: 0 });
    seedSubmission('sub1', 'f1', 'SLUG1', ANSWERS, 'ROW1');
    const res = await getFe(await mkToken('f1', 'sub1'));
    expect(res.status).not.toBe(200);
  });

  test('epoch 不一致 (form が bump 済) は失効 = 既発行 URL 一括無効', async () => {
    seedForm('f1', 'SLUG1', FIELDS, { epoch: 1 }); // form 側 epoch=1
    seedSubmission('sub1', 'f1', 'SLUG1', ANSWERS, 'ROW1');
    const res = await getFe(await mkToken('f1', 'sub1', { epoch: 0 })); // 旧 epoch=0 の token
    expect(res.status).not.toBe(200);
  });

  test('epoch 一致は通る', async () => {
    seedForm('f1', 'SLUG1', FIELDS, { epoch: 2 });
    seedSubmission('sub1', 'f1', 'SLUG1', ANSWERS, 'ROW1');
    const res = await getFe(await mkToken('f1', 'sub1', { epoch: 2 }));
    expect(res.status).toBe(200);
  });

  test('row 削除後は失効 (submission 不在)', async () => {
    seedForm('f1', 'SLUG1', FIELDS);
    const res = await getFe(await mkToken('f1', 'missing_sub'));
    expect(res.status).not.toBe(200);
  });
});

describe('弾L 公開編集 — PATCH /fe/:token/save (T-B2 persist / T-C2)', () => {
  test('free-value 編集 → flat PATCH → persist 確認成功のみ mirror 更新', async () => {
    seedForm('f1', 'SLUG1', FIELDS);
    seedSubmission('sub1', 'f1', 'SLUG1', ANSWERS, 'ROW1');
    const { calls } = stubFormaloo({ persist: true });
    const res = await saveFe(await mkToken('f1', 'sub1'), { answers: { name_slug: '佐藤', mail_slug: 'new@x.com' }, version: 'V1' });
    expect(res.status).toBe(200);
    // Formaloo flat PATCH が row_slug 宛に呼ばれる (data ラッパ無しの top-level slug body)
    const patch = calls.find((c) => c.method === 'PATCH' && /\/v3\.0\/rows\/ROW1\//.test(c.url));
    expect(patch).toBeTruthy();
    expect(patch!.body).toMatchObject({ name_slug: '佐藤', mail_slug: 'new@x.com' });
    // mirror が更新される
    const mirror = raw.prepare('SELECT answers_json AS a FROM formaloo_submissions WHERE id=?').get('sub1') as { a: string };
    expect(JSON.parse(mirror.a).name_slug).toBe('佐藤');
  });

  test('persist 未確認 (Formaloo が反映しない) は 5xx・mirror を書かない (soft-200 禁止)', async () => {
    seedForm('f1', 'SLUG1', FIELDS);
    seedSubmission('sub1', 'f1', 'SLUG1', ANSWERS, 'ROW1');
    stubFormaloo({ persist: false });
    const res = await saveFe(await mkToken('f1', 'sub1'), { answers: { name_slug: '佐藤' }, version: 'V1' });
    expect(res.status).toBeGreaterThanOrEqual(500);
    const mirror = raw.prepare('SELECT answers_json AS a FROM formaloo_submissions WHERE id=?').get('sub1') as { a: string };
    expect(JSON.parse(mirror.a).name_slug).toBe('田中'); // 未更新
  });

  test('必須項目を空にする save は 400 (保存停止)', async () => {
    seedForm('f1', 'SLUG1', FIELDS);
    seedSubmission('sub1', 'f1', 'SLUG1', ANSWERS, 'ROW1');
    stubFormaloo();
    const res = await saveFe(await mkToken('f1', 'sub1'), { answers: { name_slug: '' }, version: 'V1' });
    expect(res.status).toBe(400);
  });

  test('無効 token の save は拒否 (Formaloo を叩かない)', async () => {
    seedForm('f1', 'SLUG1', FIELDS);
    seedSubmission('sub1', 'f1', 'SLUG1', ANSWERS, 'ROW1');
    const { calls } = stubFormaloo();
    const res = await saveFe(await mkToken('f1', 'sub1', { expired: true }), { answers: { name_slug: '佐藤' }, version: 'V1' });
    expect(res.status).not.toBe(200);
    expect(calls.find((c) => c.method === 'PATCH')).toBeFalsy();
  });
});

describe('弾L 公開編集 — server-side allowlist (T-B3 / G-2)', () => {
  test('hidden/未知/choice/file slug は client が送っても PATCH body に含めない', async () => {
    seedForm('f1', 'SLUG1', FIELDS);
    seedSubmission('sub1', 'f1', 'SLUG1', ANSWERS, 'ROW1');
    const { calls } = stubFormaloo();
    const res = await saveFe(await mkToken('f1', 'sub1'), {
      answers: {
        name_slug: '佐藤',        // free-value (許可)
        pick_slug: 'B',           // choice (除外)
        fr_id: 'ATTACKER',        // hidden/システム slug (def に無い = 除外)
        unknown_slug: 'x',        // 未知 (除外)
      },
      version: 'V1',
    });
    expect(res.status).toBe(200);
    const patch = calls.find((c) => c.method === 'PATCH');
    const body = patch!.body as Record<string, unknown>;
    expect(body).toHaveProperty('name_slug');
    expect(body).not.toHaveProperty('pick_slug');
    expect(body).not.toHaveProperty('fr_id');
    expect(body).not.toHaveProperty('unknown_slug');
  });
});

describe('弾L 公開編集 — 楽観的排他 (T-B4c / G-7)', () => {
  test('stale version の save は 409・Formaloo を叩かない (lost update 防止)', async () => {
    seedForm('f1', 'SLUG1', FIELDS);
    seedSubmission('sub1', 'f1', 'SLUG1', ANSWERS, 'ROW1', 'V_CURRENT');
    const { calls } = stubFormaloo();
    const res = await saveFe(await mkToken('f1', 'sub1'), { answers: { name_slug: '佐藤' }, version: 'V_STALE' });
    expect(res.status).toBe(409);
    expect(calls.find((c) => c.method === 'PATCH')).toBeFalsy();
  });
});

describe('弾L 公開編集 — 現行スキーマ解決 (T-B4d / G-9)', () => {
  test('token 発行後に def から消えた field は graceful drop (現行 def のみ編集対象)', async () => {
    // 現行 def は name_slug のみ (mail_slug は削除済) → mail の編集は drop、name は通る
    seedForm('f1', 'SLUG1', [{ id: 'q_name', slug: 'name_slug', type: 'text', label: 'お名前', required: true }]);
    seedSubmission('sub1', 'f1', 'SLUG1', ANSWERS, 'ROW1');
    const { calls } = stubFormaloo();
    const res = await saveFe(await mkToken('f1', 'sub1'), { answers: { name_slug: '佐藤', mail_slug: 'x@x.com' }, version: 'V1' });
    expect(res.status).toBe(200);
    const body = calls.find((c) => c.method === 'PATCH')!.body as Record<string, unknown>;
    expect(body).toHaveProperty('name_slug');
    expect(body).not.toHaveProperty('mail_slug'); // 現行 def に無い = drop
  });
});
