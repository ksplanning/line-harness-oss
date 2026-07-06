/**
 * T-F1 (batch F) — migration 076 (staff_members ID/PASS 列) + staff.ts の password/lockout helper 検証。
 *
 *   - 076 が additive で password 列を足し、既存行は login_id/password NULL (= api_key ログイン維持)
 *   - login_id は正規化 (LOWER(TRIM)) して保存・照合、partial unique index で重複禁止 (GC-5)
 *   - setStaffPassword は hash 列を保存し失敗カウント/lock を解除 (平文は扱わない)
 *   - incrementFailedLogin / setStaffLockout / isStaffLocked (julianday 比較 / M-4) / clear の往復
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import {
  normalizeLoginId,
  getStaffByLoginId,
  setStaffLoginId,
  setStaffPassword,
  incrementFailedLogin,
  setStaffLockout,
  clearStaffLoginSecurity,
  isStaffLocked,
} from './staff.js';
import { jstNow } from './utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const BENIGN = /duplicate column name|already exists/i;

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const s = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) {
          params = args;
          return api;
        },
        async first<T>() {
          return (s.get(...(params as never[])) as T) ?? null;
        },
        async all<T>() {
          return { results: s.all(...(params as never[])) as T[] };
        },
        async run() {
          const info = s.run(...(params as never[]));
          return { meta: { changes: info.changes } };
        },
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
let db: D1Database;

function seedStaff(id: string, role = 'staff', apiKey = `lh_${id}`) {
  const now = jstNow();
  raw.prepare(
    `INSERT INTO staff_members (id, name, email, role, api_key, is_active, created_at, updated_at)
     VALUES (?,?,?,?,?,1,?,?)`,
  ).run(id, `Name ${id}`, null, role, apiKey, now, now);
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  db = d1(raw);
});

describe('migration 076 — staff_members ID/PASS 列 (additive)', () => {
  test('password 列が生え、既存行は login_id/password NULL・failed_login_count=0', () => {
    seedStaff('s1');
    const cols = (raw.prepare(`PRAGMA table_info(staff_members)`).all() as { name: string }[]).map((c) => c.name);
    for (const c of ['login_id', 'password_hash', 'password_salt', 'password_algo', 'password_iterations', 'password_updated_at', 'failed_login_count', 'locked_until']) {
      expect(cols).toContain(c);
    }
    const row = raw.prepare(`SELECT * FROM staff_members WHERE id='s1'`).get() as Record<string, unknown>;
    expect(row.login_id).toBeNull();
    expect(row.password_hash).toBeNull();
    expect(row.failed_login_count).toBe(0);
    expect(row.password_algo).toBe('pbkdf2-sha256'); // DEFAULT
    // 既存 api_key ログイン列は不変。
    expect(row.api_key).toBe('lh_s1');
  });
});

describe('normalizeLoginId', () => {
  test('前後空白除去 + 小文字化', () => {
    expect(normalizeLoginId('  Owner_KS  ')).toBe('owner_ks');
    expect(normalizeLoginId('ADMIN')).toBe('admin');
  });
});

describe('login_id 設定と照合 (GC-5)', () => {
  test('setStaffLoginId は正規化して保存し、getStaffByLoginId は大文字入力でも引ける', async () => {
    seedStaff('s1');
    const r = await setStaffLoginId(db, 's1', '  Owner_KS ');
    expect(r).toEqual({ ok: true });
    const found = await getStaffByLoginId(db, 'OWNER_KS');
    expect(found?.id).toBe('s1');
  });

  test('重複 login_id は partial unique index で弾かれ { ok:false, duplicate }', async () => {
    seedStaff('s1');
    seedStaff('s2');
    expect(await setStaffLoginId(db, 's1', 'owner')).toEqual({ ok: true });
    expect(await setStaffLoginId(db, 's2', 'Owner')).toEqual({ ok: false, error: 'duplicate' });
  });

  test('login_id 未設定 (NULL) の行は複数あっても衝突しない (partial index)', () => {
    seedStaff('s1');
    seedStaff('s2');
    // 両方 login_id=NULL でも UNIQUE 違反にならない。
    const n = raw.prepare(`SELECT COUNT(*) c FROM staff_members WHERE login_id IS NULL`).get() as { c: number };
    expect(n.c).toBe(2);
  });

  test('非アクティブ staff は getStaffByLoginId で引かない', async () => {
    seedStaff('s1');
    await setStaffLoginId(db, 's1', 'owner');
    raw.prepare(`UPDATE staff_members SET is_active=0 WHERE id='s1'`).run();
    expect(await getStaffByLoginId(db, 'owner')).toBeNull();
  });
});

describe('setStaffPassword', () => {
  test('hash 列を保存し failed_login_count/locked_until を解除する', async () => {
    seedStaff('s1');
    await incrementFailedLogin(db, 's1');
    await setStaffPassword(db, 's1', { password_hash: 'HASH', password_salt: 'SALT', password_algo: 'pbkdf2-sha256', password_iterations: 210000 });
    const row = raw.prepare(`SELECT * FROM staff_members WHERE id='s1'`).get() as Record<string, unknown>;
    expect(row.password_hash).toBe('HASH');
    expect(row.password_salt).toBe('SALT');
    expect(row.password_iterations).toBe(210000);
    expect(row.password_updated_at).not.toBeNull();
    expect(row.failed_login_count).toBe(0);
    expect(row.locked_until).toBeNull();
  });
});

describe('lockout (D1 権威 / julianday 比較 / M-4)', () => {
  test('incrementFailedLogin は失敗回数を増やす', async () => {
    seedStaff('s1');
    expect(await incrementFailedLogin(db, 's1')).toBe(1);
    expect(await incrementFailedLogin(db, 's1')).toBe(2);
  });

  test('未来の locked_until は lock 中・過去は lock されていない', async () => {
    seedStaff('s1');
    // 1 時間後 (JST) → lock 中。
    const future = jstFuture(60);
    await setStaffLockout(db, 's1', future);
    expect(await isStaffLocked(db, 's1')).toBe(true);
    // 過去 → lock 解除扱い。
    const past = jstFuture(-60);
    await setStaffLockout(db, 's1', past);
    expect(await isStaffLocked(db, 's1')).toBe(false);
  });

  test('clearStaffLoginSecurity で failed/lock がリセットされる (owner 手動解除)', async () => {
    seedStaff('s1');
    await incrementFailedLogin(db, 's1');
    await setStaffLockout(db, 's1', jstFuture(60));
    await clearStaffLoginSecurity(db, 's1');
    const row = raw.prepare(`SELECT failed_login_count, locked_until FROM staff_members WHERE id='s1'`).get() as { failed_login_count: number; locked_until: string | null };
    expect(row.failed_login_count).toBe(0);
    expect(row.locked_until).toBeNull();
    expect(await isStaffLocked(db, 's1')).toBe(false);
  });
});

/** now(JST) + minutes を JST 文字列で返す (locked_until 用のテストヘルパ)。 */
function jstFuture(minutes: number): string {
  const nowJst = new Date(Date.now() + 9 * 3600_000 + minutes * 60_000);
  return nowJst.toISOString().replace('Z', '').replace(/(\.\d{3})\d*$/, '$1');
}
