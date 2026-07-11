/**
 * T-A5 (F6-1) — /api/formaloo-workspaces キー管理 API (owner gated / 暗号化保管)。
 *   ① 非 owner (built-in staff/admin + custom role 両方) の 追加/削除/無効化/GET一覧/疎通テスト 全 route で 403
 *      (Codex gap #6: GET・疎通も owner-only / built-in admin/staff も非 owner は ownerGate が真の enforcement)
 *   ② 誤鍵の疎通テスト失敗で保存拒否 (400) / KEK 未投入は 503
 *   ③ 一覧応答に KEY/SECRET/暗号文が **含まれない** (label/businessSlug/isActive/id のみ)
 *   ④ sentinel 平文鍵が エラー応答・console・D1 に **非露出** (Codex gap #5 / 汎用エラー化)
 *   + enable/disable 切替 (F6-1「切替」) / 入力 whitelist
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { jstNow, createRole, setRolePermissions } from '@line-crm/db';
import { authMiddleware } from '../middleware/auth.js';
import { permissionMiddleware } from '../middleware/permission-middleware.js';
import { formalooWorkspaces } from './formaloo-workspaces.js';
import type { Env } from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;
const KEK = Buffer.from(new Uint8Array(32).fill(11)).toString('base64');

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

function env(overrides: Partial<Env['Bindings']> = {}): Env['Bindings'] {
  return {
    DB, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'env-owner-key',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
    FORMALOO_KEK: KEK,
    ...overrides,
  } as Env['Bindings'];
}

function app() {
  const a = new Hono<Env>();
  a.use('*', authMiddleware);
  a.use('*', permissionMiddleware);
  a.route('/', formalooWorkspaces);
  return a;
}

const OWNER = 'Bearer env-owner-key';
function call(method: string, path: string, body?: unknown, auth = OWNER, envOverrides: Partial<Env['Bindings']> = {}) {
  return app().request(path, {
    method,
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, env(envOverrides));
}

function seedStaff(id: string, role: string, apiKey: string, roleId: string | null = null) {
  const now = jstNow();
  raw.prepare(
    `INSERT INTO staff_members (id, name, email, role, api_key, is_active, created_at, updated_at, role_id)
     VALUES (?,?,?,?,?,1,?,?,?)`,
  ).run(id, id, null, role, apiKey, now, now, roleId);
}

/** forms_advanced 権限 "あり" だが owner でない custom role staff (ownerGate 検証用)。 */
async function seedFormsAdvancedStaff(apiKey: string) {
  const roleId = (await createRole(DB, { name: 'フォーム担当' })).id;
  await setRolePermissions(DB, roleId, [{ feature_key: 'forms_advanced', allowed: true }]);
  seedStaff(`u_${apiKey}`, 'staff', apiKey, roleId);
}

