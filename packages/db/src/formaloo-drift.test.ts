/**
 * T-A3 (formaloo-auto-pull / db 層) — drift 追跡 helper。
 *   ① listLinkedFormalooForms: formaloo_slug NOT NULL かつ deleted=0 の form のみ返す。
 *   ② setFormalooSyncState: drift パラメータ additive 更新 (present-key で列更新 / undefined 保持 /
 *      null 明示クリア)。drift key を渡さない既存呼出は後方互換 (drift_status 既定 'none')。
 *   ③ recordFormalooDriftEvent → listFormalooDriftEvents: 記録行を新しい順に返す。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import {
  listLinkedFormalooForms,
  setFormalooSyncState,
  getFormalooSyncState,
  recordFormalooDriftEvent,
  listFormalooDriftEvents,
} from './formaloo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const BENIGN = /duplicate column name|already exists/i;

function d1(db: Database.Database): D1Database {
  function makeStmt(sql: string) {
    const s = db.prepare(sql);
    let params: unknown[] = [];
    return {
      bind(...args: unknown[]) { params = args; return this; },
      async first<T>() { return (s.get(...(params as never[])) as T) ?? null; },
      async all<T>() { return { results: s.all(...(params as never[])) as T[] }; },
      async run() { const info = s.run(...(params as never[])); return { meta: { changes: info.changes } }; },
    };
  }
  return { prepare(sql: string) { return makeStmt(sql); } } as unknown as D1Database;
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

function seedForm(id: string, opts: { slug?: string | null; deleted?: number } = {}) {
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, definition_json, formaloo_slug, deleted)
     VALUES (?, ?, '{"fields":[],"logic":[]}', ?, ?)`,
  ).run(id, id, opts.slug ?? null, opts.deleted ?? 0);
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

describe('① listLinkedFormalooForms — formaloo_slug NOT NULL かつ deleted=0 のみ', () => {
  test('slug ありの生存 form だけ返す (未 push / 削除済は除外)', async () => {
    seedForm('f_linked', { slug: 'SLUG_A' });
    seedForm('f_unpushed', { slug: null });
    seedForm('f_deleted', { slug: 'SLUG_B', deleted: 1 });
    const list = await listLinkedFormalooForms(DB);
    expect(list.map((f) => f.id)).toEqual(['f_linked']);
  });

  test('連携 form ゼロなら空配列', async () => {
    seedForm('f_unpushed', { slug: null });
    expect(await listLinkedFormalooForms(DB)).toEqual([]);
  });
});

describe('② setFormalooSyncState — drift additive (present-key 更新 / undefined 保持 / null クリア)', () => {
  test('drift key 無しの既存呼出は後方互換 (drift_status 既定 none / baseline null)', async () => {
    seedForm('f1', { slug: 'S' });
    await setFormalooSyncState(DB, 'f1', { syncStatus: 'idle', lastPushedAt: '2026-07-12T00:00:00' });
    const s = await getFormalooSyncState(DB, 'f1');
    expect(s?.sync_status).toBe('idle');
    expect(s?.drift_status).toBe('none');
    expect(s?.remote_definition_hash).toBeNull();
    expect(s?.pending_remote_hash).toBeNull();
    expect(s?.last_pushed_at).toBe('2026-07-12T00:00:00');
  });

  test('drift key を渡すと当該列を更新 (baseline/pending/status/detected_at)', async () => {
    seedForm('f1', { slug: 'S' });
    await setFormalooSyncState(DB, 'f1', {
      syncStatus: 'idle',
      remoteDefinitionHash: 'base1',
      pendingRemoteHash: 'pend1',
      driftStatus: 'detected',
      driftDetectedAt: '2026-07-12T01:00:00',
    });
    const s = await getFormalooSyncState(DB, 'f1');
    expect(s?.remote_definition_hash).toBe('base1');
    expect(s?.pending_remote_hash).toBe('pend1');
    expect(s?.drift_status).toBe('detected');
    expect(s?.drift_detected_at).toBe('2026-07-12T01:00:00');
  });

  test('undefined の drift key は既存値を保持し、null は明示クリアする', async () => {
    seedForm('f1', { slug: 'S' });
    await setFormalooSyncState(DB, 'f1', { syncStatus: 'idle', remoteDefinitionHash: 'base1', pendingRemoteHash: 'pend1', driftStatus: 'detected' });
    // sync_status だけ更新 (drift key を渡さない) → baseline/pending は保持
    await setFormalooSyncState(DB, 'f1', { syncStatus: 'out_of_sync' });
    let s = await getFormalooSyncState(DB, 'f1');
    expect(s?.sync_status).toBe('out_of_sync');
    expect(s?.remote_definition_hash).toBe('base1'); // 保持
    expect(s?.pending_remote_hash).toBe('pend1');     // 保持
    // baseline 前進 + pending を明示 null クリア (auto-apply 相当)
    await setFormalooSyncState(DB, 'f1', { syncStatus: 'idle', remoteDefinitionHash: 'base2', pendingRemoteHash: null, driftStatus: 'applied' });
    s = await getFormalooSyncState(DB, 'f1');
    expect(s?.remote_definition_hash).toBe('base2');
    expect(s?.pending_remote_hash).toBeNull(); // 明示クリア
    expect(s?.drift_status).toBe('applied');
  });

  test('last_pushed_at は drift 更新で消えない (COALESCE 不変)', async () => {
    seedForm('f1', { slug: 'S' });
    await setFormalooSyncState(DB, 'f1', { syncStatus: 'idle', lastPushedAt: '2026-07-12T00:00:00' });
    await setFormalooSyncState(DB, 'f1', { syncStatus: 'idle', driftStatus: 'detected', pendingRemoteHash: 'p' });
    const s = await getFormalooSyncState(DB, 'f1');
    expect(s?.last_pushed_at).toBe('2026-07-12T00:00:00'); // 保持
  });
});

describe('③ recordFormalooDriftEvent → listFormalooDriftEvents', () => {
  test('記録行を新しい順に返す', async () => {
    seedForm('f1', { slug: 'S' });
    await recordFormalooDriftEvent(DB, { formId: 'f1', action: 'bootstrapped', detectedAt: '2026-07-12T01:00:00', remoteHash: 'h1' });
    await recordFormalooDriftEvent(DB, { formId: 'f1', action: 'notified', detectedAt: '2026-07-12T02:00:00', remoteHash: 'h2', prevHash: 'h1', hasWarnings: true, warningsJson: JSON.stringify(['w']) });
    await recordFormalooDriftEvent(DB, { formId: 'f_other', action: 'notified', detectedAt: '2026-07-12T03:00:00' });
    const rows = await listFormalooDriftEvents(DB, 'f1');
    expect(rows.map((r) => r.action)).toEqual(['notified', 'bootstrapped']); // 新しい順
    expect(rows[0].remote_hash).toBe('h2');
    expect(rows[0].prev_hash).toBe('h1');
    expect(rows[0].has_warnings).toBe(1);
    expect(rows[0].warnings_json).toBe(JSON.stringify(['w']));
    expect(rows[0].id).toMatch(/^de_/);
    // 他 form の履歴は混入しない
    expect(rows.every((r) => r.form_id === 'f1')).toBe(true);
  });

  test('hasWarnings 未指定は 0', async () => {
    seedForm('f1', { slug: 'S' });
    await recordFormalooDriftEvent(DB, { formId: 'f1', action: 'auto_applied' });
    const rows = await listFormalooDriftEvents(DB, 'f1');
    expect(rows[0].has_warnings).toBe(0);
  });
});
