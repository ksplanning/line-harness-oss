import { jstNow } from './utils.js';

export interface StaffMember {
  id: string;
  name: string;
  email: string | null;
  role: 'owner' | 'admin' | 'staff';
  api_key: string;
  is_active: number;
  created_at: string;
  updated_at: string;
  // ID/PASS ログイン列 (migration 076 / batch F)。既存行は NULL (= api_key ログイン維持)。
  // これらは serialize whitelist に入れない = API/ログに露出させない (GC-4)。
  login_id: string | null;
  password_hash: string | null;
  password_salt: string | null;
  password_algo: string | null;
  password_iterations: number | null;
  password_updated_at: string | null;
  failed_login_count: number | null;
  locked_until: string | null;
}

export interface CreateStaffInput {
  name: string;
  email?: string | null;
  role: 'owner' | 'admin' | 'staff';
}

export interface UpdateStaffInput {
  name?: string;
  email?: string | null;
  role?: 'owner' | 'admin' | 'staff';
  is_active?: number;
}

function generateApiKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return `lh_${hex}`;
}

export async function getStaffByApiKey(
  db: D1Database,
  apiKey: string,
): Promise<StaffMember | null> {
  return db
    .prepare('SELECT * FROM staff_members WHERE api_key = ? AND is_active = 1')
    .bind(apiKey)
    .first<StaffMember>();
}

export async function getStaffMembers(db: D1Database): Promise<StaffMember[]> {
  const result = await db
    .prepare('SELECT * FROM staff_members ORDER BY created_at ASC')
    .all<StaffMember>();
  return result.results;
}

export async function getStaffById(
  db: D1Database,
  id: string,
): Promise<StaffMember | null> {
  return db
    .prepare('SELECT * FROM staff_members WHERE id = ?')
    .bind(id)
    .first<StaffMember>();
}

