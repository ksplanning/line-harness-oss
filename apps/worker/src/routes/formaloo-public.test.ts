/**
 * F-3 — Formaloo 公開 route (認証除外・自前 token 検証 / real SQLite)。
 *   T-C1: POST /formaloo/webhook/:token
 *     - path token 不正 → 401 (submission 書き込みなし / N-4)
 *     - 署名あり+不正 → 401 (spoof/replay 拒否 / N-12)
 *     - 有効 token + 有効署名 + published form → 冪等 upsert + verified=1 + LINE 後処理 1 回 (N-3)
 *     - 再送 (同 submission id) → submit_count 不変 = 二重発火なし (N-3)
 *     - 未署名 (token のみ) → 隔離: verified=0 / LINE 後処理なし (N-12)
 *   T-C3: draft form の回答 → LINE 後処理 0 件 (N-7 誤送信防止) / published のみ発火
 *   landmine#4: webhook は認証除外 route (Authorization ヘッダなしで 200 到達する)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { permissionMiddleware } from '../middleware/permission-middleware.js';
import { formalooPublic } from './formaloo-public.js';
import { buildSegmentWhere, type SegmentCondition } from '../services/segment-query.js';
import { verifyFriendToken } from '../services/formaloo-friend-token.js';
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

const TOKEN = 'wh-token-unguessable';
const SECRET = 'whsec_test';

let raw: Database.Database;
let DB: D1Database;

function env(): Env['Bindings'] {
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'env-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
    FORMALOO_WEBHOOK_TOKEN: TOKEN, FORMALOO_WEBHOOK_SECRET: SECRET,
  } as Env['Bindings'];
}

function app() {
  const a = new Hono<Env>();
  a.use('*', authMiddleware);
  a.use('*', permissionMiddleware);
  a.route('/', formalooPublic);
  return a;
}

// C2 順方向: fr_id 署名の専用 secret (既存 webhook secret とは別鍵)。
const FRIEND_SECRET = 'frtok_route_test_secret';
function envWithFriendSecret(): Env['Bindings'] {
  return { ...env(), FORMALOO_FRIEND_TOKEN_SECRET: FRIEND_SECRET } as Env['Bindings'];
}

// F-4: getFriendById (`SELECT * FROM friends WHERE id = ?`) だけを throw させる D1 (transient D1 検証)。
function d1ThrowOnFriendById(base: D1Database): D1Database {
  return {
    prepare(sql: string) {
      if (/FROM friends WHERE id\s*=\s*\?/i.test(sql)) {
        const api = {
          bind() { return api; },
          async first() { throw new Error('transient D1'); },
          async all() { throw new Error('transient D1'); },
          async run() { throw new Error('transient D1'); },
        };
        return api;
      }
      return base.prepare(sql);
    },
  } as unknown as D1Database;
}
function envThrowFriendById(): Env['Bindings'] {
  return { ...envWithFriendSecret(), DB: d1ThrowOnFriendById(DB) } as Env['Bindings'];
}

async function hmac(raw: string, ts?: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(ts ? `${ts}.${raw}` : raw));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function seedForm(id: string, slug: string, status: string, tagId: string | null) {
  raw.prepare(
    `INSERT INTO formaloo_forms (id, formaloo_slug, title, builder_status, on_submit_tag_id) VALUES (?,?,?,?,?)`,
  ).run(id, slug, 'テスト', status, tagId);
}
/** 開封リダイレクト用に formalooAddress 入り definition_json を持つ form を seed。 */
function seedFormWithAddress(id: string, status: string, address: string) {
  raw.prepare(
    `INSERT INTO formaloo_forms (id, formaloo_slug, title, builder_status, definition_json) VALUES (?,?,?,?,?)`,
  ).run(id, `slug_${id}`, 'テスト', status, JSON.stringify({ fields: [], logic: [], formalooAddress: address }));
}
function seedTag(id: string) {
  raw.prepare(`INSERT INTO tags (id, name, color, created_at) VALUES (?,?,?,?)`).run(id, 't', '#000', '2026-07-10T00:00:00+09:00');
}
// friend_tags は friends(id) への FK があり test は FK 有効 → tag 付与前に friend を実在させる
// (本番も /fo redirect の hidden field が実在 friend id を運ぶ前提)。
function seedFriend(id: string) {
  raw.prepare(`INSERT INTO friends (id, line_user_id, display_name) VALUES (?,?,?)`).run(id, `U_${id}`, '田中');
}

/** webhook を叩く。sign=true で有効 timestamp 署名 / signBad で不正署名 / 署名なしは unsigned。 */
async function postWebhook(
  token: string,
  payload: unknown,
  opts: { sign?: boolean; badSig?: boolean; ts?: string } = {},
) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const ts = opts.ts ?? new Date().toISOString();
  if (opts.sign) { headers['x-formaloo-signature'] = await hmac(body, ts); headers['x-formaloo-timestamp'] = ts; }
  if (opts.badSig) { headers['x-formaloo-signature'] = 'deadbeef'.repeat(8); headers['x-formaloo-timestamp'] = ts; }
  return app().request(`/formaloo/webhook/${token}`, { method: 'POST', headers, body }, env());
}

function payloadFor(subId: string, slug: string, friendId: string | null = 'fr_1') {
  const answers: Record<string, unknown> = { q1: '田中' };
  if (friendId) answers.friend_id = friendId;
  return { data: { slug: subId, form: { slug }, answers, created_at: '2026-07-10T08:59:00+09:00' } };
}

