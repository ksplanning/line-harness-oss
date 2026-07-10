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
import { describe, expect, test, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { permissionMiddleware } from '../middleware/permission-middleware.js';
import { formalooPublic } from './formaloo-public.js';
import { buildSegmentWhere, type SegmentCondition } from '../services/segment-query.js';
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
