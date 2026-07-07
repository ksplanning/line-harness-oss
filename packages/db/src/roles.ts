import { jstNow } from './utils.js';

// =============================================================================
// カスタムロール + 機能単位権限 (G64 / migration 086-087)
// -----------------------------------------------------------------------------
// built-in の owner/admin/staff はコード定数 (worker BUILTIN_ROLE_PRESETS) なので本テーブルには
// 入らない。ここは owner が作った custom role とその機能単位 ON/OFF (role_permissions) のみ扱う。
// feature_key はここでは string 型 (DB 都合)。有効な 19 feature_key の検証は worker 層 (isFeatureKey)。
// =============================================================================

export interface Role {
  id: string;
  name: string;
  description: string | null;
  base_role: string;
  is_builtin: number;
  created_at: string;
  updated_at: string;
}

export interface RolePermission {
  feature_key: string;
  allowed: number;
}

export interface CreateRoleInput {
  name: string;
  description?: string | null;
  base_role?: string;
}

export interface UpdateRoleInput {
  name?: string;
  description?: string | null;
}

export async function createRole(db: D1Database, input: CreateRoleInput): Promise<Role> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO roles (id, name, description, base_role, is_builtin, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(id, input.name, input.description ?? null, input.base_role ?? 'staff', now, now)
    .run();
  return (await db.prepare('SELECT * FROM roles WHERE id = ?').bind(id).first<Role>())!;
}

export async function getRoles(db: D1Database): Promise<Role[]> {
  const result = await db
    .prepare('SELECT * FROM roles ORDER BY created_at ASC')
    .all<Role>();
  return result.results;
}

export async function getRoleById(db: D1Database, id: string): Promise<Role | null> {
  return db.prepare('SELECT * FROM roles WHERE id = ?').bind(id).first<Role>();
}

export async function updateRole(
  db: D1Database,
  id: string,
  input: UpdateRoleInput,
): Promise<Role | null> {
  const now = jstNow();
  const sets: string[] = ['updated_at = ?'];
  const values: (string | number | null)[] = [now];
  if (input.name !== undefined) { sets.push('name = ?'); values.push(input.name); }
  if (input.description !== undefined) { sets.push('description = ?'); values.push(input.description ?? null); }
  values.push(id);
  await db.prepare(`UPDATE roles SET ${sets.join(', ')} WHERE id = ?`).bind(...values).run();
  return db.prepare('SELECT * FROM roles WHERE id = ?').bind(id).first<Role>();
}

/** ロール本体を削除。role_permissions も併せて掃除する (孤児権限行を残さない)。
 *  ⚠️ 割当済み staff の role_id 再割当は呼び出し側 (worker) が deleteRole より前に行うこと (§5 / T-C3)。 */
export async function deleteRole(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM role_permissions WHERE role_id = ?').bind(id).run();
  await db.prepare('DELETE FROM roles WHERE id = ?').bind(id).run();
}

export async function getRolePermissions(db: D1Database, roleId: string): Promise<RolePermission[]> {
  const result = await db
    .prepare('SELECT feature_key, allowed FROM role_permissions WHERE role_id = ?')
    .bind(roleId)
    .all<RolePermission>();
  return result.results;
}

/** allowed=1 の feature_key だけを返す (resolvePermissions の素材)。 */
export async function getAllowedFeatures(db: D1Database, roleId: string): Promise<string[]> {
  const result = await db
    .prepare('SELECT feature_key FROM role_permissions WHERE role_id = ? AND allowed = 1')
    .bind(roleId)
    .all<{ feature_key: string }>();
  return result.results.map((r) => r.feature_key);
}

/**
 * ロールの機能権限を一括保存 (upsert)。渡した feature 集合で **全置換相当** の意味を持たせるため、
 * 各 feature_key を UNIQUE(role_id, feature_key) 上で INSERT ... ON CONFLICT DO UPDATE する。
 * custom role は 19 feature を全て明示保存する運用 (未列挙 feature は worker で deny / Codex CRITICAL-1)。
 */
export async function setRolePermissions(
  db: D1Database,
  roleId: string,
  perms: Array<{ feature_key: string; allowed: boolean }>,
): Promise<void> {
  const now = jstNow();
  for (const p of perms) {
    await db
      .prepare(
        `INSERT INTO role_permissions (id, role_id, feature_key, allowed, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(role_id, feature_key) DO UPDATE SET allowed = excluded.allowed`,
      )
      .bind(crypto.randomUUID(), roleId, p.feature_key, p.allowed ? 1 : 0, now)
      .run();
  }
}