function tagCount(friendId: string, tagId: string): number {
  return (raw.prepare(`SELECT COUNT(*) n FROM friend_tags WHERE friend_id=? AND tag_id=?`).get(friendId, tagId) as { n: number }).n;
}
function sub(subId: string) {
  return raw.prepare(`SELECT * FROM formaloo_submissions WHERE id=?`).get(subId) as { verified: number; line_processed: number; form_id: string } | undefined;
}
function submitCount(formId: string): number {
  return (raw.prepare(`SELECT submit_count n FROM formaloo_forms WHERE id=?`).get(formId) as { n: number }).n;
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

describe('T-C1 webhook 認証 (認証除外 route / N-4)', () => {
  test('path token 不正 → 401 / submission 未書き込み', async () => {
    seedForm('fa1', 'form_abc', 'published', null);
    const res = await postWebhook('WRONG-TOKEN', payloadFor('sub_1', 'form_abc'), { sign: true });
    expect(res.status).toBe(401);
    expect(sub('sub_1')).toBeUndefined();
  });

  test('署名あり+不正 → 401 (spoof/replay 拒否 / N-12) / 未書き込み', async () => {
    seedForm('fa1', 'form_abc', 'published', null);
    const res = await postWebhook(TOKEN, payloadFor('sub_1', 'form_abc'), { badSig: true });
    expect(res.status).toBe(401);
    expect(sub('sub_1')).toBeUndefined();
  });

  test('Authorization ヘッダなしで 200 到達 (認証除外 landmine#4)', async () => {
    seedForm('fa1', 'form_abc', 'published', null);
    const res = await postWebhook(TOKEN, payloadFor('sub_1', 'form_abc'), { sign: true });
    expect(res.status).toBe(200);
  });
});

describe('T-C1/T-C3 冪等 upsert + LINE 後処理 (published のみ / N-3・N-7)', () => {
  test('有効 token+署名+published → upsert + verified=1 + tag 付与 + submit_count=1', async () => {
    seedTag('tag1');
    seedFriend('fr_1');
    seedForm('fa1', 'form_abc', 'published', 'tag1');
    const res = await postWebhook(TOKEN, payloadFor('sub_1', 'form_abc', 'fr_1'), { sign: true });
    expect(res.status).toBe(200);
    const s = sub('sub_1')!;
    expect(s.form_id).toBe('fa1');
    expect(s.verified).toBe(1);
    expect(s.line_processed).toBe(1);
    expect(tagCount('fr_1', 'tag1')).toBe(1);
    expect(submitCount('fa1')).toBe(1);
  });

  test('再送 (同 submission id) → submit_count 不変 = 二重発火なし (N-3)', async () => {
    seedTag('tag1');
    seedFriend('fr_1');
    seedForm('fa1', 'form_abc', 'published', 'tag1');
    await postWebhook(TOKEN, payloadFor('sub_1', 'form_abc', 'fr_1'), { sign: true });
    await postWebhook(TOKEN, payloadFor('sub_1', 'form_abc', 'fr_1'), { sign: true });
    expect(submitCount('fa1')).toBe(1);
    expect(tagCount('fr_1', 'tag1')).toBe(1);
  });

  test('ordered tag/field actions run once behind the existing submission claim', async () => {
    seedTag('tag1');
    raw.prepare(
      `INSERT INTO tags (id, name, color, created_at)
       VALUES ('tag2', 't2', '#000', '2026-07-10T00:00:00+09:00')`,
    ).run();
    seedFriend('fr_1');
    raw.prepare(
      `INSERT INTO friend_field_definitions (id, name, default_value)
       VALUES ('field-payment', '入金確認', '未')`,
    ).run();
    seedForm('fa-actions', 'form_actions', 'published', 'tag1');
    const actions = [
      { type: 'add_tag', tagId: 'tag1' },
      { type: 'remove_tag', tagId: 'tag1' },
      { type: 'add_tag', tagId: 'tag2' },
      { type: 'set_field', fieldId: 'field-payment', value: '済' },
      { type: 'clear_field', fieldId: 'field-payment' },
    ];
    raw.prepare(
      "UPDATE formaloo_forms SET on_submit_actions_json = ? WHERE id = 'fa-actions'",
    ).run(JSON.stringify(actions));

    await postWebhook(
      TOKEN,
      payloadFor('sub-actions', 'form_actions', 'fr_1'),
      { sign: true },
    );
    await postWebhook(
      TOKEN,
      payloadFor('sub-actions', 'form_actions', 'fr_1'),
      { sign: true },
    );

    expect(submitCount('fa-actions')).toBe(1);
    expect(raw.prepare(
      "SELECT tag_id FROM friend_tags WHERE friend_id = 'fr_1' ORDER BY tag_id",
    ).all()).toEqual([{ tag_id: 'tag2' }]);
    expect(JSON.parse(raw.prepare(
      "SELECT metadata FROM friends WHERE id = 'fr_1'",
    ).pluck().get() as string)).toMatchObject({ 入金確認: '' });
  });

  test('draft form の回答 → 隔離: tag なし / consume-at-receipt で line_processed=1 (N-7 / R1 F1)', async () => {
    seedTag('tag1');
    seedFriend('fr_1');
    seedForm('fa1', 'form_abc', 'draft', 'tag1');
    const res = await postWebhook(TOKEN, payloadFor('sub_1', 'form_abc', 'fr_1'), { sign: true });
    expect(res.status).toBe(200);
    // 発火不適格 (draft) → 消費確定 (line_processed=1)。後日 published でも claim 不可 = 昇格封鎖。
    expect(sub('sub_1')!.line_processed).toBe(1);
    expect(tagCount('fr_1', 'tag1')).toBe(0);
    expect(submitCount('fa1')).toBe(0);
  });

  test('未署名 (token のみ) → 隔離: verified=0 / consume-at-receipt で line_processed=1 (N-12 / R1 F1)', async () => {
    seedTag('tag1');
    seedFriend('fr_1');
    seedForm('fa1', 'form_abc', 'published', 'tag1');
    const res = await postWebhook(TOKEN, payloadFor('sub_1', 'form_abc', 'fr_1'));
    expect(res.status).toBe(200);
    const s = sub('sub_1')!;
    expect(s.verified).toBe(0);
    // 未署名隔離も消費確定 (発火せず line_processed=1)。以後の署名リプレイでも昇格しない。
    expect(s.line_processed).toBe(1);
    expect(tagCount('fr_1', 'tag1')).toBe(0);
  });

  test('R1 F1 昇格封鎖: draft 中に署名回答受信 → publish → 同 submission 再配信/リプレイでも発火しない', async () => {
    seedTag('tag1');
    seedFriend('fr_1');
    seedForm('fa1', 'form_abc', 'draft', 'tag1');
    // ① draft 中に署名済み回答を受信 → consume-at-receipt (発火なし / line_processed=1)
    await postWebhook(TOKEN, payloadFor('sub_1', 'form_abc', 'fr_1'), { sign: true });
    expect(sub('sub_1')!.line_processed).toBe(1);
    expect(tagCount('fr_1', 'tag1')).toBe(0);
    expect(submitCount('fa1')).toBe(0);
    // ② form を publish
    raw.prepare(`UPDATE formaloo_forms SET builder_status='published' WHERE id='fa1'`).run();
    // ③ 同一 submission を再配信 (リプレイ) → 消費済みで claim 不可 = 昇格しない
    await postWebhook(TOKEN, payloadFor('sub_1', 'form_abc', 'fr_1'), { sign: true });
    expect(submitCount('fa1')).toBe(0);
    expect(tagCount('fr_1', 'tag1')).toBe(0);
  });

  test('R1 F1 正常系: published+verified の新規回答は従来どおり 1 回発火する (退行なし)', async () => {
    seedTag('tag1');
    seedFriend('fr_1');
    seedForm('fa1', 'form_abc', 'published', 'tag1');
    await postWebhook(TOKEN, payloadFor('sub_9', 'form_abc', 'fr_1'), { sign: true });
    expect(sub('sub_9')!.line_processed).toBe(1);
    expect(submitCount('fa1')).toBe(1);
    expect(tagCount('fr_1', 'tag1')).toBe(1);
  });
});

// ── T-C2 開封リダイレクト (/fo/:id) ──
const ADDR = 'https://formaloo.me/f/abc123';
function opens(formId: string): { friend_id: string | null }[] {
  return raw.prepare(`SELECT friend_id FROM form_opens WHERE form_id=?`).all(formId) as { friend_id: string | null }[];
}
/** opened_form セグメントが実際にヒットする friend id を返す (G11 round-trip 実行)。 */
function openedFormMatches(cond: SegmentCondition): string[] {
  const { clause, bindings } = buildSegmentWhere(cond);
  const rows = raw.prepare(`SELECT f.id FROM friends f WHERE ${clause}`).all(...(bindings as never[])) as { id: string }[];
  return rows.map((r) => r.id);
}

// 弾M (form-post-edit / T-A4): webhook upsert が rowSlug を渡す (回帰 0)。
function rowSlugOf(subId: string): string | null {
  return (raw.prepare(`SELECT formaloo_row_slug AS v FROM formaloo_submissions WHERE id=?`).get(subId) as { v: string | null } | undefined)?.v ?? null;
}
/** real payload 形 (top-level submit_code=row id / form=文字列 form slug / slug=ROW slug)。 */
function realPayloadFor(submitCode: string, formSlug: string, rowSlug: string, friendId: string | null = 'fr_1') {
  const data: Record<string, unknown> = { q1: '田中' };
  if (friendId) data.friend_id = friendId;
  return { submit_code: submitCode, form: formSlug, slug: rowSlug, data, created_at: '2026-07-10T08:59:00+09:00' };
}

describe('T-A4 webhook upsert が rowSlug を渡す (弾M / 回帰 0)', () => {
  test('real 形 webhook → formaloo_row_slug が row slug で保存される', async () => {
    seedFriend('fr_1');
    seedForm('fa1', 'form_abc', 'published', null);
    const res = await postWebhook(TOKEN, realPayloadFor('ROW_1', 'form_abc', 'ROWSLUG_1', 'fr_1'), { sign: true });
    expect(res.status).toBe(200);
    const s = sub('ROW_1')!;
    expect(s.form_id).toBe('fa1'); // form slug (form 文字列) で台帳照合 = 回帰なし
    expect(rowSlugOf('ROW_1')).toBe('ROWSLUG_1');
  });

  test('legacy 形 webhook → formaloo_row_slug は NULL (回帰: 既存フローに row slug 無し)', async () => {
    seedFriend('fr_1');
    seedForm('fa1', 'form_abc', 'published', null);
    const res = await postWebhook(TOKEN, payloadFor('sub_leg', 'form_abc', 'fr_1'), { sign: true });
    expect(res.status).toBe(200);
    expect(sub('sub_leg')!.form_id).toBe('fa1');
    expect(rowSlugOf('sub_leg')).toBeNull();
  });
});

describe('D-3 structural answers direct webhook mirror', () => {
  test('署名 fr_id と matrix object / repeating array を route から D1 へそのまま保存する', async () => {
    seedFriend('frA');
    seedForm('fa1', 'form_abc', 'published', null);
    const friendToken = await import('../services/formaloo-friend-token.js')
      .then((module) => module.signFriendToken('frA', FRIEND_SECRET));
    const answers = {
      legacy_text: '従来値',
      matrix_slug: { service: 'good', speed: 'neutral' },
      repeat_slug: [
        { name: '田中', quantity: 2 },
        { name: '佐藤', quantity: 1 },
      ],
    };
    const payload = {
      submit_code: 'ROW_STRUCTURAL',
      form: 'form_abc',
      slug: 'ROWSLUG_STRUCTURAL',
      data: answers,
      rendered_data: [{ alias: 'fr_id', value: friendToken }],
      created_at: '2026-07-20T05:00:00+09:00',
    };
    const body = JSON.stringify(payload);
    const timestamp = new Date().toISOString();
    const res = await app().request(`/formaloo/webhook/${TOKEN}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-formaloo-signature': await hmac(body, timestamp),
        'x-formaloo-timestamp': timestamp,
      },
      body,
    }, envWithFriendSecret());

    expect(res.status).toBe(200);
    const mirrored = raw.prepare(
      `SELECT friend_id, answers_json, verified, formaloo_row_slug FROM formaloo_submissions WHERE id=?`,
    ).get('ROW_STRUCTURAL') as {
      friend_id: string | null;
      answers_json: string;
      verified: number;
      formaloo_row_slug: string | null;
    };
    expect(mirrored.friend_id).toBe('frA');
    expect(mirrored.verified).toBe(1);
    expect(mirrored.formaloo_row_slug).toBe('ROWSLUG_STRUCTURAL');
    expect(JSON.parse(mirrored.answers_json)).toEqual(answers);
  });
});

describe('T-C2 開封リダイレクト /fo/:id (G11 / 認証除外)', () => {
  test('published + ?f= → form_opens INSERT + 302 で Formaloo address へ (Authorization 不要)', async () => {
    seedFriend('fr_1');
    seedFormWithAddress('fa1', 'published', ADDR);
    const res = await app().request('/fo/fa1?f=fr_1', { method: 'GET' }, env());
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(ADDR);
    const rows = opens('fa1');
    expect(rows.length).toBe(1);
    expect(rows[0].friend_id).toBe('fr_1');
  });

  test('opened_form セグメントが /fo 記録をヒット (M-8 round-trip / 既存ルール無改修)', async () => {
    seedFriend('fr_1');
    seedFriend('fr_2'); // 開封していない対照
    seedFormWithAddress('fa1', 'published', ADDR);
    await app().request('/fo/fa1?f=fr_1', { method: 'GET' }, env());
    // form 指定なしの opened_form (任意フォームを開いた人)
    expect(openedFormMatches({ operator: 'AND', rules: [{ type: 'opened_form', value: { sinceDays: 365 } }] })).toEqual(['fr_1']);
    // form 指定つき (fa1 を開いた人)
    expect(openedFormMatches({ operator: 'AND', rules: [{ type: 'opened_form', value: { formId: 'fa1', sinceDays: 365 } }] })).toEqual(['fr_1']);
    // 別 form 指定 → ヒットなし
    expect(openedFormMatches({ operator: 'AND', rules: [{ type: 'opened_form', value: { formId: 'other', sinceDays: 365 } }] })).toEqual([]);
  });

  test('draft form → 404 / 開封記録なし (N-7 誤配信防止)', async () => {
    seedFriend('fr_1');
    seedFormWithAddress('fa1', 'draft', ADDR);
    const res = await app().request('/fo/fa1?f=fr_1', { method: 'GET' }, env());
    expect(res.status).toBe(404);
    expect(opens('fa1').length).toBe(0);
  });

  test('未知 form id → 404', async () => {
    const res = await app().request('/fo/nope', { method: 'GET' }, env());
    expect(res.status).toBe(404);
  });

  test('実在しない friend id は記録しない (opened_form 結合の無効化を防ぐ)', async () => {
    seedFormWithAddress('fa1', 'published', ADDR);
    const res = await app().request('/fo/fa1?f=ghost', { method: 'GET' }, env());
    expect(res.status).toBe(302);
    const rows = opens('fa1');
    expect(rows.length).toBe(1);
    expect(rows[0].friend_id).toBeNull();
  });
});

describe('T-A3 /fo/:id prefill 合成 (順方向 fr_id/fr_name)', () => {
  test('secret 設定時 ?f= は Location に署名 fr_id + URLエンコード fr_name を付与 (生 address 直行でない)', async () => {
    seedFriend('fr_1'); // display_name='田中'
    seedFormWithAddress('fa1', 'published', ADDR);
    const res = await app().request('/fo/fa1?f=fr_1', { method: 'GET' }, envWithFriendSecret());
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc).not.toBe(ADDR); // 生 address 直行でない
    expect(loc.startsWith(ADDR)).toBe(true);
    const u = new URL(loc);
    const frId = u.searchParams.get('fr_id');
    expect(frId).not.toBeNull();
    // 署名検証で friendId が復元できる (改ざん不可な形で埋め込まれている / R-F4)
    expect(await verifyFriendToken(frId, FRIEND_SECRET)).toBe('fr_1');
    // 表示名は URL エンコードして付与 (searchParams はデコード後の値 / 生 Location は %エンコード)
    expect(u.searchParams.get('fr_name')).toBe('田中');
    expect(loc).toContain('fr_name=%');
    // 開封記録は従来どおり付く (friend 解決済)
    expect(opens('fa1').length).toBe(1);
  });

  test('secret 未設定なら prefill を付けない (fail-closed = 生 address 直行 / rollback §plan6)', async () => {
    seedFriend('fr_1');
    seedFormWithAddress('fa1', 'published', ADDR);
    const res = await app().request('/fo/fa1?f=fr_1', { method: 'GET' }, env());
    expect(res.headers.get('location')).toBe(ADDR);
  });

  test('friend 未解決 (?f= 無し・非 in-app) は prefill を付けない (HP 経由相当 = fr_id 列が空になる)', async () => {
    seedFormWithAddress('fa1', 'published', ADDR);
    const res = await app().request('/fo/fa1', { method: 'GET' }, envWithFriendSecret());
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(ADDR);
  });
});

// 弾M (form-post-edit / T-C1): ②本人再入場 = /fo/:id が本人最新 row を field-slug query prefill。
function seedFormPostEdit(id: string, address: string, allowPostEdit: number) {
  raw.prepare(
    `INSERT INTO formaloo_forms (id, formaloo_slug, title, builder_status, definition_json, allow_post_edit) VALUES (?,?,?,?,?,?)`,
  ).run(id, `slug_${id}`, 'テスト', 'published', JSON.stringify({ fields: [], logic: [], formalooAddress: address }), allowPostEdit);
}
function seedSubRow(id: string, formId: string, friendId: string | null, answers: Record<string, unknown>, submittedAt: string) {
  raw.prepare(`INSERT INTO formaloo_submissions (id, form_id, friend_id, answers_json, submitted_at) VALUES (?,?,?,?,?)`)
    .run(id, formId, friendId, JSON.stringify(answers), submittedAt);
}
function postEditEnv() {
  return { ...envWithFriendSecret(), FORM_POST_EDIT_ENABLED: 'true' } as Env['Bindings'];
}

describe('T-C1 /fo/:id 本人再入場 prefill (allow_post_edit=1 / friend 厳密 / OFF byte 同等)', () => {
  test('allow_post_edit=1 + friend A → A 自身の最新 row を field-slug prefill・friend B の row は絶対出さない', async () => {
    seedFriend('frA'); seedFriend('frB');
    seedFormPostEdit('fa1', ADDR, 1);
    seedSubRow('a_old', 'fa1', 'frA', { nameSlug: 'A-OLD', ageSlug: '20' }, '2026-07-17T00:00:00+09:00');
    seedSubRow('a_new', 'fa1', 'frA', { nameSlug: 'A-NEW', ageSlug: '30' }, '2026-07-17T05:00:00+09:00');
    seedSubRow('b_row', 'fa1', 'frB', { nameSlug: 'B-VALUE' }, '2026-07-17T09:00:00+09:00');

    const res = await app().request('/fo/fa1?f=frA', { method: 'GET' }, postEditEnv());
    expect(res.status).toBe(302);
    const u = new URL(res.headers.get('location')!);
    // A の**最新** row (a_new) を prefill
    expect(u.searchParams.get('nameSlug')).toBe('A-NEW');
    expect(u.searchParams.get('ageSlug')).toBe('30');
    // 取り違え防止: B の値 (B-VALUE) を絶対に出さない
    expect(u.searchParams.get('nameSlug')).not.toBe('B-VALUE');
    // 署名 fr_id は従来どおり付く (answer prefill が上書きしない)
    expect(await verifyFriendToken(u.searchParams.get('fr_id'), FRIEND_SECRET)).toBe('frA');
  });

  test('friend B 再入場は B 自身の row のみ prefill (A の row を出さない)', async () => {
    seedFriend('frA'); seedFriend('frB');
    seedFormPostEdit('fa1', ADDR, 1);
    seedSubRow('a_new', 'fa1', 'frA', { nameSlug: 'A-NEW' }, '2026-07-17T05:00:00+09:00');
    seedSubRow('b_row', 'fa1', 'frB', { nameSlug: 'B-VALUE' }, '2026-07-17T09:00:00+09:00');
    const res = await app().request('/fo/fa1?f=frB', { method: 'GET' }, postEditEnv());
    const u = new URL(res.headers.get('location')!);
    expect(u.searchParams.get('nameSlug')).toBe('B-VALUE');
  });

  test('allow_post_edit=0 → answer prefill 無し (現状 fr_id/fr_name のみ = byte 同等)', async () => {
    seedFriend('frA');
    seedFormPostEdit('fa1', ADDR, 0);
    seedSubRow('a_new', 'fa1', 'frA', { nameSlug: 'A-NEW' }, '2026-07-17T05:00:00+09:00');
    const res = await app().request('/fo/fa1?f=frA', { method: 'GET' }, postEditEnv());
    const u = new URL(res.headers.get('location')!);
    expect(u.searchParams.get('nameSlug')).toBeNull(); // answer prefill 無し
    expect(await verifyFriendToken(u.searchParams.get('fr_id'), FRIEND_SECRET)).toBe('frA'); // fr_id は従来どおり
  });

  test('F-H1: FORMALOO_FRIEND_TOKEN_SECRET 未設定は署名不可 → 回答 prefill も fr_id も一切付かない (fail-closed)', async () => {
    seedFriend('frA');
    seedFormPostEdit('fa1', ADDR, 1);
    seedSubRow('a_new', 'fa1', 'frA', { nameSlug: 'A-NEW', ageSlug: '30' }, '2026-07-17T05:00:00+09:00');
    // env: allow_post_edit=1 + FORM_POST_EDIT_ENABLED=true だが FORMALOO_FRIEND_TOKEN_SECRET 無し (署名不可)
    const e = { ...env(), FORM_POST_EDIT_ENABLED: 'true' } as Env['Bindings'];
    const res = await app().request('/fo/fa1?f=frA', { method: 'GET' }, e);
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc).toBe(ADDR); // 生 URL へ degrade = PII prefill 一切なし
    const u = new URL(loc);
    expect(u.searchParams.get('nameSlug')).toBeNull(); // 回答 PII を載せない
    expect(u.searchParams.get('ageSlug')).toBeNull();
    expect(u.searchParams.get('fr_id')).toBeNull();     // fr_id も付かない (署名不可)
  });

  test('FORM_POST_EDIT_ENABLED 未設定 → answer prefill 無し (allow_post_edit=1 でも / env AND gate)', async () => {
    seedFriend('frA');
    seedFormPostEdit('fa1', ADDR, 1);
    seedSubRow('a_new', 'fa1', 'frA', { nameSlug: 'A-NEW' }, '2026-07-17T05:00:00+09:00');
    const res = await app().request('/fo/fa1?f=frA', { method: 'GET' }, envWithFriendSecret()); // env flag 無し
    const u = new URL(res.headers.get('location')!);
    expect(u.searchParams.get('nameSlug')).toBeNull();
  });

  test('OFF 経路は現状レスポンス byte 同等 (allow_post_edit=0 の Location が secret 有り現状挙動と一致)', async () => {
    seedFriend('frA');
    seedFormPostEdit('fa1', ADDR, 0);
    seedSubRow('a_new', 'fa1', 'frA', { nameSlug: 'A-NEW' }, '2026-07-17T05:00:00+09:00');
    // 現状挙動 (弾M 無関係の form) の Location を基準にして byte 同等を pin
    const res = await app().request('/fo/fa1?f=frA', { method: 'GET' }, postEditEnv());
    const loc = res.headers.get('location')!;
    // fr_id + fr_name のみ (answer slug は含まない)
    expect(loc).toContain('fr_id=');
    expect(loc).not.toContain('nameSlug=');
  });

  test('friend 未解決 (?f= 無し・非 in-app) は allow_post_edit=1 でも prefill 無し (取り違え防止の fail-closed)', async () => {
    seedFormPostEdit('fa1', ADDR, 1);
    seedSubRow('a_new', 'fa1', 'frA', { nameSlug: 'A-NEW' }, '2026-07-17T05:00:00+09:00');
    const res = await app().request('/fo/fa1', { method: 'GET' }, postEditEnv());
    expect(res.headers.get('location')).toBe(ADDR); // 生 address 直行 = prefill 一切なし
  });
});

describe('T-A4 /fo/:id LIFF 識別 (R-F2 / /t/:id と同型)', () => {
  test('in-app UA かつ friend 未解決 → LIFF へ 302 (redirect back = /fo/:id / 開封記録しない)', async () => {
    seedFormWithAddress('fa1', 'published', ADDR);
    const res = await app().request('/fo/fa1', { method: 'GET', headers: { 'user-agent': 'Mozilla/5.0 Line/13.0.0' } }, envWithFriendSecret());
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc.startsWith('https://liff.example.test')).toBe(true);
    expect(loc).toContain(encodeURIComponent('https://api.example.com/fo/fa1'));
    // friend 未特定の段階では form_opens に記録しない
    expect(opens('fa1').length).toBe(0);
  });

  test('F-1 round-trip: LIFF 復路 /fo/:id?lu= が friend を解決し Formaloo+fr_id へ 302 (再 LIFF せず=ループ閉じる)', async () => {
    seedFriend('fr_1'); // line_user_id='U_fr_1'
    seedFormWithAddress('fa1', 'published', ADDR);
    // hop1: bare /fo (in-app・未解決) → LIFF へ (redirect=/fo/fa1)。
    const hop1 = await app().request('/fo/fa1', { method: 'GET', headers: { 'user-agent': 'Line/13.0.0' } }, envWithFriendSecret());
    expect(hop1.status).toBe(302);
    expect(hop1.headers.get('location')!).toContain(encodeURIComponent('https://api.example.com/fo/fa1'));
    // hop3: LIFF client (appendLineUserToReturnUrl) が lu を付けて戻る → friend 解決 → Formaloo+fr_id へ 302。
    //        in-app UA でも lu があるので LIFF を再発火しない (無限ループが閉じる = F-1 の芯)。
    const hop3 = await app().request('/fo/fa1?lu=U_fr_1', { method: 'GET', headers: { 'user-agent': 'Line/13.0.0' } }, envWithFriendSecret());
    expect(hop3.status).toBe(302);
    const loc = hop3.headers.get('location')!;
    expect(loc.startsWith(ADDR)).toBe(true);
    expect(loc).not.toContain('liff'); // 再 LIFF していない (ループ終端)
    expect(await verifyFriendToken(new URL(loc).searchParams.get('fr_id'), FRIEND_SECRET)).toBe('fr_1');
    expect(opens('fa1').length).toBe(1); // hop3 で 1 回だけ開封記録 (hop1 の LIFF 段階では記録なし)
  });

  test('in-app UA でも ?f= 付きは LIFF せず Formaloo へ直行 + 開封記録 (既存 /t/:id と同型)', async () => {
    seedFriend('fr_1');
    seedFormWithAddress('fa1', 'published', ADDR);
    const res = await app().request('/fo/fa1?f=fr_1', { method: 'GET', headers: { 'user-agent': 'Line/13.0.0' } }, envWithFriendSecret());
    expect(res.status).toBe(302);
    expect(res.headers.get('location')!.startsWith(ADDR)).toBe(true);
    expect(opens('fa1').length).toBe(1);
  });

  test('非 in-app (通常ブラウザ) は friend 未解決でも LIFF せず従来どおり 302', async () => {
    seedFormWithAddress('fa1', 'published', ADDR);
    const res = await app().request('/fo/fa1', { method: 'GET', headers: { 'user-agent': 'Mozilla/5.0 (iPhone) Safari' } }, envWithFriendSecret());
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(ADDR);
  });

  test('LIFF_URL 未設定なら in-app 未解決でも LIFF せず従来どおり (dark-ship 安全)', async () => {
    seedFormWithAddress('fa1', 'published', ADDR);
    const e = { ...envWithFriendSecret(), LIFF_URL: '' } as Env['Bindings'];
    const res = await app().request('/fo/fa1', { method: 'GET', headers: { 'user-agent': 'Line/13.0.0' } }, e);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(ADDR);
  });
});

describe('F-5 /fo/:id per-account LIFF 解決', () => {
  test('form が account 束縛 + account に liff_id → LIFF は account 固有 (global でない)', async () => {
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, liff_id) VALUES ('acc-2','ch2','B','t','s','2000-XYZ')`).run();
    raw.prepare(`INSERT INTO formaloo_forms (id, formaloo_slug, title, builder_status, definition_json, line_account_id) VALUES ('fa2','slug_fa2','F','published',?,'acc-2')`)
      .run(JSON.stringify({ fields: [], logic: [], formalooAddress: ADDR }));
    const res = await app().request('/fo/fa2', { method: 'GET', headers: { 'user-agent': 'Line/13.0.0' } }, envWithFriendSecret());
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc.startsWith('https://liff.line.me/2000-XYZ')).toBe(true);
    expect(loc).toContain(encodeURIComponent('https://api.example.com/fo/fa2'));
  });

  test('CX-3: account 固有 LIFF は復路 URL に &liffId=<id> を同梱 (共有 client の detectLiffId が per-account LIFF で init / default VITE_LIFF_ID 誤 fallback を防ぐ・endpoint provisioning 非依存)', async () => {
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, liff_id) VALUES ('acc-2b','ch2b','B','t','s','2000-XYZ')`).run();
    raw.prepare(`INSERT INTO formaloo_forms (id, formaloo_slug, title, builder_status, definition_json, line_account_id) VALUES ('fa2b','slug_fa2b','F','published',?,'acc-2b')`)
      .run(JSON.stringify({ fields: [], logic: [], formalooAddress: ADDR }));
    const res = await app().request('/fo/fa2b', { method: 'GET', headers: { 'user-agent': 'Line/13.0.0' } }, envWithFriendSecret());
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc.startsWith('https://liff.line.me/2000-XYZ')).toBe(true);
    expect(loc).toContain('liffId=2000-XYZ'); // detectLiffId が ?liffId= から per-account LIFF を解決
  });

  test('account 束縛だが liff_id 無し → global LIFF_URL に fallback (liffId 同梱なし)', async () => {
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES ('acc-3','ch3','C','t','s')`).run();
    raw.prepare(`INSERT INTO formaloo_forms (id, formaloo_slug, title, builder_status, definition_json, line_account_id) VALUES ('fa3','slug_fa3','F','published',?,'acc-3')`)
      .run(JSON.stringify({ fields: [], logic: [], formalooAddress: ADDR }));
    const res = await app().request('/fo/fa3', { method: 'GET', headers: { 'user-agent': 'Line/13.0.0' } }, envWithFriendSecret());
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc.startsWith('https://liff.example.test')).toBe(true);
    expect(loc).not.toContain('liffId='); // global fallback は client の VITE_LIFF_ID(default) に任せる
  });

  test('account 未束縛 (line_account_id NULL) → global LIFF_URL (後方互換・liffId 同梱なし)', async () => {
    seedFormWithAddress('fa4', 'published', ADDR); // line_account_id NULL
    const res = await app().request('/fo/fa4', { method: 'GET', headers: { 'user-agent': 'Line/13.0.0' } }, envWithFriendSecret());
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc.startsWith('https://liff.example.test')).toBe(true);
    expect(loc).not.toContain('liffId=');
  });
});

