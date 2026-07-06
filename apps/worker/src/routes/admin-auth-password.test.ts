/**
 * T-F3 / T-F4 (batch F) — ID/PASS ログイン endpoint (password 経路 + 切替 flag + lockout)。
 *
 *   - {loginId,password} 正解 → 200 + session cookie (値=当該 staff の api_key) 発行 (downstream 不変 / M-22)
 *   - 誤パスワード → 401 汎用文言 + failed_login_count++ / 閾値超で lockout 設定
 *   - 存在しない loginId → 401 汎用文言 (列挙攻撃を助けない)
 *   - lock 中 account → 403
 *   - 切替 (PASSWORD_AUTH_REQUIRED=true): {apiKey} login は 401 拒否 / password login は 200
 *   - 並行期間 (flag off): {apiKey} login は従来どおり 200 (既存運用停止しない)
 */
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import { adminAuth } from './admin-auth.js';
import type { Env } from '../index.js';
import { hashPassword } from '../utils/password.js';

// ── stateful な staff store mock ──
type Member = {
  id: string; name: string; role: 'owner' | 'admin' | 'staff'; api_key: string;
  login_id: string | null; is_active: number;
  password_hash: string | null; password_salt: string | null;
  password_algo: string | null; password_iterations: number | null;
  failed_login_count: number | null; locked_until: string | null;
};

const { store } = vi.hoisted(() => ({ store: { member: null as unknown } }));

vi.mock('@line-crm/db', () => ({
  getStaffByApiKey: vi.fn(async (_db: unknown, token: string) => {
    const m = store.member as Member | null;
    return m && m.api_key === token && m.is_active === 1 ? { id: m.id, name: m.name, role: m.role } : null;
  }),
  getStaffByLoginId: vi.fn(async (_db: unknown, loginId: string) => {
    const m = store.member as Member | null;
    return m && m.login_id === loginId.trim().toLowerCase() && m.is_active === 1 ? m : null;
  }),
  isStaffLocked: vi.fn(async (_db: unknown, id: string) => {
    const m = store.member as Member | null;
    if (!m || m.id !== id || !m.locked_until) return false;
    // 実装は julianday(JST文字列) 比較。同形式 ISO 文字列の辞書比較 = 時系列比較 (TZ 非依存)。
    const nowJst = new Date(Date.now() + 9 * 3600_000).toISOString().replace('Z', '');
    return m.locked_until > nowJst;
  }),
  incrementFailedLogin: vi.fn(async (_db: unknown, id: string) => {
    const m = store.member as Member | null;
    if (m && m.id === id) m.failed_login_count = (m.failed_login_count ?? 0) + 1;
    return (m?.failed_login_count ?? 0);
  }),
  setStaffLockout: vi.fn(async (_db: unknown, id: string, until: string) => {
    const m = store.member as Member | null;
    if (m && m.id === id) m.locked_until = until;
  }),
  clearStaffLoginSecurity: vi.fn(async (_db: unknown, id: string) => {
    const m = store.member as Member | null;
    if (m && m.id === id) { m.failed_login_count = 0; m.locked_until = null; }
  }),
}));

function env(overrides: Partial<Env['Bindings']> = {}): Env['Bindings'] {
  return {
    DB: {} as D1Database, IMAGES: {} as R2Bucket, ASSETS: {} as Fetcher,
    LINE_CHANNEL_SECRET: 'secret', LINE_CHANNEL_ACCESS_TOKEN: 'line-token',
    API_KEY: 'env-key', LIFF_URL: 'https://liff.example.test',
    LINE_CHANNEL_ID: 'line-channel', LINE_LOGIN_CHANNEL_ID: 'login-channel',
    LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
    WORKER_URL: 'https://api.example.com', ADMIN_ORIGIN: 'https://admin.example.com',
    ...overrides,
  } as Env['Bindings'];
}

function app() {
  const a = new Hono<Env>();
  a.use('*', authMiddleware);
  a.route('/', adminAuth);
  a.get('/api/protected', (c) => c.json({ success: true, data: c.get('staff') }));
  return a;
}

function setCookies(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === 'function') return h.getSetCookie();
  const s = res.headers.get('Set-Cookie');
  return s ? [s] : [];
}
const sessionCookie = (res: Response) => setCookies(res).find((c) => c.startsWith('lh_admin_session='));

