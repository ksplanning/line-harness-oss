/**
 * forms-list-count-fix T-A1 — countFormalooSubmissionsForForm (form 単位ミラー件数 COUNT)。
 *   一覧の回答数表示源を submit_count(harness-only カウンタ) から formaloo_submissions ミラー行数へ切替える
 *   ための軽量 COUNT helper。real SQLite / schema replay で検証。
 *   - 複数行 → N
 *   - 0 行 → 0
 *   - 別 form の行は数えない (form scope に閉じる)
 *   - Formaloo API 呼出なし・local D1 1 クエリ (rows 非 fetch)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import { countFormalooSubmissionsForForm } from './formaloo.js';

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
function seedSub(id: string, formId: string, submittedAt = '2026-07-17T10:00:00+09:00') {
  raw.prepare(
    `INSERT INTO formaloo_submissions (id, form_id, answers_json, submitted_at) VALUES (?,?,?,?)`,
  ).run(id, formId, '{}', submittedAt);
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
});

describe('countFormalooSubmissionsForForm (T-A1)', () => {
  test('複数行 → その form のミラー件数 N を返す', async () => {
    seedSub('s1', 'fa_A');
    seedSub('s2', 'fa_A');
    seedSub('s3', 'fa_A');
    seedSub('s4', 'fa_A');
    expect(await countFormalooSubmissionsForForm(DB, 'fa_A')).toBe(4);
  });

  test('0 行 → 0 を返す (行が無いフォーム)', async () => {
    expect(await countFormalooSubmissionsForForm(DB, 'fa_empty')).toBe(0);
  });

  test('別 form の行は数えない (form scope に閉じる)', async () => {
    seedSub('a1', 'fa_A');
    seedSub('a2', 'fa_A');
    seedSub('b1', 'fa_B');
    expect(await countFormalooSubmissionsForForm(DB, 'fa_A')).toBe(2);
    expect(await countFormalooSubmissionsForForm(DB, 'fa_B')).toBe(1);
  });
});
