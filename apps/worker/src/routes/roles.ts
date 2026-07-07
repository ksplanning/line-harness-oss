import { Hono } from 'hono';
import {
  createRole,
  getRoles,
  getRoleById,
  updateRole,
  deleteRole,
  getAllowedFeatures,
  setRolePermissions,
  countStaffByRoleId,
  reassignStaffRole,
} from '@line-crm/db';
import {
  FEATURE_KEYS,
  isFeatureKey,
  getRoleTemplate,
  type FeatureKey,
} from '@line-crm/shared';
import { requireRole } from '../middleware/role-guard.js';
import type { Env } from '../index.js';

// =============================================================================
// /api/roles — カスタムロール CRUD + 機能マトリクス (G64 / owner only)
// -----------------------------------------------------------------------------
// permissionMiddleware は /api/roles を staff_admin feature で gate し、加えて requireRole('owner') で
// 二重に締める (多層防御)。ロール本体はここで CRUD し、機能単位 ON/OFF は role_permissions に厳格 allowlist
// で保存する (19 feature を常に明示 / 未列挙 deny)。
// =============================================================================

export const roles = new Hono<Env>();

/** 提供された permissions map から 19 feature 全てを明示した allowlist を作る (未指定=false)。 */
function normalizePermissions(input: unknown): Array<{ feature_key: FeatureKey; allowed: boolean }> {
  const map: Record<string, boolean> = {};
  if (input && typeof input === 'object') {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (isFeatureKey(k)) map[k] = Boolean(v);
    }
  }
  return FEATURE_KEYS.map((f) => ({ feature_key: f, allowed: map[f] ?? false }));
}

/** テンプレ id から 19 feature の allowlist を作る。 */
function permissionsFromTemplate(templateId: string): Array<{ feature_key: FeatureKey; allowed: boolean }> | null {
  const tpl = getRoleTemplate(templateId);
  if (!tpl) return null;
  const set = new Set(tpl.features);
  return FEATURE_KEYS.map((f) => ({ feature_key: f, allowed: set.has(f) }));
}

async function serializeRole(db: D1Database, id: string) {
  const role = await getRoleById(db, id);
  if (!role) return null;
  const allowed = (await getAllowedFeatures(db, id)).filter(isFeatureKey);
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    baseRole: role.base_role,
    isBuiltin: Boolean(role.is_builtin),
    createdAt: role.created_at,
    updatedAt: role.updated_at,
    features: allowed, // allowed=1 の feature_key
  };
}

