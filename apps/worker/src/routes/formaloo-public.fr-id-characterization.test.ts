/**
 * fr-id-capture-fix / T-B1 (codex#7): 実 /fo 経路の characterization test。
 *   spike は hosted URL に直 ?fr_id= を渡したため、実 /fo の friend 解決→署名→query 併合→encoding を通していない。
 *   本 test は実 /fo route (302 Location 合成) を通して以下の byte-invariant を固定する:
 *     - friend 解決 + secret → Location = hosted address ベース + 署名 fr_id (verifyFriendToken で復元可) + URLエンコード fr_name。
 *     - hosted address の既存 query は保持され (併合順)、予約 param (fr_id/fr_name) が後付けされる。
 *     - Unicode fr_name は percent-encode され decode で元に戻る (truncate/破損なし)。
 *     - friend 未解決 / secret 未設定 → prefill を付けない (生 address 直行 / fail-closed)。
 *   /fo・reconcile・webhook・friend-token は本 case で 1 byte も触らない (git diff 空を別途 D-3 で確認)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { permissionMiddleware } from '../middleware/permission-middleware.js';
import { formalooPublic } from './formaloo-public.js';
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

let raw: Database.Database;
let DB: D1Database;
const FRIEND_SECRET = 'frtok_char_test_secret';

function env(): Env['Bindings'] {
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'char-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
  } as Env['Bindings'];
}
function envWithSecret(): Env['Bindings'] {
  return { ...env(), FORMALOO_FRIEND_TOKEN_SECRET: FRIEND_SECRET } as Env['Bindings'];
}
function app() {
  const a = new Hono<Env>();
  a.use('*', authMiddleware);
  a.use('*', permissionMiddleware);
  a.route('/', formalooPublic);
  return a;
}
function seedFriend(id: string, displayName: string) {
  raw.prepare(`INSERT INTO friends (id, line_user_id, display_name) VALUES (?,?,?)`).run(id, `U_${id}`, displayName);
}
function seedFormWithAddress(id: string, address: string) {
  raw.prepare(
    `INSERT INTO formaloo_forms (id, formaloo_slug, title, builder_status, definition_json) VALUES (?,?,?,?,?)`,
  ).run(id, `slug_${id}`, 'テスト', 'published', JSON.stringify({ fields: [], logic: [], formalooAddress: address }));
}

beforeEach(() => { raw = new Database(':memory:'); replayAll(raw); DB = d1(raw); });
afterEach(() => raw.close());

describe('/fo/:id characterization (T-B1: 実 /fo の byte-invariant を固定)', () => {
  test('friend 解決 + secret → Location = address ベース + 署名 fr_id (verify 可) + URLエンコード fr_name', async () => {
    seedFriend('fr_1', '田中');
    seedFormWithAddress('fa1', 'https://formaloo.me/f/abc123');
    const res = await app().request('/fo/fa1?f=fr_1', { method: 'GET' }, envWithSecret());
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc.startsWith('https://formaloo.me/f/abc123')).toBe(true);
    const u = new URL(loc);
    expect(await verifyFriendToken(u.searchParams.get('fr_id'), FRIEND_SECRET)).toBe('fr_1');
    expect(u.searchParams.get('fr_name')).toBe('田中');
  });

  test('hosted address の既存 query を保持し (併合順) 予約 param を後付け', async () => {
    seedFriend('fr_2', '佐藤');
    seedFormWithAddress('fa2', 'https://formaloo.me/f/xyz?utm_source=line&lang=ja');
    const res = await app().request('/fo/fa2?f=fr_2', { method: 'GET' }, envWithSecret());
    const u = new URL(res.headers.get('location')!);
    // 既存 query は不変
    expect(u.searchParams.get('utm_source')).toBe('line');
    expect(u.searchParams.get('lang')).toBe('ja');
    // 予約 param が追加される (既存を潰さない)
    expect(await verifyFriendToken(u.searchParams.get('fr_id'), FRIEND_SECRET)).toBe('fr_2');
    expect(u.searchParams.get('fr_name')).toBe('佐藤');
  });

  test('Unicode/絵文字含む fr_name は percent-encode され decode で復元 (truncate/破損なし)', async () => {
    const name = '山田 花子👩‍🚀&=?';
    seedFriend('fr_3', name);
    seedFormWithAddress('fa3', 'https://formaloo.me/f/uni');
    const res = await app().request('/fo/fa3?f=fr_3', { method: 'GET' }, envWithSecret());
    const loc = res.headers.get('location')!;
    // 生 Location は percent-encoded (raw マルチバイト/予約文字が生では載らない)
    expect(loc).toContain('fr_name=%');
    // URL parse で decode すると元の名前に戻る
    expect(new URL(loc).searchParams.get('fr_name')).toBe(name);
  });

  test('friend 未解決 (?f= 無し) → prefill を付けない (生 address 直行 / fail-closed)', async () => {
    seedFormWithAddress('fa4', 'https://formaloo.me/f/none');
    const res = await app().request('/fo/fa4', { method: 'GET' }, envWithSecret());
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://formaloo.me/f/none');
  });

  test('secret 未設定 → prefill を付けない (生 address 直行 / rollback 相当)', async () => {
    seedFriend('fr_5', '鈴木');
    seedFormWithAddress('fa5', 'https://formaloo.me/f/nosec');
    const res = await app().request('/fo/fa5?f=fr_5', { method: 'GET' }, env());
    expect(res.headers.get('location')).toBe('https://formaloo.me/f/nosec');
  });
});
