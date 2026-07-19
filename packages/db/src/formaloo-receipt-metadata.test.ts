import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import { getFormalooSubmission, upsertFormalooSubmission } from './formaloo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const BENIGN = /duplicate column name|already exists/i;

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
        async run() { const info = statement.run(...(params as never[])); return { meta: { changes: info.changes } }; },
      };
      return api;
    },
  } as unknown as D1Database;
}

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(join(PKG_ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    const statements = readFileSync(join(PKG_ROOT, 'migrations', file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/).map((sql) => sql.trim()).filter(Boolean);
    for (const sql of statements) {
      try { db.exec(sql); } catch (error) { if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error; }
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

describe('formaloo receipt metadata mirror (D-7)', () => {
  test('migration は tracking_code / submit_number / pdf_link を nullable additive 追加する', () => {
    const columns = raw.prepare("PRAGMA table_info('formaloo_submissions')").all() as Array<{ name: string; notnull: number }>;
    for (const name of ['tracking_code', 'submit_number', 'pdf_link']) {
      expect(columns.find((column) => column.name === name)).toMatchObject({ name, notnull: 0 });
    }
  });

  test('webhook metadata を保存し、metadata欠落の再送で既存値を消さない', async () => {
    const base = {
      id: 'sub-1', formId: 'form-1', formalooSlug: 'slug-1', answersJson: '{"name":"山田"}',
      submittedAt: '2026-07-19T00:00:00Z', verified: true,
    };
    await upsertFormalooSubmission(DB, {
      ...base,
      trackingCode: 'TRACK-1',
      submitNumber: '00042',
      pdfLink: 'https://files.example.test/receipt.pdf',
    });
    await upsertFormalooSubmission(DB, base);

    const row = await getFormalooSubmission(DB, 'sub-1');
    expect(row).toMatchObject({
      tracking_code: 'TRACK-1',
      submit_number: '00042',
      pdf_link: 'https://files.example.test/receipt.pdf',
    });
  });
});
