import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import {
  createRole,
  updateRole,
  getRolePermissions,
  getAllowedFeatures,
  setRolePermissions,
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

describe('roles characterization: create and partial update', () => {
  test('createRole applies the current defaults when optional fields are omitted', async () => {
    const role = await createRole(DB, { name: 'X' });

    expect(role).toMatchObject({
      base_role: 'staff',
      description: null,
      is_builtin: 0,
    });
  });

  test('createRole preserves the current null description behavior', async () => {
    const role = await createRole(DB, { name: 'X', description: null });

    expect(role.description).toBeNull();
  });

  test('updateRole preserves an omitted description when changing the name', async () => {
    const role = await createRole(DB, { name: 'before', description: 'foo' });

    const updated = await updateRole(DB, role.id, { name: 'new' });

    expect(updated).toMatchObject({ name: 'new', description: 'foo' });
  });

  test('updateRole clears the description only when null is explicit', async () => {
    const role = await createRole(DB, { name: 'unchanged', description: 'foo' });

    const updated = await updateRole(DB, role.id, { description: null });

    expect(updated).toMatchObject({ name: 'unchanged', description: null });
  });

  test('updateRole with an empty input preserves name and description', async () => {
    const role = await createRole(DB, { name: 'n', description: 'd' });

    const updated = await updateRole(DB, role.id, {});

    expect(updated).toMatchObject({ name: 'n', description: 'd' });
  });

  test('updateRole returns null for a missing role', async () => {
    await expect(updateRole(DB, 'no-such-id', { name: 'x' })).resolves.toBeNull();
  });
});

describe('roles characterization: empty permission operations', () => {
  test('setRolePermissions with an empty list creates no permission rows', async () => {
    const role = await createRole(DB, { name: 'X' });

    await setRolePermissions(DB, role.id, []);

    expect(await getRolePermissions(DB, role.id)).toEqual([]);
  });

  test('getAllowedFeatures returns an empty list when no permissions exist', async () => {
    const role = await createRole(DB, { name: 'X' });

    expect(await getAllowedFeatures(DB, role.id)).toEqual([]);
  });

  test('getRolePermissions returns an empty list for a missing role', async () => {
    expect(await getRolePermissions(DB, 'no-such')).toEqual([]);
  });
});
