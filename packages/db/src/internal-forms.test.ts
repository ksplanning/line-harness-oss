import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  createInternalFormSubmission,
  getInternalFormSubmission,
  listInternalFormSubmissions,
  setFormRenderBackend,
} from './internal-forms.js';
import { getFormalooForm } from './formaloo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database): void {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(join(PKG_ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    for (const statement of readFileSync(join(PKG_ROOT, 'migrations', file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean)) {
      try { db.exec(statement); } catch (error) {
        if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
  }
}

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

let raw: Database.Database;
let DB: D1Database;

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  DB = d1(raw);
  raw.prepare(
    `INSERT INTO formaloo_forms (id, title, definition_json)
     VALUES ('fa_internal', '申込フォーム', '{"fields":[],"logic":[]}')`,
  ).run();
});

describe('internal form persistence', () => {
  test('switches a single form without changing the formaloo default', async () => {
    expect((await getFormalooForm(DB, 'fa_internal'))?.render_backend).toBe('formaloo');

    expect(await setFormRenderBackend(DB, 'fa_internal', 'internal')).toBe(true);

    expect((await getFormalooForm(DB, 'fa_internal'))?.render_backend).toBe('internal');
  });

  test('stores answers separately and scopes list/detail reads to the form', async () => {
    const created = await createInternalFormSubmission(DB, {
      formId: 'fa_internal',
      friendId: 'friend-1',
      answers: { name: '佐藤', interests: ['A', 'B'] },
    });

    expect(created.id).toMatch(/^ifs_/);
    expect(created.answers_json).toBe('{"name":"佐藤","interests":["A","B"]}');
    expect(await listInternalFormSubmissions(DB, 'fa_internal', { limit: 20, offset: 0 }))
      .toMatchObject({ total: 1, rows: [expect.objectContaining({ id: created.id })] });
    expect(await getInternalFormSubmission(DB, 'fa_internal', created.id))
      .toMatchObject({ id: created.id, friend_id: 'friend-1' });
    expect(await getInternalFormSubmission(DB, 'fa_other', created.id)).toBeNull();
  });
});