/** globalThis.fetch を stub。ok=true なら疎通 200・false なら 403 (auth 失敗) を返す。 */
function stubFetch(ok: boolean, marker = 'FORMALOO_RESP_MARKER') {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('authorization-token')) {
      return ok
        ? new Response(JSON.stringify({ authorization_token: 'jwt' }), { status: 200 })
        : new Response(JSON.stringify({ error: marker }), { status: 403 });
    }
    return new Response(JSON.stringify({ data: [], note: marker }), { status: ok ? 200 : 403 });
  }));
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('T-A5 ① 全 route owner-only (非 owner 403)', () => {
  const nonOwnerCases: Array<[string, () => Promise<void>]> = [];

  test('built-in staff (role_id NULL) は 全 route 403', async () => {
    seedStaff('st', 'staff', 'staff-key', null);
    const A = 'Bearer staff-key';
    expect((await call('GET', '/api/formaloo-workspaces', undefined, A)).status).toBe(403);
    expect((await call('POST', '/api/formaloo-workspaces', { label: 'L', key: 'k', secret: 's' }, A)).status).toBe(403);
    expect((await call('POST', '/api/formaloo-workspaces/test', { key: 'k', secret: 's' }, A)).status).toBe(403);
    expect((await call('PATCH', '/api/formaloo-workspaces/fw_x', { isActive: false }, A)).status).toBe(403);
    expect((await call('DELETE', '/api/formaloo-workspaces/fw_x', undefined, A)).status).toBe(403);
  });

  test('built-in admin (role_id NULL) も 非 owner ゆえ 403 (非対称 fail-closed の穴を塞ぐ)', async () => {
    seedStaff('ad', 'admin', 'admin-key', null);
    const A = 'Bearer admin-key';
    expect((await call('GET', '/api/formaloo-workspaces', undefined, A)).status).toBe(403);
    expect((await call('POST', '/api/formaloo-workspaces', { label: 'L', key: 'k', secret: 's' }, A)).status).toBe(403);
    expect((await call('POST', '/api/formaloo-workspaces/test', { key: 'k', secret: 's' }, A)).status).toBe(403);
  });

  test('custom role (forms_advanced あり・非 owner) も ownerGate で 403', async () => {
    await seedFormsAdvancedStaff('fa-key');
    const A = 'Bearer fa-key';
    expect((await call('GET', '/api/formaloo-workspaces', undefined, A)).status).toBe(403);
    expect((await call('POST', '/api/formaloo-workspaces', { label: 'L', key: 'k', secret: 's' }, A)).status).toBe(403);
    expect((await call('PATCH', '/api/formaloo-workspaces/fw_x', { isActive: false }, A)).status).toBe(403);
  });

  test('custom role (forms_advanced なし) は middleware で 403', async () => {
    const roleId = (await createRole(DB, { name: 'ゲスト' })).id;
    await setRolePermissions(DB, roleId, [{ feature_key: 'forms_advanced', allowed: false }]);
    seedStaff('g', 'staff', 'guest-key', roleId);
    expect((await call('GET', '/api/formaloo-workspaces', undefined, 'Bearer guest-key')).status).toBe(403);
  });
});

describe('T-A5 追加 + 疎通テスト + 暗号化保管', () => {
  test('owner: 疎通OK → 201・暗号化保存・応答に鍵なし', async () => {
    stubFetch(true);
    const res = await call('POST', '/api/formaloo-workspaces', { label: 'A社', key: 'plain-KEY-xyz', secret: 'plain-SECRET-xyz', businessSlug: 'acme' });
    expect(res.status).toBe(201);
    const body = await res.json() as { data: Record<string, unknown> };
    expect(body.data.label).toBe('A社');
    expect(body.data.isActive).toBe(true);
    // 応答に KEY/SECRET/暗号文なし
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain('plain-KEY-xyz');
    expect(bodyStr).not.toContain('plain-SECRET-xyz');
    // D1 は暗号文のみ (平文鍵は保存されない)
    const row = raw.prepare(`SELECT * FROM formaloo_workspaces`).get() as Record<string, string>;
    const rowStr = JSON.stringify(row);
    expect(rowStr).not.toContain('plain-KEY-xyz');
    expect(rowStr).not.toContain('plain-SECRET-xyz');
    expect(row.key_ciphertext).toBeTruthy();
    expect(row.secret_ciphertext).toBeTruthy();
  });

  test('② 誤鍵 (疎通失敗) は保存拒否 400・行を作らない', async () => {
    stubFetch(false);
    const res = await call('POST', '/api/formaloo-workspaces', { label: 'A社', key: 'bad-KEY', secret: 'bad-SECRET' });
    expect(res.status).toBe(400);
    const n = (raw.prepare(`SELECT COUNT(*) c FROM formaloo_workspaces`).get() as { c: number }).c;
    expect(n).toBe(0);
  });

  test('② KEK 未投入は 503 (平文を保持しない)', async () => {
    stubFetch(true);
    const res = await call('POST', '/api/formaloo-workspaces', { label: 'A社', key: 'k', secret: 's' }, OWNER, { FORMALOO_KEK: undefined });
    expect(res.status).toBe(503);
    expect((raw.prepare(`SELECT COUNT(*) c FROM formaloo_workspaces`).get() as { c: number }).c).toBe(0);
  });

  test('入力 whitelist: label/key/secret 欠落は 400', async () => {
    stubFetch(true);
    expect((await call('POST', '/api/formaloo-workspaces', { key: 'k', secret: 's' })).status).toBe(400);
    expect((await call('POST', '/api/formaloo-workspaces', { label: 'L', secret: 's' })).status).toBe(400);
    expect((await call('POST', '/api/formaloo-workspaces', { label: 'L', key: 'k' })).status).toBe(400);
  });

  test('疎通テスト (dry-run): owner は ok を返す (保存しない)', async () => {
    stubFetch(true);
    const res = await call('POST', '/api/formaloo-workspaces/test', { key: 'k', secret: 's' });
    expect(res.status).toBe(200);
    expect((await res.json() as { data: { ok: boolean } }).data.ok).toBe(true);
    // dry-run は保存しない
    expect((raw.prepare(`SELECT COUNT(*) c FROM formaloo_workspaces`).get() as { c: number }).c).toBe(0);
  });
});

