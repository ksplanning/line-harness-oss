/**
 * treasure-b2-form-settings / D-3 — /fo/:id の UTM hidden-field prefill。
 *
 * Red contract:
 * - operationsSettings.utmTracking が未設定/false のフォームは、UTM query を受けても従来 Location と byte 同一。
 * - true のフォームだけ、exact 3 aliases を hosted URL へ渡す。friend 解決や署名 secret の有無とは独立。
 * - LINE/LIFF 往復でも nested redirect に UTM を保持し、任意 query は第三者 hosted URL へ流さない。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { permissionMiddleware } from '../middleware/permission-middleware.js';
import { verifyFriendToken } from '../services/formaloo-friend-token.js';
import { formalooPublic } from './formaloo-public.js';
import type { Env } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;
const HOSTED = 'https://formaloo.me/f/utm-case';
const FRIEND_SECRET = 'utm_friend_token_secret';

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
        async run() {
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
    const statements = readFileSync(join(DB_ROOT, 'migrations', file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/)
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) {
      try {
        db.exec(statement);
      } catch (error) {
        if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
  }
}

let raw: Database.Database;
let DB: D1Database;

function env(withFriendSecret = false): Env['Bindings'] {
  return {
    DB,
    IMAGES: {} as R2Bucket,
    ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 'line-secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    API_KEY: 'owner-key',
    LIFF_URL: 'https://liff.example.test',
    LINE_CHANNEL_ID: 'channel',
    LINE_LOGIN_CHANNEL_ID: 'login-channel',
    LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
    WORKER_URL: 'https://api.example.com',
    ...(withFriendSecret ? { FORMALOO_FRIEND_TOKEN_SECRET: FRIEND_SECRET } : {}),
  } as Env['Bindings'];
}

function app() {
  const instance = new Hono<Env>();
  instance.use('*', authMiddleware);
  instance.use('*', permissionMiddleware);
  instance.route('/', formalooPublic);
  return instance;
}

function seedForm(id: string, utmTracking: boolean | undefined) {
  const definition = {
    fields: [],
    logic: [],
    formalooAddress: HOSTED,
    ...(utmTracking === undefined ? {} : { operationsSettings: { utmTracking } }),
  };
  raw.prepare(
    'INSERT INTO formaloo_forms (id, formaloo_slug, title, builder_status, definition_json) VALUES (?,?,?,?,?)',
  ).run(id, `slug_${id}`, 'UTM test', 'published', JSON.stringify(definition));
}

function seedFriend(id: string, displayName: string) {
  raw.prepare('INSERT INTO friends (id, line_user_id, display_name) VALUES (?,?,?)')
    .run(id, `U_${id}`, displayName);
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

afterEach(() => raw.close());

describe('/fo/:id UTM prefill — default OFF / exact aliases', () => {
  test.each([
    ['未設定', undefined],
    ['明示 OFF', false],
  ] as const)('%s は UTM query を受けても Location が従来 byte と同一', async (_label, utmTracking) => {
    seedForm('off', utmTracking);

    const response = await app().request(
      '/fo/off?utm_source=line&utm_medium=broadcast&utm_campaign=summer&unknown=do-not-forward',
      { method: 'GET' },
      env(),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(HOSTED);
  });

  test('ON は匿名・friend secret 未設定でも3 UTMだけを hosted alias prefillへ渡す', async () => {
    seedForm('on-anon', true);

    const response = await app().request(
      '/fo/on-anon?utm_source=line&utm_medium=broadcast&utm_campaign=summer&unknown=do-not-forward',
      { method: 'GET' },
      env(),
    );

    expect(response.status).toBe(302);
    const hosted = new URL(response.headers.get('location')!);
    expect(Object.fromEntries(hosted.searchParams.entries())).toEqual({
      utm_source: 'line',
      utm_medium: 'broadcast',
      utm_campaign: 'summer',
    });
    expect(hosted.searchParams.get('unknown')).toBeNull();
    expect(hosted.searchParams.get('f')).toBeNull();
    expect(hosted.searchParams.get('lu')).toBeNull();
    expect(hosted.searchParams.get('_lfb')).toBeNull();
  });

  test('ON は3 UTMと既存の署名 fr_id/fr_name prefillを同時に保持する', async () => {
    seedForm('on-friend', true);
    seedFriend('friend-1', '田中');

    const response = await app().request(
      '/fo/on-friend?f=friend-1&utm_source=line&utm_medium=message&utm_campaign=launch&unknown=nope',
      { method: 'GET' },
      env(true),
    );

    expect(response.status).toBe(302);
    const hosted = new URL(response.headers.get('location')!);
    expect(hosted.searchParams.get('utm_source')).toBe('line');
    expect(hosted.searchParams.get('utm_medium')).toBe('message');
    expect(hosted.searchParams.get('utm_campaign')).toBe('launch');
    expect(await verifyFriendToken(hosted.searchParams.get('fr_id'), FRIEND_SECRET)).toBe('friend-1');
    expect(hosted.searchParams.get('fr_name')).toBe('田中');
    expect(hosted.searchParams.get('f')).toBeNull();
    expect(hosted.searchParams.get('unknown')).toBeNull();
  });
});

describe('/fo/:id UTM prefill — LINE/LIFF round trip', () => {
  test('ON は LIFF nested復路に3 UTMをcarryし、unknown queryはcarryしない', async () => {
    seedForm('on-liff', true);

    const response = await app().request(
      '/fo/on-liff?utm_source=line&utm_medium=liff&utm_campaign=roundtrip&unknown=do-not-carry',
      { method: 'GET', headers: { 'user-agent': 'Mozilla/5.0 Line/13.0.0' } },
      env(),
    );

    expect(response.status).toBe(302);
    const liff = new URL(response.headers.get('location')!);
    expect(liff.origin).toBe('https://liff.example.test');
    const nested = new URL(liff.searchParams.get('redirect')!);
    expect(nested.origin).toBe('https://api.example.com');
    expect(nested.pathname).toBe('/fo/on-liff');
    expect(nested.searchParams.get('_lfb')).toBe('1');
    expect(nested.searchParams.get('utm_source')).toBe('line');
    expect(nested.searchParams.get('utm_medium')).toBe('liff');
    expect(nested.searchParams.get('utm_campaign')).toBe('roundtrip');
    expect(nested.searchParams.get('unknown')).toBeNull();
  });
});