// GET /api/roles — 一覧 (各ロールの許可 feature 付き)。
roles.get('/api/roles', requireRole('owner'), async (c) => {
  try {
    const list = await getRoles(c.env.DB);
    const data = [];
    for (const r of list) {
      const allowed = (await getAllowedFeatures(c.env.DB, r.id)).filter(isFeatureKey);
      const assignedCount = await countStaffByRoleId(c.env.DB, r.id);
      data.push({
        id: r.id,
        name: r.name,
        description: r.description,
        baseRole: r.base_role,
        isBuiltin: Boolean(r.is_builtin),
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        features: allowed,
        assignedCount,
      });
    }
    return c.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/roles error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// GET /api/roles/:id — 詳細。
roles.get('/api/roles/:id', requireRole('owner'), async (c) => {
  try {
    const data = await serializeRole(c.env.DB, c.req.param('id')!);
    if (!data) return c.json({ success: false, error: 'ロールが見つかりません' }, 404);
    return c.json({ success: true, data });
  } catch (err) {
    console.error('GET /api/roles/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// POST /api/roles — 作成。template (テンプレから) or permissions (明示マトリクス) or 白紙 (全 OFF)。
roles.post('/api/roles', requireRole('owner'), async (c) => {
  try {
    const body = await c.req.json<{
      name?: string;
      description?: string | null;
      baseRole?: string;
      template?: string;
      permissions?: Record<string, boolean>;
    }>().catch(() => ({}) as Record<string, never>);

    if (!body.name || !body.name.trim()) {
      return c.json({ success: false, error: 'ロール名を入力してください' }, 400);
    }

    // permissions の出所: 明示 permissions > template > 白紙 (全 OFF)。
    let perms: Array<{ feature_key: FeatureKey; allowed: boolean }>;
    if (body.permissions) {
      perms = normalizePermissions(body.permissions);
    } else if (body.template) {
      const fromTpl = permissionsFromTemplate(body.template);
      if (!fromTpl) return c.json({ success: false, error: 'テンプレートが不正です' }, 400);
      perms = fromTpl;
    } else {
      perms = normalizePermissions({}); // 全 OFF
    }

    const role = await createRole(c.env.DB, {
      name: body.name.trim(),
      description: body.description ?? null,
      base_role: body.baseRole ?? 'staff',
    });
    await setRolePermissions(c.env.DB, role.id, perms);

    const data = await serializeRole(c.env.DB, role.id);
    return c.json({ success: true, data }, 201);
  } catch (err) {
    console.error('POST /api/roles error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/roles/:id — 名前/説明の更新。
roles.put('/api/roles/:id', requireRole('owner'), async (c) => {
  try {
    const id = c.req.param('id')!;
    const body = await c.req
      .json<{ name?: string; description?: string | null }>()
      .catch(() => ({} as { name?: string; description?: string | null }));
    if (body.name !== undefined && !body.name.trim()) {
      return c.json({ success: false, error: 'ロール名を入力してください' }, 400);
    }
    const updated = await updateRole(c.env.DB, id, {
      name: body.name?.trim(),
      description: body.description,
    });
    if (!updated) return c.json({ success: false, error: 'ロールが見つかりません' }, 404);
    return c.json({ success: true, data: await serializeRole(c.env.DB, id) });
  } catch (err) {
    console.error('PUT /api/roles/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// PUT /api/roles/:id/permissions — 権限マトリクス保存 (19 feature を厳格 allowlist で上書き)。
roles.put('/api/roles/:id/permissions', requireRole('owner'), async (c) => {
  try {
    const id = c.req.param('id')!;
    const role = await getRoleById(c.env.DB, id);
    if (!role) return c.json({ success: false, error: 'ロールが見つかりません' }, 404);
    const body = await c.req
      .json<{ permissions?: Record<string, boolean> }>()
      .catch(() => ({} as { permissions?: Record<string, boolean> }));
    const perms = normalizePermissions(body.permissions ?? {});
    await setRolePermissions(c.env.DB, id, perms);
    return c.json({ success: true, data: await serializeRole(c.env.DB, id) });
  } catch (err) {
    console.error('PUT /api/roles/:id/permissions error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// DELETE /api/roles/:id — 削除。割当済み staff は reassignTo (別 role.id) or NULL(built-in 復帰) へ
// 付け替えてから削除する (孤児 role_id を残さない / §5 / T-C3)。
roles.delete('/api/roles/:id', requireRole('owner'), async (c) => {
  try {
    const id = c.req.param('id')!;
    const role = await getRoleById(c.env.DB, id);
    if (!role) return c.json({ success: false, error: 'ロールが見つかりません' }, 404);

    const assigned = await countStaffByRoleId(c.env.DB, id);
    if (assigned > 0) {
      // reassignTo: 別 role.id (存在する custom role) or null (built-in preset 復帰)。未指定は 400。
      const body = await c.req.json<{ reassignTo?: string | null }>().catch(() => ({}));
      if (!('reassignTo' in body)) {
        return c.json(
          {
            success: false,
            error: `このロールは ${assigned} 名に割り当てられています。付け替え先 (reassignTo: 別ロールID または null) を指定してください`,
            assignedCount: assigned,
          },
          400,
        );
      }
      const reassignTo = body.reassignTo ?? null;
      if (reassignTo !== null) {
        if (reassignTo === id) {
          return c.json({ success: false, error: '削除対象と同じロールには付け替えできません' }, 400);
        }
        const target = await getRoleById(c.env.DB, reassignTo);
        if (!target) return c.json({ success: false, error: '付け替え先ロールが存在しません' }, 400);
      }
      await reassignStaffRole(c.env.DB, id, reassignTo);
    }

    await deleteRole(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/roles/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});
