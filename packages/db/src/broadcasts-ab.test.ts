/**
 * T-C1 (F2 batch4 G1) — migration 056 が additive で ab_tests 表 + broadcasts.ab_test_id/ab_variant を
 * 足し、createBroadcast/getBroadcastById/updateBroadcast が ab 列を round-trip することの実 SQLite 検証。
 *   - 056 適用後 ab_tests 表が存在し account_id/metric/status/winner_broadcast_id を持つ
 *   - broadcasts に ab_test_id / ab_variant 列が生え、既存列 (sender_preset_id 等) は不変
 *   - createBroadcast(abTestId/abVariant) → getBroadcastById が返す (round-trip)
 *   - updateBroadcast で ab_test_id/ab_variant を後付け・解除できる
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { createBroadcast, getBroadcastById, updateBroadcast } from './broadcasts.js';

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
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES (?,?,?,?,?)`).run('acc-1', 'ch-1', 'acc-1', 'tok', 'sec');
});

describe('migration 056 — ab_tests table + broadcasts ab columns (additive)', () => {
  test('ab_tests table exists with expected columns', () => {
    const cols = raw.prepare(`PRAGMA table_info(ab_tests)`).all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(['id', 'account_id', 'name', 'metric', 'status', 'winner_broadcast_id', 'created_at', 'updated_at']),
    );
  });

  test('broadcasts gained ab_test_id / ab_variant, keeping existing columns (sender_preset_id)', () => {
    const cols = (raw.prepare(`PRAGMA table_info(broadcasts)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('ab_test_id');
    expect(cols).toContain('ab_variant');
    // 既存列不変 (末尾追記なので列ズレなし)。
    expect(cols).toContain('sender_preset_id');
    expect(cols).toContain('message_type');
    expect(cols).toContain('segment_conditions');
  });

  test('metric CHECK rejects unknown metric; status defaults to draft', () => {
    // metric CHECK IN ('open_rate','click_rate')
    expect(() =>
      raw.prepare(`INSERT INTO ab_tests (id, account_id, name, metric) VALUES ('t1','acc-1','T','bogus')`).run(),
    ).toThrow();
    raw.prepare(`INSERT INTO ab_tests (id, account_id, name, metric) VALUES ('t2','acc-1','T','open_rate')`).run();
    const row = raw.prepare(`SELECT status FROM ab_tests WHERE id='t2'`).get() as { status: string };
    expect(row.status).toBe('draft');
  });
});

describe('createBroadcast/updateBroadcast ab round-trip', () => {
  test('createBroadcast persists abTestId/abVariant and getBroadcastById returns them', async () => {
    raw.prepare(`INSERT INTO ab_tests (id, account_id, name, metric) VALUES ('ab1','acc-1','春A/B','open_rate')`).run();
    const b = await createBroadcast(db, {
      title: '案A', messageType: 'text', messageContent: 'hi', targetType: 'all',
      abTestId: 'ab1', abVariant: 'A',
    });
    expect(b.ab_test_id).toBe('ab1');
    expect(b.ab_variant).toBe('A');
    const got = await getBroadcastById(db, b.id);
    expect(got?.ab_test_id).toBe('ab1');
    expect(got?.ab_variant).toBe('A');
  });

  test('non-A/B broadcast defaults ab columns to null', async () => {
    const b = await createBroadcast(db, { title: 'x', messageType: 'text', messageContent: 'hi', targetType: 'all' });
    expect(b.ab_test_id).toBeNull();
    expect(b.ab_variant).toBeNull();
  });

  test('updateBroadcast can attach then detach ab linkage', async () => {
    raw.prepare(`INSERT INTO ab_tests (id, account_id, name, metric) VALUES ('ab2','acc-1','T','click_rate')`).run();
    const b = await createBroadcast(db, { title: 'x', messageType: 'text', messageContent: 'hi', targetType: 'all' });
    await updateBroadcast(db, b.id, { ab_test_id: 'ab2', ab_variant: 'B' });
    expect((await getBroadcastById(db, b.id))?.ab_variant).toBe('B');
    await updateBroadcast(db, b.id, { ab_test_id: null, ab_variant: null });
    const cleared = await getBroadcastById(db, b.id);
    expect(cleared?.ab_test_id).toBeNull();
    expect(cleared?.ab_variant).toBeNull();
  });
});
