import { Hono } from 'hono';
import {
  getStaffMembers,
  getStaffById,
  createStaffMember,
  updateStaffMember,
  deleteStaffMember,
  regenerateStaffApiKey,
  countActiveStaffByRole,
  setStaffLoginId,
  setStaffPassword,
  clearStaffLoginSecurity,
} from '@line-crm/db';
import type { StaffMember } from '@line-crm/db';
import { requireRole } from '../middleware/role-guard.js';
import { hashPassword } from '../utils/password.js';
import type { Env } from '../index.js';

const staff = new Hono<Env>();

function maskApiKey(key: string): string {
  return `lh_****${key.slice(-4)}`;
}

/** locked_until (JST 文字列) から lock 中かを算出。julianday と同義の ISO 辞書比較 (TZ 非依存)。 */
function isLockedFromRow(row: StaffMember): boolean {
  if (!row.locked_until) return false;
  const nowJst = new Date(Date.now() + 9 * 3600_000).toISOString().replace('Z', '');
  return row.locked_until > nowJst;
}

/**
 * API に出す staff の shape。**password_hash/salt/algo/iterations/failed_login_count/locked_until は
 * 一切含めない (GC-4 / M-8)** = この whitelist が唯一の防壁。login_id(ユーザー名) と hasPassword(設定済み
 * か) と locked(現在ロック中か) の派生値だけを出す。
 */
function serializeStaff(row: StaffMember, masked = true) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    apiKey: masked ? maskApiKey(row.api_key) : row.api_key,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // ID/PASS (batch F)。ハッシュ等の秘匿列は出さない。
    loginId: row.login_id,
    hasPassword: Boolean(row.password_hash),
    locked: isLockedFromRow(row),
  };
}

