/**
 * roles.ts + staff.ts role_id (G64) の db helper 検証 (real SQLite / schema.sql + 086-088 replay)。
 *   - roles CRUD round-trip / deleteRole は role_permissions も掃除
 *   - setRolePermissions upsert (2 回目で上書き / 重複行を作らない) / getAllowedFeatures は allowed=1 のみ
 *   - staff role_id 割当 / countStaffByRoleId / getStaffByRoleId / reassignStaffRole
 *   - 既存 staff (role_id 未指定) は NULL のまま (回帰ゼロ)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import {
  createRole,
  getRoles,
  getRoleById,
  updateRole,
  deleteRole,
  getRolePermissions,
  getAllowedFeatures,
  setRolePermissions,
  createStaffMember,
  getStaffById,
  setStaffRoleId,
  countStaffByRoleId,
  getStaffByRoleId,
  reassignStaffRole,
  updateStaffMemberOwnerSafe,
  deleteStaffMemberOwnerSafe,
  countActiveStaffByRole,
} from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const BENIGN = /duplicate column name|already exists/i;

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
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(PKG_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(PKG_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      try { db.exec(stmt); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

let raw: Database.Database;
let DB: D1Database;

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

describe('roles CRUD', () => {
  test('create → list → get → update → delete round-trip', async () => {
    const r = await createRole(DB, { name: 'チャット対応のみ', description: '顧客対応', base_role: 'staff' });
    expect(r.id).toBeTruthy();
    expect(r.name).toBe('チャット対応のみ');
    expect(r.is_builtin).toBe(0);

    const list = await getRoles(DB);
    expect(list.map((x) => x.id)).toContain(r.id);

    const updated = await updateRole(DB, r.id, { name: 'チャット担当' });
    expect(updated!.name).toBe('チャット担当');

    await deleteRole(DB, r.id);
    expect(await getRoleById(DB, r.id)).toBeNull();
  });

  test('deleteRole は role_permissions も掃除する (孤児権限を残さない)', async () => {
    const r = await createRole(DB, { name: 'X' });
    await setRolePermissions(DB, r.id, [{ feature_key: 'chat', allowed: true }]);
    expect((await getRolePermissions(DB, r.id)).length).toBe(1);
    await deleteRole(DB, r.id);
    expect((await getRolePermissions(DB, r.id)).length).toBe(0);
  });
});

describe('role_permissions upsert / allowlist', () => {
  test('setRolePermissions は upsert (2回目で上書き・重複行を作らない)', async () => {
    const r = await createRole(DB, { name: 'X' });
    await setRolePermissions(DB, r.id, [
      { feature_key: 'chat', allowed: true },
      { feature_key: 'broadcast', allowed: false },
    ]);
    // 2 回目: chat を OFF に上書き
    await setRolePermissions(DB, r.id, [
      { feature_key: 'chat', allowed: false },
      { feature_key: 'broadcast', allowed: true },
    ]);
    const perms = await getRolePermissions(DB, r.id);
    expect(perms.length).toBe(2); // 重複行なし (UNIQUE 制約)
    const map = Object.fromEntries(perms.map((p) => [p.feature_key, p.allowed]));
    expect(map.chat).toBe(0);
    expect(map.broadcast).toBe(1);
  });

  test('getAllowedFeatures は allowed=1 の feature_key のみ返す', async () => {
    const r = await createRole(DB, { name: 'X' });
    await setRolePermissions(DB, r.id, [
      { feature_key: 'chat', allowed: true },
      { feature_key: 'friend', allowed: true },
      { feature_key: 'broadcast', allowed: false },
    ]);
    const allowed = await getAllowedFeatures(DB, r.id);
    expect(allowed.sort()).toEqual(['chat', 'friend'].sort());
  });
});

describe('staff role_id 割当 (回帰ゼロ)', () => {
  test('createStaffMember (role_id 未指定) は role_id=NULL (既存挙動)', async () => {
    const s = await createStaffMember(DB, { name: '既存スタッフ', role: 'staff' });
    const row = raw.prepare('SELECT role_id FROM staff_members WHERE id=?').get(s.id) as { role_id: string | null };
    expect(row.role_id).toBeNull();
    expect(s.role_id).toBeNull();
  });

  test('setStaffRoleId で割当 → NULL で built-in preset 復帰 (role 列は不変)', async () => {
    const r = await createRole(DB, { name: 'X' });
    const s = await createStaffMember(DB, { name: 'スタッフ', role: 'staff' });
    await setStaffRoleId(DB, s.id, r.id);
    expect((await getStaffById(DB, s.id))!.role_id).toBe(r.id);
    await setStaffRoleId(DB, s.id, null);
    const back = await getStaffById(DB, s.id);
    expect(back!.role_id).toBeNull();
    expect(back!.role).toBe('staff'); // 復帰しても enum role は不変
  });

  test('countStaffByRoleId / getStaffByRoleId / reassignStaffRole', async () => {
    const r1 = await createRole(DB, { name: 'A' });
    const r2 = await createRole(DB, { name: 'B' });
    const s1 = await createStaffMember(DB, { name: 's1', role: 'staff', role_id: r1.id });
    const s2 = await createStaffMember(DB, { name: 's2', role: 'staff', role_id: r1.id });
    expect(await countStaffByRoleId(DB, r1.id)).toBe(2);
    expect((await getStaffByRoleId(DB, r1.id)).map((x) => x.id).sort()).toEqual([s1.id, s2.id].sort());

    // r1 → r2 へ付け替え
    const moved = await reassignStaffRole(DB, r1.id, r2.id);
    expect(moved).toBe(2);
    expect(await countStaffByRoleId(DB, r1.id)).toBe(0);
    expect(await countStaffByRoleId(DB, r2.id)).toBe(2);

    // r2 → NULL (built-in 復帰)
    await reassignStaffRole(DB, r2.id, null);
    expect(await countStaffByRoleId(DB, r2.id)).toBe(0);
    expect((await getStaffById(DB, s1.id))!.role_id).toBeNull();
  });
});

describe('last-owner 原子ガード (M-5 / TOCTOU 無し)', () => {
  test('最後の active owner の降格は applied=false (単一 UPDATE のガードで弾く)', async () => {
    const o = await createStaffMember(DB, { name: 'only', role: 'owner' });
    const r = await updateStaffMemberOwnerSafe(DB, o.id, { role: 'staff' });
    expect(r.applied).toBe(false);
    expect((await getStaffById(DB, o.id))!.role).toBe('owner'); // 変わっていない
  });

  test('最後の active owner の無効化も applied=false', async () => {
    const o = await createStaffMember(DB, { name: 'only', role: 'owner' });
    const r = await updateStaffMemberOwnerSafe(DB, o.id, { is_active: 0 });
    expect(r.applied).toBe(false);
    expect((await getStaffById(DB, o.id))!.is_active).toBe(1);
  });

  test('owner が 2 人なら片方の降格は applied=true (過剰ブロックなし)', async () => {
    const o1 = await createStaffMember(DB, { name: 'o1', role: 'owner' });
    await createStaffMember(DB, { name: 'o2', role: 'owner' });
    const r = await updateStaffMemberOwnerSafe(DB, o1.id, { role: 'staff' });
    expect(r.applied).toBe(true);
    expect(r.row!.role).toBe('staff');
  });

  test('2 owner を「逐次」降格しても最低 1 owner を維持 (直列適用で後発が弾かれる)', async () => {
    const o1 = await createStaffMember(DB, { name: 'o1', role: 'owner' });
    const o2 = await createStaffMember(DB, { name: 'o2', role: 'owner' });
    const a = await updateStaffMemberOwnerSafe(DB, o1.id, { role: 'staff' });
    const b = await updateStaffMemberOwnerSafe(DB, o2.id, { role: 'staff' });
    expect(a.applied).toBe(true);
    expect(b.applied).toBe(false); // 後発は残り 1 owner を守って弾かれる
    expect(await countActiveStaffByRole(DB, 'owner')).toBe(1);
  });

  test('非 owner の更新はガードに影響されず適用される', async () => {
    await createStaffMember(DB, { name: 'o1', role: 'owner' });
    const s = await createStaffMember(DB, { name: 's', role: 'staff' });
    const r = await updateStaffMemberOwnerSafe(DB, s.id, { name: '改名' });
    expect(r.applied).toBe(true);
    expect(r.row!.name).toBe('改名');
  });

  test('最後の active owner の削除は applied=false / 2 人なら 1 人削除は applied=true', async () => {
    const o1 = await createStaffMember(DB, { name: 'o1', role: 'owner' });
    expect((await deleteStaffMemberOwnerSafe(DB, o1.id)).applied).toBe(false);
    expect(await getStaffById(DB, o1.id)).not.toBeNull();

    const o2 = await createStaffMember(DB, { name: 'o2', role: 'owner' });
    expect((await deleteStaffMemberOwnerSafe(DB, o2.id)).applied).toBe(true);
    expect(await countActiveStaffByRole(DB, 'owner')).toBe(1);
  });
});