describe('T-A5 ③ 一覧に鍵・暗号文を載せない', () => {
  test('GET 一覧は id/label/businessSlug/isActive のみ', async () => {
    stubFetch(true);
    await call('POST', '/api/formaloo-workspaces', { label: 'A社', key: 'LK', secret: 'LS', businessSlug: 'acme' });
    const res = await call('GET', '/api/formaloo-workspaces');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<Record<string, unknown>> };
    expect(body.data.length).toBe(1);
    const item = body.data[0];
    expect(Object.keys(item).sort()).toEqual(['businessSlug', 'id', 'isActive', 'label']);
    const s = JSON.stringify(body);
    expect(s).not.toContain('LK');
    expect(s).not.toContain('LS');
    expect(s).not.toContain('ciphertext');
    expect(s).not.toContain(item.id && (raw.prepare(`SELECT key_ciphertext FROM formaloo_workspaces`).get() as { key_ciphertext: string }).key_ciphertext);
  });
});

describe('T-A5 ④ sentinel 平文鍵が 応答・console・D1 に非露出 (Codex gap #5)', () => {
  test('疎通失敗時: sentinel 鍵/Formaloo応答本文を エラー応答・console に漏らさない', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    stubFetch(false, 'SENTINEL_FORMALOO_BODY');
    const SENTINEL_KEY = 'SENTINEL_PLAINTEXT_KEY';
    const SENTINEL_SECRET = 'SENTINEL_PLAINTEXT_SECRET';
    const res = await call('POST', '/api/formaloo-workspaces', { label: 'A社', key: SENTINEL_KEY, secret: SENTINEL_SECRET });
    expect(res.status).toBe(400);
    const bodyStr = JSON.stringify(await res.json());
    expect(bodyStr).not.toContain(SENTINEL_KEY);
    expect(bodyStr).not.toContain(SENTINEL_SECRET);
    expect(bodyStr).not.toContain('SENTINEL_FORMALOO_BODY');
    // console 出力に sentinel/応答本文が出ない
    const logged = [...errSpy.mock.calls, ...logSpy.mock.calls].map((a) => JSON.stringify(a)).join('|');
    expect(logged).not.toContain(SENTINEL_KEY);
    expect(logged).not.toContain(SENTINEL_SECRET);
    expect(logged).not.toContain('SENTINEL_FORMALOO_BODY');
    // D1 に何も残らない
    expect((raw.prepare(`SELECT COUNT(*) c FROM formaloo_workspaces`).get() as { c: number }).c).toBe(0);
  });
});