describe('F-4 /fo/:id friend 解決 throw 時の fail-closed', () => {
  test('getFriendById throw → 未検証 ?f= を署名/記録せず生 URL へ (friendId null 確定)', async () => {
    seedFriend('fr_1');
    seedFormWithAddress('fa1', 'published', ADDR);
    const res = await app().request('/fo/fa1?f=fr_1', { method: 'GET' }, envThrowFriendById());
    expect(res.status).toBe(302);
    // 未検証 ID を署名しない → 生 address (fr_id 無し)
    expect(res.headers.get('location')).toBe(ADDR);
    // form_opens は friend_id null で記録 (未検証 ID を invariant 違反で INSERT しない)
    const rows = opens('fa1');
    expect(rows.length).toBe(1);
    expect(rows[0].friend_id).toBeNull();
  });
});

// ── BUG-1 /fo/:id one-shot loop-guard (_lfb マーカー / 無限リロード終端) ──
// LIFF から lu/friendId 無しで戻った異常経路 (getFriendship throw = bot 未リンク等) を、
// 復路マーカー `_lfb=1` で検知し「再 LIFF せず Formaloo へ直行 (匿名 degrade)」に落とす。
// これで LIFF 誤配線でも「無限リロード」ではなく「フォームは開く」に degrade する。
describe('BUG-1 /fo/:id one-shot loop-guard (_lfb=1)', () => {
  test('T-A1(AC1): ?_lfb=1 + LINE UA + lu/f 無し → 再 LIFF せず Formaloo へ 302 (location に liff 無し = ループ終端)', async () => {
    seedFormWithAddress('fa1', 'published', ADDR);
    const res = await app().request('/fo/fa1?_lfb=1', { method: 'GET', headers: { 'user-agent': 'Mozilla/5.0 Line/14.5.0' } }, envWithFriendSecret());
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc).toBe(ADDR); // 生 Formaloo address 直行 (匿名 degrade)
    expect(loc).not.toContain('liff'); // 再 LIFF していない = 無限ループの芯を断つ
    // 匿名 degrade は friend を解決せず form_opens を friend_id null で記録 (PII 非漏出・fr_id 無し)
    const rows = opens('fa1');
    expect(rows.length).toBe(1);
    expect(rows[0].friend_id).toBeNull();
    expect(new URL(loc).searchParams.get('fr_id')).toBeNull();
  });

  test('T-A2(AC2): bare /fo + LINE UA → LIFF へ 302・復路 redirect 値に _lfb=1 を含む (往路マーカー)', async () => {
    seedFormWithAddress('fa1', 'published', ADDR);
    const res = await app().request('/fo/fa1', { method: 'GET', headers: { 'user-agent': 'Line/14.5.0' } }, envWithFriendSecret());
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc.startsWith('https://liff.example.test')).toBe(true);
    // 復路 redirect param (decode 後) に one-shot マーカーが載る
    const back = new URL(loc).searchParams.get('redirect')!;
    expect(back).toContain('_lfb=1');
    expect(back).toContain('https://api.example.com/fo/fa1'); // worker 復路経路
    // 開封は friend 未特定段階では記録しない (既存 R-F2 挙動不変)
    expect(opens('fa1').length).toBe(0);
  });

  test('T-A3(AC3): ?lu=<uid> + LINE UA → friend 解決 → Formaloo+fr_id へ 302・再 LIFF しない (F-1 round-trip 回帰)', async () => {
    seedFriend('fr_1'); // line_user_id='U_fr_1'
    seedFormWithAddress('fa1', 'published', ADDR);
    const res = await app().request('/fo/fa1?lu=U_fr_1', { method: 'GET', headers: { 'user-agent': 'Line/14.5.0' } }, envWithFriendSecret());
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc.startsWith(ADDR)).toBe(true);
    expect(loc).not.toContain('liff'); // 成功系は再 LIFF しない (ループ終端)
    expect(await verifyFriendToken(new URL(loc).searchParams.get('fr_id'), FRIEND_SECRET)).toBe('fr_1');
    expect(opens('fa1').length).toBe(1);
  });

  test('T-A3b: ?lu=<uid>&_lfb=1 (LIFF が両 param を carry) でも lu 経路が勝ち friend 解決 → 再 LIFF しない (正常経路は _lfb に非依存)', async () => {
    seedFriend('fr_1');
    seedFormWithAddress('fa1', 'published', ADDR);
    const res = await app().request('/fo/fa1?lu=U_fr_1&_lfb=1', { method: 'GET', headers: { 'user-agent': 'Line/14.5.0' } }, envWithFriendSecret());
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc.startsWith(ADDR)).toBe(true);
    expect(loc).not.toContain('liff');
    expect(await verifyFriendToken(new URL(loc).searchParams.get('fr_id'), FRIEND_SECRET)).toBe('fr_1');
  });

  test('T-A2b: per-account LIFF でも復路 redirect に _lfb=1 と &liffId= が両立 (CX-3 非退行)', async () => {
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, liff_id) VALUES ('acc-lfb','chlfb','B','t','s','2000-XYZ')`).run();
    raw.prepare(`INSERT INTO formaloo_forms (id, formaloo_slug, title, builder_status, definition_json, line_account_id) VALUES ('fa_lfb','slug_fa_lfb','F','published',?,'acc-lfb')`)
      .run(JSON.stringify({ fields: [], logic: [], formalooAddress: ADDR }));
    const res = await app().request('/fo/fa_lfb', { method: 'GET', headers: { 'user-agent': 'Line/14.5.0' } }, envWithFriendSecret());
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc.startsWith('https://liff.line.me/2000-XYZ')).toBe(true);
    expect(loc).toContain('liffId=2000-XYZ'); // per-account 解決は不変
    expect(new URL(loc).searchParams.get('redirect')).toContain('_lfb=1'); // マーカー同梱
  });
});

// =============================================================================
// line-reentry-prefill-fix (Layer A / C3 / T-A6·D-7) — /fo 再入場 targeted pull (CI-1 の解消)。
//   reconcile は admin `/rows` GET でしか発火しないため、/fo 再入場の prefill lookup 直前に対象 form の
//   直近 rows を bounded pull → 署名 fr_id を verify して friend_id 復元 → mirror を埋めてから引く。
//   hot path 保護 (D-7): gate 全通過時のみ pull・失敗は prefill 無しで 302 (fail-soft)。
// =============================================================================

/** Formaloo API を stub する env (targeted pull が実 client を解決できるよう KEY/SECRET を供給)。 */
function pullEnv() {
  return { ...postEditEnv(), FORMALOO_API_KEY: 'k_test', FORMALOO_API_SECRET: 's_test' } as Env['Bindings'];
}

/**
 * global.fetch を stub。auth (oauth2) は token を返し、rows GET は `rowsData` を返す。
 * rowsGetSpy で rows GET が呼ばれたか観測できる (gate-off で pull しないことの検証に使う)。
 */
function stubFormalooFetch(rowsData: unknown, opts: { rowsStatus?: number } = {}) {
  const rowsGetSpy = vi.fn();
  const impl = async (input: RequestInfo | URL) => {
    const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (urlStr.includes('/oauth2/authorization-token/')) {
      return new Response(JSON.stringify({ authorization_token: 'tok_test' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (urlStr.includes('/rows/')) {
      rowsGetSpy(urlStr);
      const status = opts.rowsStatus ?? 200;
      return new Response(JSON.stringify(rowsData), { status, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  vi.stubGlobal('fetch', vi.fn(impl));
  return rowsGetSpy;
}

describe('T-A6/D-7 /fo/:id 再入場 targeted pull (CI-1 解消 / hot path fail-soft)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  test('T-A5: mirror 未充填でも targeted pull が署名 fr_id を verify→friend_id 復元→本人 row を prefill', async () => {
    seedFriend('frA');
    seedFormPostEdit('fa1', ADDR, 1);
    // mirror に friend row を **seed しない** (pull が埋めることを証明)。
    const token = await import('../services/formaloo-friend-token.js').then((m) => m.signFriendToken('frA', FRIEND_SECRET));
    const rowsData = { data: { rows: [
      { slug: 'PULLEDROW', created_at: '2026-07-18T05:00:00+09:00', data: { q1: 'PULLED' }, rendered_data: [{ slug: 'x', alias: 'fr_id', value: token }] },
    ] } };
    stubFormalooFetch(rowsData);

    const res = await app().request('/fo/fa1?f=frA', { method: 'GET' }, pullEnv());
    expect(res.status).toBe(302);
    const u = new URL(res.headers.get('location')!);
    expect(u.searchParams.get('q1')).toBe('PULLED'); // pull が friend_id を復元し本人 row を prefill
    expect(await verifyFriendToken(u.searchParams.get('fr_id'), FRIEND_SECRET)).toBe('frA');
    // mirror に friend_id=frA 行が実在 (pull が upsert したことの地面確認)
    const row = raw.prepare(`SELECT friend_id, id FROM formaloo_submissions WHERE form_id='fa1' AND friend_id='frA'`).get() as { friend_id: string; id: string } | undefined;
    expect(row?.friend_id).toBe('frA');
    expect(row?.id).toBe('PULLEDROW');
  });

  test('D-7: 改ざん fr_id 行を pull しても friend_id 復元せず prefill 無し (PII fail-closed / mirror 汚染なし)', async () => {
    seedFriend('frA');
    seedFormPostEdit('fa1', ADDR, 1);
    const token = (await import('../services/formaloo-friend-token.js').then((m) => m.signFriendToken('frA', FRIEND_SECRET)))!;
    const tampered = token.slice(0, -1) + (token.slice(-1) === 'a' ? 'b' : 'a');
    const rowsData = { data: { rows: [
      { slug: 'BADROW', created_at: '2026-07-18T05:00:00+09:00', data: { q1: 'LEAK' }, rendered_data: [{ alias: 'fr_id', value: tampered }] },
    ] } };
    stubFormalooFetch(rowsData);

    const res = await app().request('/fo/fa1?f=frA', { method: 'GET' }, pullEnv());
    expect(res.status).toBe(302);
    const u = new URL(res.headers.get('location')!);
    expect(u.searchParams.get('q1')).toBeNull(); // 他人/未検証の回答を絶対に prefill しない
    // mirror 行は入るが friend_id は NULL (verify 失敗) = getFriendLatestSubmission が引かない
    const linked = raw.prepare(`SELECT COUNT(*) n FROM formaloo_submissions WHERE form_id='fa1' AND friend_id='frA'`).get() as { n: number };
    expect(linked.n).toBe(0);
  });

  test('D-7: gate OFF (allow_post_edit=0) では targeted pull を一切呼ばない (byte 同等・hot path 保護)', async () => {
    seedFriend('frA');
    seedFormPostEdit('fa1', ADDR, 0);
    const rowsGetSpy = stubFormalooFetch({ data: { rows: [] } });
    const res = await app().request('/fo/fa1?f=frA', { method: 'GET' }, pullEnv());
    expect(res.status).toBe(302);
    expect(rowsGetSpy).not.toHaveBeenCalled(); // gate OFF = Formaloo を叩かない
  });

  test('D-7: rows GET が非2xx でも 302 で degrade (prefill 無し・crash しない)', async () => {
    seedFriend('frA');
    seedFormPostEdit('fa1', ADDR, 1);
    stubFormalooFetch({ error: 'boom' }, { rowsStatus: 500 });
    const res = await app().request('/fo/fa1?f=frA', { method: 'GET' }, pullEnv());
    expect(res.status).toBe(302); // fail-soft: pull 失敗でも 302
    const u = new URL(res.headers.get('location')!);
    expect(u.searchParams.get('q1')).toBeNull();
    expect(await verifyFriendToken(u.searchParams.get('fr_id'), FRIEND_SECRET)).toBe('frA'); // fr_id は付く
  });

  test('D-6: FORMALOO_RECONCILE_FRIEND_LINK_DISABLE=true は pull しても friend_id 復元しない (prefill 無し)', async () => {
    seedFriend('frA');
    seedFormPostEdit('fa1', ADDR, 1);
    const token = await import('../services/formaloo-friend-token.js').then((m) => m.signFriendToken('frA', FRIEND_SECRET));
    stubFormalooFetch({ data: { rows: [
      { slug: 'R1', created_at: '2026-07-18T05:00:00+09:00', data: { q1: 'PULLED' }, rendered_data: [{ alias: 'fr_id', value: token }] },
    ] } });
    const e = { ...pullEnv(), FORMALOO_RECONCILE_FRIEND_LINK_DISABLE: 'true' } as Env['Bindings'];
    const res = await app().request('/fo/fa1?f=frA', { method: 'GET' }, e);
    expect(res.status).toBe(302);
    const u = new URL(res.headers.get('location')!);
    expect(u.searchParams.get('q1')).toBeNull(); // 復元停止 = prefill 無し
  });

  test('D-2 回帰: in-app 未解決 (_lfb 無し) は pull せず LIFF へ 302 (loop-guard 経路 byte 不変)', async () => {
    seedFormPostEdit('fa1', ADDR, 1);
    const rowsGetSpy = stubFormalooFetch({ data: { rows: [] } });
    const res = await app().request('/fo/fa1', { method: 'GET', headers: { 'user-agent': 'Line/13.0.0' } }, pullEnv());
    expect(res.status).toBe(302);
    expect(res.headers.get('location')!).toContain('liff'); // LIFF へ (friend 未解決)
    expect(rowsGetSpy).not.toHaveBeenCalled(); // friend 未解決 = pull しない
  });
});
