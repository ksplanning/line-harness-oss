/**
 * T-C5 (F2 batch4 G1) — ab_tests db model が account-scoped (create/get/list/update/delete) であること
 * の実 SQLite 検証。別 account の A/B テストは一覧に出ず、id を知っていても取得/更新/削除できない。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { createAbTest, getAbTestById, listAbTests, updateAbTest, deleteAbTest } from './ab-tests.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(PKG_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(PKG_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      try { db.exec(stmt); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const s = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...a: unknown[]) { params = a; return api; },
        async first<T>() { return (s.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: s.all(...(params as never[])) as T[] }; },
        async run() { const i = s.run(...(params as never[])); return { meta: { changes: i.changes } }; },
      };
      return api;
    },
  } as unknown as D1Database;
}

let raw: Database.Database;
let db: D1Database;
beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  db = d1(raw);
  for (const a of ['acc-1', 'acc-2']) {
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES (?,?,?,?,?)`).run(a, `ch-${a}`, a, 'tok', 'sec');
  }
});

describe('ab_tests db model (account-scoped)', () => {
  test('create → getById is account-scoped (foreign account gets null)', async () => {
    const t = await createAbTest(db, { accountId: 'acc-1', name: '春A/B', metric: 'open_rate' });
    expect(t.id).toBeTruthy();
    expect(t.status).toBe('draft');
    expect((await getAbTestById(db, t.id, 'acc-1'))?.name).toBe('春A/B');
    expect(await getAbTestById(db, t.id, 'acc-2')).toBeNull();
  });

  test('list is account-scoped', async () => {
    await createAbTest(db, { accountId: 'acc-1', name: 'A', metric: 'open_rate' });
    await createAbTest(db, { accountId: 'acc-2', name: 'B', metric: 'click_rate' });
    expect((await listAbTests(db, 'acc-1')).map((t) => t.name)).toEqual(['A']);
    expect((await listAbTests(db, 'acc-2')).map((t) => t.name)).toEqual(['B']);
  });

  test('update/delete are account-scoped (foreign account = no-op)', async () => {
    const t = await createAbTest(db, { accountId: 'acc-1', name: 'A', metric: 'open_rate' });
    await updateAbTest(db, t.id, 'acc-2', { name: 'HACKED', status: 'decided' });
    expect((await getAbTestById(db, t.id, 'acc-1'))?.name).toBe('A');
    await deleteAbTest(db, t.id, 'acc-2');
    expect(await getAbTestById(db, t.id, 'acc-1')).not.toBeNull();
    // 自 account の update/delete は効く。
    await updateAbTest(db, t.id, 'acc-1', { status: 'running', winnerBroadcastId: null });
    expect((await getAbTestById(db, t.id, 'acc-1'))?.status).toBe('running');
    await deleteAbTest(db, t.id, 'acc-1');
    expect(await getAbTestById(db, t.id, 'acc-1')).toBeNull();
  });

  test('metric CHECK rejects unknown values at the db layer', () => {
    expect(() =>
      raw.prepare(`INSERT INTO ab_tests (id, account_id, name, metric) VALUES ('x','acc-1','T','bogus')`).run(),
    ).toThrow();
  });
});
