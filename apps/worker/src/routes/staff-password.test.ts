/**
 * T-F5/T-F6 + GC-4 (batch F) — staff 管理の ID/PASS endpoint + 秘匿列の非露出。
 *
 *   - [GC-4] /api/staff 応答に password_hash/salt/algo/iterations/failed_login_count/locked_until が
 *     一切出ない (serialize whitelist が防壁 / M-8)。出るのは loginId/hasPassword/locked の派生値のみ。
 *   - PUT /login-id: 設定・形式検証・重複 409
 *   - PUT /password: 8文字未満 400 / 成功でハッシュ化 (応答に平文/ハッシュ無し)
 *   - POST /unlock: lock 解除
 */
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { staff as staffRoute } from './staff.js';
import type { Env } from '../index.js';

type Member = {
  id: string; name: string; email: string | null; role: 'owner' | 'admin' | 'staff';
  api_key: string; is_active: number; created_at: string; updated_at: string;
  login_id: string | null; password_hash: string | null; password_salt: string | null;
  password_algo: string | null; password_iterations: number | null; password_updated_at: string | null;
  failed_login_count: number | null; locked_until: string | null;
};

const { store } = vi.hoisted(() => ({ store: { members: [] as unknown[] } }));

vi.mock('@line-crm/db', () => ({
  getStaffMembers: vi.fn(async () => store.members),
  getStaffById: vi.fn(async (_db: unknown, id: string) => (store.members as Member[]).find((m) => m.id === id) ?? null),
  countActiveStaffByRole: vi.fn(async (_db: unknown, role: string) => (store.members as Member[]).filter((m) => m.role === role && m.is_active === 1).length),
  setStaffLoginId: vi.fn(async (_db: unknown, id: string, loginId: string) => {
    const norm = loginId.trim().toLowerCase();
    const dup = (store.members as Member[]).some((m) => m.id !== id && m.login_id === norm);
    if (dup) return { ok: false, error: 'duplicate' };
    const m = (store.members as Member[]).find((x) => x.id === id);
    if (m) m.login_id = norm;
    return { ok: true };
  }),
  setStaffPassword: vi.fn(async (_db: unknown, id: string, rec: { password_hash: string }) => {
    const m = (store.members as Member[]).find((x) => x.id === id);
    if (m) { m.password_hash = rec.password_hash; m.failed_login_count = 0; m.locked_until = null; }
  }),
  clearStaffLoginSecurity: vi.fn(async (_db: unknown, id: string) => {
    const m = (store.members as Member[]).find((x) => x.id === id);
    if (m) { m.failed_login_count = 0; m.locked_until = null; }
  }),
  // 未使用だが staff.ts が import するので stub。
  createStaffMember: vi.fn(), updateStaffMember: vi.fn(), deleteStaffMember: vi.fn(), regenerateStaffApiKey: vi.fn(),
}));

function app(role: 'owner' | 'admin' | 'staff' = 'owner') {
  const a = new Hono<Env>();
  a.use('*', async (c, next) => { c.set('staff', { id: 'owner-1', name: 'Owner', role }); return next(); });
  a.route('/', staffRoute);
  return a;
}
const env = () => ({ DB: {} } as unknown as Env['Bindings']);

function seed() {
  store.members = [{
    id: 's1', name: 'Staff One', email: null, role: 'staff', api_key: 'lh_secretkey',
    is_active: 1, created_at: '2026-07-07T00:00:00.000', updated_at: '2026-07-07T00:00:00.000',
    login_id: 'staff_one', password_hash: 'SECRETHASHVALUE', password_salt: 'SECRETSALTVALUE',
    password_algo: 'pbkdf2-sha256', password_iterations: 210000, password_updated_at: '2026-07-07T00:00:00.000',
    failed_login_count: 3, locked_until: null,
  } as Member];
}

beforeEach(seed);

describe('GC-4 秘匿列の非露出', () => {
  test('GET /api/staff に password_hash/salt/失敗回数/lock 時刻が出ない・派生値のみ出る', async () => {
    const res = await app().request('/api/staff', {}, env());
    expect(res.status).toBe(200);
    const raw = await res.text();
    for (const secret of ['SECRETHASHVALUE', 'SECRETSALTVALUE', 'password_hash', 'password_salt', 'password_algo', 'password_iterations', 'failed_login_count', 'locked_until']) {
      expect(raw).not.toContain(secret);
    }
    const body = JSON.parse(raw) as { data: Array<Record<string, unknown>> };
    expect(body.data[0]).toMatchObject({ loginId: 'staff_one', hasPassword: true, locked: false });
    // api_key はマスクされている (既存挙動)。
    expect(String(body.data[0].apiKey)).toContain('****');
    expect(raw).not.toContain('lh_secretkey');
  });
});

describe('PUT /api/staff/:id/login-id', () => {
  test('形式 OK なら設定される (正規化)', async () => {
    const res = await app().request('/api/staff/s1/login-id', { method: 'PUT', body: JSON.stringify({ loginId: 'New_Owner' }), headers: { 'Content-Type': 'application/json' } }, env());
    expect(res.status).toBe(200);
    expect((store.members as Member[])[0].login_id).toBe('new_owner');
  });

  test('不正な形式 (空白/記号) は 400', async () => {
    const res = await app().request('/api/staff/s1/login-id', { method: 'PUT', body: JSON.stringify({ loginId: 'ab' }), headers: { 'Content-Type': 'application/json' } }, env());
    expect(res.status).toBe(400);
  });

  test('重複は 409', async () => {
    (store.members as Member[]).push({ ...(store.members as Member[])[0], id: 's2', login_id: 'taken' } as Member);
    const res = await app().request('/api/staff/s1/login-id', { method: 'PUT', body: JSON.stringify({ loginId: 'Taken' }), headers: { 'Content-Type': 'application/json' } }, env());
    expect(res.status).toBe(409);
  });

  test('owner 以外は 403', async () => {
    const res = await app('staff').request('/api/staff/s1/login-id', { method: 'PUT', body: JSON.stringify({ loginId: 'x_y_z' }), headers: { 'Content-Type': 'application/json' } }, env());
    expect(res.status).toBe(403);
  });
});

describe('PUT /api/staff/:id/password', () => {
  test('8文字未満は 400', async () => {
    const res = await app().request('/api/staff/s1/password', { method: 'PUT', body: JSON.stringify({ password: 'short' }), headers: { 'Content-Type': 'application/json' } }, env());
    expect(res.status).toBe(400);
  });

  test('成功でハッシュ化され応答に平文/ハッシュが出ない', async () => {
    const res = await app().request('/api/staff/s1/password', { method: 'PUT', body: JSON.stringify({ password: 'ValidPass123' }), headers: { 'Content-Type': 'application/json' } }, env());
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain('ValidPass123');
    // 実ハッシュに更新されている (SECRETHASHVALUE から変わり、平文でもない)。
    const m = (store.members as Member[])[0];
    expect(m.password_hash).not.toBe('SECRETHASHVALUE');
    expect(m.password_hash).not.toBe('ValidPass123');
    expect(m.password_hash!.length).toBeGreaterThan(20);
  });
});

describe('POST /api/staff/:id/unlock', () => {
  test('failed_login_count/locked_until がリセットされる', async () => {
    (store.members as Member[])[0].locked_until = '2999-01-01T00:00:00.000';
    const res = await app().request('/api/staff/s1/unlock', { method: 'POST' }, env());
    expect(res.status).toBe(200);
    expect((store.members as Member[])[0].failed_login_count).toBe(0);
    expect((store.members as Member[])[0].locked_until).toBeNull();
  });
});