describe('T-A5 enable/disable 切替 + soft-delete (owner)', () => {
  async function seedOne(): Promise<string> {
    stubFetch(true);
    const res = await call('POST', '/api/formaloo-workspaces', { label: 'A社', key: 'k', secret: 's' });
    return (await res.json() as { data: { id: string } }).data.id;
  }

  test('PATCH で無効化 → 有効化 (F6-1「切替」)', async () => {
    const id = await seedOne();
    expect((await call('PATCH', `/api/formaloo-workspaces/${id}`, { isActive: false })).status).toBe(200);
    expect((raw.prepare(`SELECT is_active FROM formaloo_workspaces WHERE id=?`).get(id) as { is_active: number }).is_active).toBe(0);
    expect((await call('PATCH', `/api/formaloo-workspaces/${id}`, { isActive: true })).status).toBe(200);
    expect((raw.prepare(`SELECT is_active FROM formaloo_workspaces WHERE id=?`).get(id) as { is_active: number }).is_active).toBe(1);
  });

  test('PATCH: isActive 非 boolean は 400 / 不明 id は 404', async () => {
    expect((await call('PATCH', '/api/formaloo-workspaces/fw_x', { isActive: 'yes' })).status).toBe(400);
    expect((await call('PATCH', '/api/formaloo-workspaces/fw_missing', { isActive: false })).status).toBe(404);
  });

  test('DELETE は soft-delete (is_active=0)', async () => {
    const id = await seedOne();
    expect((await call('DELETE', `/api/formaloo-workspaces/${id}`)).status).toBe(200);
    expect((raw.prepare(`SELECT is_active FROM formaloo_workspaces WHERE id=?`).get(id) as { is_active: number }).is_active).toBe(0);
    expect((await call('DELETE', '/api/formaloo-workspaces/fw_missing')).status).toBe(404);
  });
});

describe('I1 疎通テストの token cache 素通り穴 (reviewer Round1)', () => {
  /** oauth は Basic が CORRECT の時のみ 200 (誤 secret は 403)。GET は 200。 = apiSecret を oauth で検証。 */
  function stubSecretSensitive(correctSecret: string) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (String(url).includes('authorization-token')) {
        const auth = (init.headers as Record<string, string>).Authorization;
        return auth === `Basic ${correctSecret}`
          ? new Response(JSON.stringify({ authorization_token: 'jwt' }), { status: 200 })
          : new Response(JSON.stringify({ error: 'bad secret' }), { status: 403 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }));
  }

  test('同一 apiKey で先に正 secret 保存後、誤 secret の追加は保存拒否 400 (cache-hit で誤 200 させない)', async () => {
    stubSecretSensitive('correct-secret');
    // 1) 正 secret で追加 → 201 (共有 cache 経路だと apiKey のトークンがここで cache される)
    const ok = await call('POST', '/api/formaloo-workspaces', { label: 'A社', key: 'CACHE_K', secret: 'correct-secret' });
    expect(ok.status).toBe(201);
    // 2) 同一 apiKey・誤 secret → **保存拒否 400** (旧実装は cache-hit で oauth を skip し誤 200→保存する穴)
    const ng = await call('POST', '/api/formaloo-workspaces', { label: 'B社', key: 'CACHE_K', secret: 'WRONG-secret' });
    expect(ng.status).toBe(400);
    // 保存は 1 件のみ (正 secret のみ)
    expect((raw.prepare(`SELECT COUNT(*) c FROM formaloo_workspaces`).get() as { c: number }).c).toBe(1);
  });

  test('dry-run 疎通も同様: 正 secret 後の 同一 apiKey・誤 secret は ok=false', async () => {
    stubSecretSensitive('correct-secret');
    expect((await (await call('POST', '/api/formaloo-workspaces/test', { key: 'CK2', secret: 'correct-secret' })).json() as { data: { ok: boolean } }).data.ok).toBe(true);
    expect((await (await call('POST', '/api/formaloo-workspaces/test', { key: 'CK2', secret: 'WRONG-secret' })).json() as { data: { ok: boolean } }).data.ok).toBe(false);
  });
});

describe('I2 S-1 手順書は KS 用 wrangler config を使う (reviewer Round1)', () => {
  test('runbook 内の全 wrangler コマンド行に --config wrangler.ks.toml が付く', () => {
    const runbook = readFileSync(join(__dirname, '../../../../docs/formaloo-kek-secret-runbook.md'), 'utf8');
    const wranglerCmdLines = runbook
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('wrangler ')); // コマンド行のみ (prose の 'wrangler.toml' 言及は除外)
    expect(wranglerCmdLines.length).toBeGreaterThan(0);
    for (const line of wranglerCmdLines) {
      expect(line, `--config 欠落: ${line}`).toContain('--config wrangler.ks.toml');
    }
  });
});