export async function createStaffMember(
  db: D1Database,
  input: CreateStaffInput,
): Promise<StaffMember> {
  const id = crypto.randomUUID();
  const now = jstNow();
  const apiKey = generateApiKey();

  await db
    .prepare(
      `INSERT INTO staff_members (id, name, email, role, api_key, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(id, input.name, input.email ?? null, input.role, apiKey, now, now)
    .run();

  return (await db
    .prepare('SELECT * FROM staff_members WHERE id = ?')
    .bind(id)
    .first<StaffMember>())!;
}

export async function updateStaffMember(
  db: D1Database,
  id: string,
  input: UpdateStaffInput,
): Promise<StaffMember | null> {
  const now = jstNow();
  const sets: string[] = ['updated_at = ?'];
  const values: (string | number | null)[] = [now];

  if (input.name !== undefined) { sets.push('name = ?'); values.push(input.name); }
  if (input.email !== undefined) { sets.push('email = ?'); values.push(input.email ?? null); }
  if (input.role !== undefined) { sets.push('role = ?'); values.push(input.role); }
  if (input.is_active !== undefined) { sets.push('is_active = ?'); values.push(input.is_active); }

  values.push(id);
  await db
    .prepare(`UPDATE staff_members SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();

  return db.prepare('SELECT * FROM staff_members WHERE id = ?').bind(id).first<StaffMember>();
}

export async function deleteStaffMember(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM staff_members WHERE id = ?').bind(id).run();
}

export async function regenerateStaffApiKey(db: D1Database, id: string): Promise<string> {
  const newKey = generateApiKey();
  const now = jstNow();
  const result = await db
    .prepare('UPDATE staff_members SET api_key = ?, updated_at = ? WHERE id = ?')
    .bind(newKey, now, id)
    .run();
  if (result.meta.changes === 0) {
    throw new Error(`Staff member not found: ${id}`);
  }
  return newKey;
}

export async function countStaffByRole(db: D1Database, role: string): Promise<number> {
  const result = await db
    .prepare('SELECT COUNT(*) as count FROM staff_members WHERE role = ?')
    .bind(role)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

export async function countActiveStaffByRole(db: D1Database, role: string): Promise<number> {
  const result = await db
    .prepare('SELECT COUNT(*) as count FROM staff_members WHERE role = ? AND is_active = 1')
    .bind(role)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

// ─── ID/PASS ログイン (batch F / migration 076) ────────────────────────────────

/** ログイン ID の正規化 (GC-5): 前後空白除去 + 小文字化。保存も照合も必ずこれを通す。 */
export function normalizeLoginId(raw: string): string {
  return raw.trim().toLowerCase();
}

export interface StaffPasswordFields {
  password_hash: string;
  password_salt: string;
  password_algo: string;
  password_iterations: number;
}

/** 正規化済み login_id で有効な staff を引く。password ログインの入口。 */
export async function getStaffByLoginId(
  db: D1Database,
  loginId: string,
): Promise<StaffMember | null> {
  const normalized = normalizeLoginId(loginId);
  if (!normalized) return null;
  return db
    .prepare('SELECT * FROM staff_members WHERE login_id = ? AND is_active = 1')
    .bind(normalized)
    .first<StaffMember>();
}

/**
 * login_id を設定 (正規化して保存)。partial unique index 違反 (別 staff が同じ login_id を保有) は
 * { ok: false, error: 'duplicate' } として返す (呼び出し側が日本語エラーに変換 / GC-5)。
 */
export async function setStaffLoginId(
  db: D1Database,
  id: string,
  loginId: string,
): Promise<{ ok: true } | { ok: false; error: 'duplicate' }> {
  const normalized = normalizeLoginId(loginId);
  const now = jstNow();
  try {
    await db
      .prepare('UPDATE staff_members SET login_id = ?, updated_at = ? WHERE id = ?')
      .bind(normalized, now, id)
      .run();
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/unique/i.test(msg)) return { ok: false, error: 'duplicate' };
    throw err;
  }
}

/**
 * PBKDF2 ハッシュ済みの password を保存。平文は受け取らない (呼び出し側が hash してから渡す)。
 * 成功時は失敗カウント/lock も解除する (パスワード再設定 = 復旧手段)。
 */
export async function setStaffPassword(
  db: D1Database,
  id: string,
  fields: StaffPasswordFields,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      `UPDATE staff_members
         SET password_hash = ?, password_salt = ?, password_algo = ?, password_iterations = ?,
             password_updated_at = ?, failed_login_count = 0, locked_until = NULL, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      fields.password_hash,
      fields.password_salt,
      fields.password_algo,
      fields.password_iterations,
      now,
      now,
      id,
    )
    .run();
}

/** ログイン失敗を記録し、更新後の失敗回数を返す (D1 権威 lockout の素材 / M-23)。 */
export async function incrementFailedLogin(db: D1Database, id: string): Promise<number> {
  const now = jstNow();
  await db
    .prepare(
      'UPDATE staff_members SET failed_login_count = COALESCE(failed_login_count, 0) + 1, updated_at = ? WHERE id = ?',
    )
    .bind(now, id)
    .run();
  const row = await db
    .prepare('SELECT failed_login_count FROM staff_members WHERE id = ?')
    .bind(id)
    .first<{ failed_login_count: number | null }>();
  return row?.failed_login_count ?? 0;
}

/** locked_until を設定 (JST 文字列)。lock 判定は julianday 比較 (M-4)。 */
export async function setStaffLockout(
  db: D1Database,
  id: string,
  lockedUntil: string,
): Promise<void> {
  const now = jstNow();
  await db
    .prepare('UPDATE staff_members SET locked_until = ?, updated_at = ? WHERE id = ?')
    .bind(lockedUntil, now, id)
    .run();
}

/** 失敗カウントと lock を解除 (ログイン成功時 / owner による手動リセット)。 */
export async function clearStaffLoginSecurity(db: D1Database, id: string): Promise<void> {
  const now = jstNow();
  await db
    .prepare(
      'UPDATE staff_members SET failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ?',
    )
    .bind(now, id)
    .run();
}

/**
 * account が現在 lock 中か (D1 権威 / julianday 比較 = 辞書比較しない / M-4)。
 * locked_until が未来なら lock 中。過去/NULL なら lock されていない。
 */
export async function isStaffLocked(db: D1Database, id: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS locked FROM staff_members
        WHERE id = ?
          AND locked_until IS NOT NULL
          AND julianday(locked_until) > julianday(strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))`,
    )
    .bind(id)
    .first<{ locked: number }>();
  return Boolean(row);
}