// GET /api/staff/me — any authenticated user (MUST be before /:id)
staff.get('/api/staff/me', async (c) => {
  try {
    const currentStaff = c.get('staff');

    // env-owner: return minimal info
    if (currentStaff.id === 'env-owner') {
      return c.json({
        success: true,
        data: {
          id: 'env-owner',
          name: 'Owner',
          role: 'owner',
          email: null,
        },
      });
    }

    const member = await getStaffById(c.env.DB, currentStaff.id);
    if (!member) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }

    return c.json({
      success: true,
      data: {
        id: member.id,
        name: member.name,
        role: member.role,
        email: member.email,
      },
    });
  } catch (err) {
    console.error('GET /api/staff/me error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/staff — owner only. List all staff with masked API keys.
staff.get('/api/staff', requireRole('owner'), async (c) => {
  try {
    const members = await getStaffMembers(c.env.DB);
    return c.json({ success: true, data: members.map((m) => serializeStaff(m, true)) });
  } catch (err) {
    console.error('GET /api/staff error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/staff/:id — owner only. Get staff detail with masked key.
staff.get('/api/staff/:id', requireRole('owner'), async (c) => {
  try {
    const id = c.req.param('id')!;
    const member = await getStaffById(c.env.DB, id);
    if (!member) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }
    return c.json({ success: true, data: serializeStaff(member, true) });
  } catch (err) {
    console.error('GET /api/staff/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/staff — owner only. Create staff. Returns full API key (one-time visible).
staff.post('/api/staff', requireRole('owner'), async (c) => {
  try {
    const body = await c.req.json<{ name: string; email?: string; role: string }>();

    if (!body.name) {
      return c.json({ success: false, error: 'name is required' }, 400);
    }

    const validRoles = ['owner', 'admin', 'staff'] as const;
    if (!body.role || !validRoles.includes(body.role as (typeof validRoles)[number])) {
      return c.json({ success: false, error: 'role must be owner, admin, or staff' }, 400);
    }

    const member = await createStaffMember(c.env.DB, {
      name: body.name,
      email: body.email ?? null,
      role: body.role as 'owner' | 'admin' | 'staff',
    });

    // Return full (unmasked) API key one-time
    return c.json({ success: true, data: serializeStaff(member, false) }, 201);
  } catch (err) {
    console.error('POST /api/staff error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PATCH /api/staff/:id — owner only. Update staff.
staff.patch('/api/staff/:id', requireRole('owner'), async (c) => {
  try {
    const id = c.req.param('id')!;
    const body = await c.req.json<{
      name?: string;
      email?: string | null;
      role?: string;
      isActive?: boolean;
    }>();

    const validRoles = ['owner', 'admin', 'staff'] as const;
    if (body.role !== undefined && !validRoles.includes(body.role as (typeof validRoles)[number])) {
      return c.json({ success: false, error: 'role must be owner, admin, or staff' }, 400);
    }

    // Prevent removing the last active owner
    const target = await getStaffById(c.env.DB, id);
    if (!target) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }
    if (target.role === 'owner' && target.is_active === 1) {
      const willLoseOwner =
        (body.role !== undefined && body.role !== 'owner') ||
        body.isActive === false;
      if (willLoseOwner) {
        const ownerCount = await countActiveStaffByRole(c.env.DB, 'owner');
        if (ownerCount <= 1) {
          return c.json({ success: false, error: 'オーナーは最低1人必要です' }, 400);
        }
      }
    }

    const updated = await updateStaffMember(c.env.DB, id, {
      name: body.name,
      email: body.email,
      role: body.role as 'owner' | 'admin' | 'staff' | undefined,
      is_active: body.isActive !== undefined ? (body.isActive ? 1 : 0) : undefined,
    });

    if (!updated) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }

    return c.json({ success: true, data: serializeStaff(updated, true) });
  } catch (err) {
    console.error('PATCH /api/staff/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/staff/:id — owner only. Cannot delete self. Must keep at least 1 owner.
staff.delete('/api/staff/:id', requireRole('owner'), async (c) => {
  try {
    const id = c.req.param('id')!;
    const currentStaff = c.get('staff');

    if (id === currentStaff.id) {
      return c.json({ success: false, error: '自分自身は削除できません' }, 400);
    }

    const target = await getStaffById(c.env.DB, id);
    if (!target) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }

    if (target.role === 'owner' && target.is_active === 1) {
      const ownerCount = await countActiveStaffByRole(c.env.DB, 'owner');
      if (ownerCount <= 1) {
        return c.json({ success: false, error: 'オーナーは最低1人必要です' }, 400);
      }
    }

    await deleteStaffMember(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/staff/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/staff/:id/login-id — owner only. Set/normalize the login ID (ID/PASS ログイン)。
staff.put('/api/staff/:id/login-id', requireRole('owner'), async (c) => {
  try {
    const id = c.req.param('id')!;
    const body = await c.req.json<{ loginId?: string }>().catch(() => ({}) as { loginId?: string });
    const loginId = body.loginId?.trim() ?? '';
    if (!loginId) return c.json({ success: false, error: 'ログインIDを入力してください' }, 400);
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(loginId)) {
      return c.json({ success: false, error: 'ログインIDは半角英数字と . _ - で3〜64文字にしてください' }, 400);
    }
    const exists = await getStaffById(c.env.DB, id);
    if (!exists) return c.json({ success: false, error: 'Staff member not found' }, 404);

    const result = await setStaffLoginId(c.env.DB, id, loginId);
    if (!result.ok) {
      return c.json({ success: false, error: 'このログインIDは既に使われています' }, 409);
    }
    const updated = await getStaffById(c.env.DB, id);
    return c.json({ success: true, data: updated ? serializeStaff(updated, true) : null });
  } catch (err) {
    console.error('PUT /api/staff/:id/login-id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/staff/:id/password — owner only. Set/reset the password (PBKDF2 hashed server-side)。
// 平文はここで受け取り即ハッシュ化。DB にもレスポンスにもログにも平文/ハッシュを残さない (GC-4)。
staff.put('/api/staff/:id/password', requireRole('owner'), async (c) => {
  try {
    const id = c.req.param('id')!;
    const body = await c.req.json<{ password?: string }>().catch(() => ({}) as { password?: string });
    const password = body.password ?? '';
    if (password.length < 8) {
      return c.json({ success: false, error: 'パスワードは8文字以上にしてください' }, 400);
    }
    if (password.length > 200) {
      return c.json({ success: false, error: 'パスワードが長すぎます' }, 400);
    }
    const exists = await getStaffById(c.env.DB, id);
    if (!exists) return c.json({ success: false, error: 'Staff member not found' }, 404);

    const rec = await hashPassword(password);
    await setStaffPassword(c.env.DB, id, rec);
    // 成功のみ返す (ハッシュ/平文は返さない)。
    return c.json({ success: true, data: { id, hasPassword: true } });
  } catch (err) {
    console.error('PUT /api/staff/:id/password error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/staff/:id/unlock — owner only. Clear lockout / failed-login counter (締め出し復旧)。
staff.post('/api/staff/:id/unlock', requireRole('owner'), async (c) => {
  try {
    const id = c.req.param('id')!;
    const exists = await getStaffById(c.env.DB, id);
    if (!exists) return c.json({ success: false, error: 'Staff member not found' }, 404);
    await clearStaffLoginSecurity(c.env.DB, id);
    const updated = await getStaffById(c.env.DB, id);
    return c.json({ success: true, data: updated ? serializeStaff(updated, true) : null });
  } catch (err) {
    console.error('POST /api/staff/:id/unlock error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/staff/:id/regenerate-key — owner only. Return new API key.
staff.post('/api/staff/:id/regenerate-key', requireRole('owner'), async (c) => {
  try {
    const id = c.req.param('id')!;
    const exists = await getStaffById(c.env.DB, id);
    if (!exists) {
      return c.json({ success: false, error: 'Staff member not found' }, 404);
    }
    const newKey = await regenerateStaffApiKey(c.env.DB, id);
    return c.json({ success: true, data: { apiKey: newKey } });
  } catch (err) {
    console.error('POST /api/staff/:id/regenerate-key error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { staff };
