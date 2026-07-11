/**
 * T-A3 (F6-1) — resolveFormalooClient (async / 多鍵) の分岐検証。
 *   ① 登録 workspace (D1 暗号文 + mock KEK) → 復号済 KEY/SECRET を持つ client
 *   ② workspaceId=null → env 単一鍵 fallback。かつ **DB.prepare 未呼出** + FORMALOO_KEK undefined でも動作
 *      (D1/KEK 非接触短絡 = byte-equivalent / Codex gap #8)
 *   ③ workspaceId 指定だが未登録 → null (env 鍵へ silent fallback しない / Codex gap #1)
 *   ④ 登録済だが復号失敗 (KEK 不一致) → null (env 鍵へ silent fallback しない / Codex gap #1)
 * ③④ とも env に鍵があっても null = 別 workspace への誤送信を構造的に防ぐ。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import { resolveFormalooClient } from './formaloo-client.js';
import { encryptSecret, formalooFieldAad } from './formaloo-crypto.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;
const KEK = Buffer.from(new Uint8Array(32).fill(9)).toString('base64');
const KEK_WRONG = Buffer.from(new Uint8Array(32).fill(3)).toString('base64');

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(DB_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(DB_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      try { db.exec(stmt); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

/** D1 shim。prepare を prepareSpy で包み、呼び出し有無を観測できるようにする。 */
function d1(db: Database.Database, prepareSpy: ReturnType<typeof vi.fn>): D1Database {
  return {
    prepare(sql: string) {
      prepareSpy(sql);
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

let raw: Database.Database;
let prepareSpy: ReturnType<typeof vi.fn>;
let DB: D1Database;

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  prepareSpy = vi.fn();
  DB = d1(raw, prepareSpy);
});
afterEach(() => { vi.unstubAllGlobals(); });

async function seedWorkspace(id: string, apiKey: string, apiSecret: string, kek = KEK) {
  const kc = await encryptSecret(kek, apiKey, formalooFieldAad(id, 'key'));
  const sc = await encryptSecret(kek, apiSecret, formalooFieldAad(id, 'secret'));
  raw.prepare(
    `INSERT INTO formaloo_workspaces (id, label, key_ciphertext, key_iv, secret_ciphertext, secret_iv)
     VALUES (?,?,?,?,?,?)`,
  ).run(id, 'L', kc.ciphertext, kc.iv, sc.ciphertext, sc.iv);
}

/** globalThis.fetch を stub し、oauth/GET 呼び出しのヘッダを記録する。 */
function stubFetch(): { calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url: String(url), headers });
    if (String(url).includes('authorization-token')) {
      return new Response(JSON.stringify({ authorization_token: 'jwt-token' }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  }));
  return { calls };
}

describe('T-A3 ① 登録 workspace → 復号済 client', () => {
  test('D1 暗号文を KEK で復号し、その KEY/SECRET を持つ client を返す', async () => {
    await seedWorkspace('ws-uniq-1', 'the-decrypted-key', 'the-decrypted-secret');
    const { calls } = stubFetch();
    const env = { FORMALOO_API_KEY: 'env-key', FORMALOO_API_SECRET: 'env-secret', FORMALOO_KEK: KEK, DB };
    const client = await resolveFormalooClient(env, 'ws-uniq-1');
    expect(client).not.toBeNull();
    // client を動かすと、復号済み (env でなく登録) の鍵で認証する。
    await client!.get('/v3.0/forms/');
    const oauth = calls.find((c) => c.url.includes('authorization-token'))!;
    expect(oauth.headers['x-api-key']).toBe('the-decrypted-key');
    expect(oauth.headers['Authorization']).toBe('Basic the-decrypted-secret');
  });
});

describe('T-A3 ② workspaceId=null → env fallback (D1/KEK 非接触短絡)', () => {
  test('env 鍵で client を返し、DB.prepare を一切呼ばない (FORMALOO_KEK undefined でも動作)', async () => {
    const { calls } = stubFetch();
    const env = { FORMALOO_API_KEY: 'env-key-2', FORMALOO_API_SECRET: 'env-secret-2', DB }; // FORMALOO_KEK 無し
    const client = await resolveFormalooClient(env, null);
    expect(client).not.toBeNull();
    expect(prepareSpy).not.toHaveBeenCalled(); // D1 非接触短絡
    await client!.get('/v3.0/forms/');
    const oauth = calls.find((c) => c.url.includes('authorization-token'))!;
    expect(oauth.headers['x-api-key']).toBe('env-key-2'); // env 鍵で動く
  });

  test('workspaceId 省略 (undefined) も env fallback で DB 非接触', async () => {
    const env = { FORMALOO_API_KEY: 'env-key-3', FORMALOO_API_SECRET: 'env-secret-3', DB };
    const client = await resolveFormalooClient(env);
    expect(client).not.toBeNull();
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  test('env 鍵も無い dev は null (createFormalooClient と同じ fail-soft)', async () => {
    const env = { DB };
    expect(await resolveFormalooClient(env, null)).toBeNull();
    expect(prepareSpy).not.toHaveBeenCalled();
  });
});

describe('T-A3 ③ 未登録 workspaceId → null (env fallback しない)', () => {
  test('env に鍵があっても未登録 id は null (誤送信防止)', async () => {
    const env = { FORMALOO_API_KEY: 'env-key', FORMALOO_API_SECRET: 'env-secret', FORMALOO_KEK: KEK, DB };
    expect(await resolveFormalooClient(env, 'does-not-exist')).toBeNull();
  });
});

describe('T-A3 ④ 復号失敗 → null (env fallback しない)', () => {
  test('KEK 不一致で復号できない登録 workspace は null (env 鍵へ落ちない)', async () => {
    await seedWorkspace('ws-badkek', 'k', 's', KEK); // 正しい KEK で暗号化
    const env = { FORMALOO_API_KEY: 'env-key', FORMALOO_API_SECRET: 'env-secret', FORMALOO_KEK: KEK_WRONG, DB };
    expect(await resolveFormalooClient(env, 'ws-badkek')).toBeNull();
  });

  test('FORMALOO_KEK 未投入で登録 workspace を要求 → null (env fallback しない)', async () => {
    await seedWorkspace('ws-nokek', 'k', 's', KEK);
    const env = { FORMALOO_API_KEY: 'env-key', FORMALOO_API_SECRET: 'env-secret', DB }; // KEK 無し
    expect(await resolveFormalooClient(env, 'ws-nokek')).toBeNull();
  });

  test('無効化 (is_active=0) workspace は null', async () => {
    await seedWorkspace('ws-disabled', 'k', 's', KEK);
    raw.prepare(`UPDATE formaloo_workspaces SET is_active=0 WHERE id='ws-disabled'`).run();
    const env = { FORMALOO_API_KEY: 'env-key', FORMALOO_API_SECRET: 'env-secret', FORMALOO_KEK: KEK, DB };
    expect(await resolveFormalooClient(env, 'ws-disabled')).toBeNull();
  });
});