async function seedMember(over: Partial<Member> = {}): Promise<Member> {
  const pw = await hashPassword('CorrectHorse42');
  const m: Member = {
    id: 'staff-1', name: 'Staff One', role: 'staff', api_key: 'lh_staffkey',
    login_id: 'owner_ks', is_active: 1,
    password_hash: pw.password_hash, password_salt: pw.password_salt,
    password_algo: pw.password_algo, password_iterations: pw.password_iterations,
    failed_login_count: 0, locked_until: null, ...over,
  };
  store.member = m;
  return m;
}

async function login(body: Record<string, unknown>, e = env()) {
  return app().request('/api/auth/login', {
    method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  }, e);
}

beforeEach(() => { store.member = null; });

describe('T-F3 password login (並行期間)', () => {
  test('正しい loginId+password で 200・cookie 値 = staff の api_key', async () => {
    await seedMember();
    const res = await login({ loginId: 'OWNER_KS', password: 'CorrectHorse42' });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { id: string; role: string }; csrfToken: string };
    expect(body.data).toMatchObject({ id: 'staff-1', role: 'staff' });
    expect(body.csrfToken).toBeTruthy();
    expect(sessionCookie(res) ?? '').toContain('lh_admin_session=lh_staffkey');
  });

  test('誤パスワードは 401 汎用文言 + failed_login_count++', async () => {
    const m = await seedMember();
    const res = await login({ loginId: 'owner_ks', password: 'wrong' });
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toMatch(/ログインID.*パスワード/);
    expect(m.failed_login_count).toBe(1);
    expect(sessionCookie(res)).toBeUndefined();
  });

  test('5 連続失敗で lockout が設定される', async () => {
    const m = await seedMember();
    for (let i = 0; i < 5; i++) await login({ loginId: 'owner_ks', password: 'wrong' });
    expect(m.failed_login_count).toBe(5);
    expect(m.locked_until).not.toBeNull();
  });

  test('存在しない loginId は 401 汎用文言 (列挙攻撃を助けない)', async () => {
    await seedMember({ login_id: 'someone' });
    const res = await login({ loginId: 'ghost', password: 'whatever' });
    expect(res.status).toBe(401);
    expect((await res.json() as { error: string }).error).toMatch(/ログインID.*パスワード/);
  });

  test('lock 中 account は 403', async () => {
    const future = new Date(Date.now() + 9 * 3600_000 + 3600_000).toISOString().replace('Z', '');
    await seedMember({ locked_until: future });
    const res = await login({ loginId: 'owner_ks', password: 'CorrectHorse42' });
    expect(res.status).toBe(403);
  });

  test('成功でロック/失敗カウントが解除される', async () => {
    const m = await seedMember({ failed_login_count: 3 });
    await login({ loginId: 'owner_ks', password: 'CorrectHorse42' });
    expect(m.failed_login_count).toBe(0);
    expect(m.locked_until).toBeNull();
  });
});

describe('T-F3 apiKey 経路 (並行 / 切替)', () => {
  test('flag off: {apiKey} login は従来どおり 200 (既存運用停止しない)', async () => {
    await seedMember();
    const res = await login({ apiKey: 'lh_staffkey' });
    expect(res.status).toBe(200);
    expect(sessionCookie(res) ?? '').toContain('lh_admin_session=lh_staffkey');
  });

  test('cutover (PASSWORD_AUTH_REQUIRED=true): {apiKey} login は 401 拒否', async () => {
    await seedMember();
    const res = await login({ apiKey: 'lh_staffkey' }, env({ PASSWORD_AUTH_REQUIRED: 'true' }));
    expect(res.status).toBe(401);
    expect(sessionCookie(res)).toBeUndefined();
  });

  test('cutover: password login は 200 (切替後も ID/PASS は通る)', async () => {
    await seedMember();
    const res = await login({ loginId: 'owner_ks', password: 'CorrectHorse42' }, env({ PASSWORD_AUTH_REQUIRED: 'true' }));
    expect(res.status).toBe(200);
  });

  test('cutover: Bearer (SDK/MCP) は保護ルートで不変に通る', async () => {
    await seedMember();
    const res = await app().request('/api/protected', {
      headers: { Authorization: 'Bearer lh_staffkey' },
    }, env({ PASSWORD_AUTH_REQUIRED: 'true' }));
    expect(res.status).toBe(200);
  });
});
