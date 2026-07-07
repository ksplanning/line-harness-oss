import { Hono } from 'hono';
import type { Env } from '../index.js';
import {
  ADMIN_AUTH_COOKIE,
  CSRF_COOKIE,
  adminSessionCookie,
  authenticateApiToken,
  csrfCookie,
  csrfTokenFromCookie,
  expiredCookie,
} from '../middleware/auth.js';
import { resolveAdminAuthConfig } from '../middleware/admin-auth-config.js';
import {
  getStaffByLoginId,
  incrementFailedLogin,
  setStaffLockout,
  clearStaffLoginSecurity,
  isStaffLocked,
} from '@line-crm/db';
import { verifyPassword, PBKDF2_ITERATIONS } from '../utils/password.js';
import { computeLockMinutes, lockedUntilFromNow } from '../services/login-lockout.js';

export const adminAuth = new Hono<Env>();

/** password 経路が有効か (切替 flag / GC-3)。'true' で {apiKey} login フォーム経路を拒否。 */
function passwordAuthRequired(env: Env['Bindings']): boolean {
  return env.PASSWORD_AUTH_REQUIRED === 'true';
}

// 列挙攻撃を助けない汎用文言 (どちらが違うか言わない / T-F3)。
const GENERIC_LOGIN_ERROR = 'ログインIDまたはパスワードが正しくありません';
const LOCKED_ERROR = 'しばらくしてからもう一度お試しください';

// login_id が見つからない時も verify と同程度の時間を使い、ユーザー列挙をタイミングで漏らさない。
// 実在しない salt に対する PBKDF2 を空回しする (結果は破棄)。
const DUMMY_PW_RECORD = {
  password_hash: '0'.repeat(64),
  password_salt: '0'.repeat(32),
  password_algo: 'pbkdf2-sha256',
  // Workers 上限内 (dummy verify も deriveBits を回すので >100k だと not-found 経路が本番 500 になる)。
  password_iterations: PBKDF2_ITERATIONS,
};

/**
 * POST /api/auth/login
 *
 * Validates the API key, then issues:
 *   - lh_admin_session (HttpOnly) — the credential, never exposed to JS.
 *   - lh_csrf (readable) — the double-submit CSRF token, also returned in the
 *     body so a cross-site SPA (which cannot read the API's cookie) can echo it
 *     back via the X-CSRF-Token header.
 *
 * Refuses with a clear error when the topology cannot deliver the cookie,
 * turning the silent "login breaks after deploy" failure into an actionable
 * configuration error.
 */
adminAuth.post('/api/auth/login', async (c) => {
  const config = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
  if (config.misconfigured) {
    console.error('[admin-auth] refused login — misconfigured topology:', config.misconfigured);
    return c.json({ success: false, error: config.misconfigured }, 500);
  }

  const body = await c.req
    .json<{ apiKey?: string; loginId?: string; password?: string }>()
    .catch(() => ({}) as { apiKey?: string; loginId?: string; password?: string });

  const loginId = body.loginId?.trim() ?? '';
  const password = body.password ?? '';

  // ── ID/PASS 経路 (loginId + password が来たら password ログインとして処理) ──
  if (loginId && password) {
    const member = await getStaffByLoginId(c.env.DB, loginId);

    // 存在しない login_id: ユーザー列挙を timing で漏らさないため dummy verify を空回しして generic 401。
    if (!member || !member.password_hash) {
      await verifyPassword(password, DUMMY_PW_RECORD);
      return c.json({ success: false, error: GENERIC_LOGIN_ERROR }, 401);
    }

    // D1 権威 lockout (in-memory rate-limit に依存しない / M-23)。
    if (await isStaffLocked(c.env.DB, member.id)) {
      return c.json({ success: false, error: LOCKED_ERROR }, 403);
    }

    const ok = await verifyPassword(password, {
      password_hash: member.password_hash,
      password_salt: member.password_salt ?? '',
      password_algo: member.password_algo ?? 'pbkdf2-sha256',
      password_iterations: member.password_iterations ?? PBKDF2_ITERATIONS,
    });

    if (!ok) {
      const failed = await incrementFailedLogin(c.env.DB, member.id);
      const lockMinutes = computeLockMinutes(failed, member.role);
      if (lockMinutes > 0) {
        await setStaffLockout(c.env.DB, member.id, lockedUntilFromNow(lockMinutes));
      }
      return c.json({ success: false, error: GENERIC_LOGIN_ERROR }, 401);
    }

    // 成功: 失敗カウント/lock を解除し、既存の session cookie (値 = 当該 staff の api_key) を発行。
    // downstream (authenticateApiToken→getStaffByApiKey→CSRF) は完全に不変 (M-22)。
    await clearStaffLoginSecurity(c.env.DB, member.id);
    const staff = { id: member.id, name: member.name, role: member.role };
    const csrfToken = crypto.randomUUID();
    c.header('Set-Cookie', adminSessionCookie(member.api_key, config.sameSite), { append: true });
    c.header('Set-Cookie', csrfCookie(csrfToken, config.sameSite), { append: true });
    return c.json({ success: true, data: staff, csrfToken });
  }

  // ── API キー経路 (並行期間)。cutover 後は login フォームからの {apiKey} を拒否 (Bearer は別 / GC-3) ──
  if (passwordAuthRequired(c.env)) {
    return c.json(
      { success: false, error: 'このログイン方法は無効です。ログインIDとパスワードでログインしてください。' },
      401,
    );
  }

  const apiKey = body.apiKey?.trim() ?? '';
  const staff = await authenticateApiToken(c, apiKey || null);

  if (!staff) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const csrfToken = crypto.randomUUID();
  c.header('Set-Cookie', adminSessionCookie(apiKey, config.sameSite), { append: true });
  c.header('Set-Cookie', csrfCookie(csrfToken, config.sameSite), { append: true });
  return c.json({ success: true, data: staff, csrfToken });
});

/**
 * POST /api/auth/logout — clears both cookies. No CSRF required: clearing your
 * own session is not a meaningful CSRF target, and this keeps logout resilient
 * even if the CSRF token was lost client-side.
 */
adminAuth.post('/api/auth/logout', async (c) => {
  const { sameSite } = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
  c.header('Set-Cookie', expiredCookie(ADMIN_AUTH_COOKIE, sameSite), { append: true });
  c.header('Set-Cookie', expiredCookie(CSRF_COOKIE, sameSite), { append: true });
  return c.json({ success: true, data: null });
});

/**
 * GET /api/auth/session — returns the authenticated staff (set by the auth
 * middleware) plus the current CSRF token, refreshing the CSRF cookie if it is
 * missing (e.g. after a reload that dropped the in-memory token). This lets the
 * SPA recover the CSRF token without forcing a re-login.
 */
adminAuth.get('/api/auth/session', async (c) => {
  const config = resolveAdminAuthConfig(c.env, { requestOrigin: new URL(c.req.url).origin });
  let csrfToken = csrfTokenFromCookie(c);
  if (!csrfToken) {
    csrfToken = crypto.randomUUID();
    c.header('Set-Cookie', csrfCookie(csrfToken, config.sameSite), { append: true });
  }
  return c.json({ success: true, data: c.get('staff'), csrfToken });
});
