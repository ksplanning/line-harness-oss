/**
 * BUILTIN_ROLE_PRESETS + resolvePermissions (G64 / T-A2) — real SQLite。
 *   - built-in owner/admin/staff は 19 feature 全許可 (現状 byte-identical の要)
 *   - role_id NULL / env-owner → preset で解決 (isBuiltin=true)
 *   - custom role → allowed=1 の feature のみ (行なし=deny / 厳格 allowlist)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { FEATURE_KEYS } from '@line-crm/shared';
import { createRole, setRolePermissions } from '@line-crm/db';
import { BUILTIN_ROLE_PRESETS, resolvePermissions } from './permissions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
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
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(DB_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(DB_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
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

describe('BUILTIN_ROLE_PRESETS (byte-identical の要)', () => {
  test('owner / admin / staff とも 20 feature 全許可', () => {
    for (const role of ['owner', 'admin', 'staff'] as const) {
      const preset = BUILTIN_ROLE_PRESETS[role];
      for (const f of FEATURE_KEYS) {
        expect(preset.has(f), `${role} は ${f} を許可すべき (現状全 route 到達可)`).toBe(true);
      }
      expect(preset.size).toBe(20);
    }
  });
});

describe('resolvePermissions', () => {
  test('env-owner → built-in 全許可', async () => {
    const p = await resolvePermissions(DB, { id: 'env-owner', role: 'owner', roleId: null });
    expect(p.isBuiltin).toBe(true);
    expect(p.features.length).toBe(20);
    expect(p.allows('staff_admin')).toBe(true);
  });

  test('role_id NULL の staff → staff preset (全許可)', async () => {
    const p = await resolvePermissions(DB, { id: 's1', role: 'staff', roleId: null });
    expect(p.isBuiltin).toBe(true);
    expect(p.allows('chat')).toBe(true);
    expect(p.allows('staff_admin')).toBe(true);
  });

  test('custom role → allowed=1 の feature のみ / 行が無い feature は deny', async () => {
    const r = await createRole(DB, { name: 'チャットのみ' });
    await setRolePermissions(DB, r.id, [
      { feature_key: 'chat', allowed: true },
      { feature_key: 'friend', allowed: true },
      { feature_key: 'broadcast', allowed: false },
    ]);
    const p = await resolvePermissions(DB, { id: 's2', role: 'staff', roleId: r.id });
    expect(p.isBuiltin).toBe(false);
    expect(p.allows('chat')).toBe(true);
    expect(p.allows('friend')).toBe(true);
    expect(p.allows('broadcast')).toBe(false); // 明示 OFF
    expect(p.allows('staff_admin')).toBe(false); // 行なし = deny (fallback しない)
    expect(p.features.sort()).toEqual(['chat', 'friend'].sort());
  });
});
