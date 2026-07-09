/**
 * F-4 データ層 helper 検証 (real SQLite / schema replay)。
 *   - 保存フィルタ CRUD (form scope 越え削除不可)
 *   - queryFormalooSubmissions: q(LIKE) / 期間(julianday M-4) / sort / paging (total + slice)
 *   - formalooSubmissionsDailyCounts: 日次集計
 *   - bulkDeleteFormalooSubmissions: form scope に閉じた一括削除 + 件数 (T-D2 / N-9)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import {
  listFormalooSavedFilters,
  createFormalooSavedFilter,
  deleteFormalooSavedFilter,
  queryFormalooSubmissions,
  formalooSubmissionsDailyCounts,
  bulkDeleteFormalooSubmissions,
} from './formaloo.js';

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
function seedSub(id: string, formId: string, answers: Record<string, unknown>, submittedAt: string, friendId: string | null = null) {
  raw.prepare(
    `INSERT INTO formaloo_submissions (id, form_id, friend_id, answers_json, submitted_at) VALUES (?,?,?,?,?)`,
  ).run(id, formId, friendId, JSON.stringify(answers), submittedAt);
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

describe('保存フィルタ CRUD (T-D1)', () => {
  test('create → list / form scope 越え削除不可', async () => {
    const a = await createFormalooSavedFilter(DB, { formId: 'fa1', name: '未対応', filterJson: JSON.stringify({ q: 'x' }) });
    await createFormalooSavedFilter(DB, { formId: 'fa2', name: '別form', filterJson: '{}' });
    expect((await listFormalooSavedFilters(DB, 'fa1')).map((f) => f.name)).toEqual(['未対応']);
    // 別 form 経由の削除は効かない (scope 保護)
    await deleteFormalooSavedFilter(DB, 'fa2', a.id);
    expect((await listFormalooSavedFilters(DB, 'fa1')).length).toBe(1);
    // 正しい form scope なら消える
    await deleteFormalooSavedFilter(DB, 'fa1', a.id);
    expect((await listFormalooSavedFilters(DB, 'fa1')).length).toBe(0);
  });
});

describe('queryFormalooSubmissions (T-D1)', () => {
  beforeEach(() => {
    seedSub('s1', 'fa1', { name: '田中' }, '2026-07-01T10:00:00+09:00', 'fr_1');
    seedSub('s2', 'fa1', { name: '鈴木' }, '2026-07-05T10:00:00+09:00', 'fr_2');
    seedSub('s3', 'fa1', { name: '田中太郎' }, '2026-07-09T10:00:00+09:00', 'fr_3');
    seedSub('sx', 'fa2', { name: '他フォーム' }, '2026-07-09T10:00:00+09:00');
  });

  test('form scope + 既定 desc + total', async () => {
    const { rows, total } = await queryFormalooSubmissions(DB, { formId: 'fa1', limit: 10, offset: 0 });
    expect(total).toBe(3);
    expect(rows.map((r) => r.id)).toEqual(['s3', 's2', 's1']); // submitted_at desc
  });

  test('q(LIKE) は answers_json を絞り込む', async () => {
    const { rows, total } = await queryFormalooSubmissions(DB, { formId: 'fa1', q: '田中', limit: 10, offset: 0 });
    expect(total).toBe(2);
    expect(rows.map((r) => r.id).sort()).toEqual(['s1', 's3']);
  });

  test('期間 from/to (julianday M-4)', async () => {
    const { rows } = await queryFormalooSubmissions(DB, { formId: 'fa1', from: '2026-07-03T00:00:00+09:00', to: '2026-07-06T00:00:00+09:00', limit: 10, offset: 0 });
    expect(rows.map((r) => r.id)).toEqual(['s2']);
  });

  test('sort asc + paging (limit/offset)', async () => {
    const p1 = await queryFormalooSubmissions(DB, { formId: 'fa1', sortDir: 'asc', limit: 2, offset: 0 });
    expect(p1.rows.map((r) => r.id)).toEqual(['s1', 's2']);
    expect(p1.total).toBe(3);
    const p2 = await queryFormalooSubmissions(DB, { formId: 'fa1', sortDir: 'asc', limit: 2, offset: 2 });
    expect(p2.rows.map((r) => r.id)).toEqual(['s3']);
  });
});

describe('統計 & 一括削除 (T-D2)', () => {
  test('日次集計', async () => {
    seedSub('s1', 'fa1', {}, '2026-07-01T10:00:00+09:00');
    seedSub('s2', 'fa1', {}, '2026-07-01T12:00:00+09:00');
    seedSub('s3', 'fa1', {}, '2026-07-02T09:00:00+09:00');
    const daily = await formalooSubmissionsDailyCounts(DB, 'fa1');
    expect(daily).toEqual([{ day: '2026-07-01', count: 2 }, { day: '2026-07-02', count: 1 }]);
  });

  test('bulkDelete は form scope に閉じ、件数を返す (N-9)', async () => {
    seedSub('s1', 'fa1', {}, '2026-07-01T10:00:00+09:00');
    seedSub('s2', 'fa1', {}, '2026-07-02T10:00:00+09:00');
    seedSub('sx', 'fa2', {}, '2026-07-02T10:00:00+09:00');
    // fa1 経由で s1 と（他フォームの）sx を消そうとしても sx は消えない (scope 保護)
    const n = await bulkDeleteFormalooSubmissions(DB, 'fa1', ['s1', 'sx']);
    expect(n).toBe(1);
    expect((await queryFormalooSubmissions(DB, { formId: 'fa1', limit: 10, offset: 0 })).total).toBe(1);
    expect((await queryFormalooSubmissions(DB, { formId: 'fa2', limit: 10, offset: 0 })).total).toBe(1);
  });

  test('空 id 配列は 0 件 (no-op)', async () => {
    expect(await bulkDeleteFormalooSubmissions(DB, 'fa1', [])).toBe(0);
  });
});
