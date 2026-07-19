import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import { createFormalooForm, getFormalooForm, saveFormalooDefinition } from './formaloo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');
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
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    for (const sql of readFileSync(join(MIGRATIONS_DIR, file), 'utf8').split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean)) {
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

describe('migration 103 — friend metadata mappings', () => {
  test('独立 JSON 列は NOT NULL DEFAULT [] で既存 form を no-op にする', () => {
    const columns = raw.prepare('PRAGMA table_info(formaloo_forms)').all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
    const column = columns.find((entry) => entry.name === 'friend_metadata_mappings_json');
    expect(column).toBeTruthy();
    expect(column?.notnull).toBe(1);
    expect(column?.dflt_value).toBe("'[]'");
  });

  test('migration は additive のみ', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '103_formaloo_friend_metadata_mapping.sql'), 'utf8');
    expect(sql).toMatch(/ADD COLUMN friend_metadata_mappings_json TEXT NOT NULL DEFAULT '\[\]'/i);
    expect(sql).not.toMatch(/\b(DROP|RENAME)\b/i);
  });
});

describe('saveFormalooDefinition — friend metadata mappings present-key', () => {
  test('canonical JSON を round-trip し、未指定の後続 save では保持する', async () => {
    const form = await createFormalooForm(DB, { title: '入金フォーム' });
    const mappings = JSON.stringify([{ formalooFieldKey: 'BjEp0J2J', friendMetadataKey: '入金確認' }]);
    await saveFormalooDefinition(DB, form.id, {
      definitionJson: '{"fields":[],"logic":[]}',
      fields: [],
      friendMetadataMappingsJson: mappings,
    });
    expect((await getFormalooForm(DB, form.id))?.friend_metadata_mappings_json).toBe(mappings);

    await saveFormalooDefinition(DB, form.id, {
      definitionJson: '{"fields":[],"logic":[]}',
      fields: [],
      title: '改題',
    });
    expect((await getFormalooForm(DB, form.id))?.friend_metadata_mappings_json).toBe(mappings);
  });
});
