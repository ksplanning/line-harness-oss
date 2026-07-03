/**
 * saved-searches.ts (G10) の db helper 検証 (real SQLite / schema replay)。
 *
 *   - create→list/getById で conditions(SegmentCondition JSON) を保全 round-trip
 *   - rename は name のみ差し替え (conditions 不変) / updateConditions は conditions のみ
 *   - delete で消える
 *   - list scoping: account 行 + NULL global がその account に見え、別 account の行は見えない
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import {
  listSavedSearches,
  createSavedSearch,
  getSavedSearchById,
  renameSavedSearch,
  updateSavedSearchConditions,
  deleteSavedSearch,
} from './saved-searches.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');

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
          s.run(...(params as never[]));
          return {};
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

let raw: Database.Database;
let db: D1Database;

beforeEach(() => {
  raw = new Database(':memory:');
  raw.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  db = d1(raw);
});

const CONDS = JSON.stringify({
  operator: 'OR',
  rules: [
    { type: 'tag_exists', value: 'tag-a' },
    { type: 'ref_code', value: 'RC1' },
  ],
});

describe('saved-searches helper', () => {
  test('create → getById round-trips conditions JSON and name', async () => {
    const created = await createSavedSearch(db, { lineAccountId: 'acc-1', name: 'VIP', conditions: CONDS });
    const got = await getSavedSearchById(db, created.id);
    expect(got!.name).toBe('VIP');
    expect(got!.lineAccountId).toBe('acc-1');
    expect(JSON.parse(got!.conditions)).toEqual(JSON.parse(CONDS));
  });

  test('rename changes only the name, keeps conditions', async () => {
    const created = await createSavedSearch(db, { lineAccountId: 'acc-1', name: 'old', conditions: CONDS });
    const renamed = await renameSavedSearch(db, created.id, 'new');
    expect(renamed!.name).toBe('new');
    expect(JSON.parse(renamed!.conditions)).toEqual(JSON.parse(CONDS));
  });

  test('updateConditions changes only conditions, keeps name', async () => {
    const created = await createSavedSearch(db, { lineAccountId: 'acc-1', name: 'keep', conditions: CONDS });
    const next = JSON.stringify({ operator: 'AND', rules: [{ type: 'is_following', value: true }] });
    const updated = await updateSavedSearchConditions(db, created.id, next);
    expect(updated!.name).toBe('keep');
    expect(JSON.parse(updated!.conditions)).toEqual(JSON.parse(next));
  });

  test('delete removes the row', async () => {
    const created = await createSavedSearch(db, { lineAccountId: 'acc-1', name: 'x', conditions: CONDS });
    await deleteSavedSearch(db, created.id);
    expect(await getSavedSearchById(db, created.id)).toBeNull();
  });

  test('list scopes to the account plus NULL global, excludes other accounts', async () => {
    await createSavedSearch(db, { lineAccountId: 'acc-1', name: 'acc1', conditions: CONDS });
    await createSavedSearch(db, { lineAccountId: null, name: 'global', conditions: CONDS });
    await createSavedSearch(db, { lineAccountId: 'acc-2', name: 'acc2', conditions: CONDS });

    const forAcc1 = await listSavedSearches(db, 'acc-1');
    const names = forAcc1.map((s) => s.name).sort();
    expect(names).toEqual(['acc1', 'global']);
  });
});
