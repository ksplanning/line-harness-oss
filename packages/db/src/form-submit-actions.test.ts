import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  createFormalooForm,
  getFormalooForm,
  saveFormalooDefinition,
  updateFormalooForm,
} from './formaloo.js';

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
        async run() {
          const info = statement.run(...(params as never[]));
          return { meta: { changes: info.changes } };
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    const statements = readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/)
      .map((part) => part.trim())
      .filter(Boolean);
    for (const sql of statements) {
      try {
        db.exec(sql);
      } catch (error) {
        if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error;
      }
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

describe('migration 138 — ordered form submit actions', () => {
  test('nullable JSON array column preserves the legacy-vs-explicit-empty distinction', () => {
    const columns = raw.prepare('PRAGMA table_info(formaloo_forms)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const column = columns.find((entry) => entry.name === 'on_submit_actions_json');

    expect(column).toBeTruthy();
    expect(column?.notnull).toBe(0);
    expect(column?.dflt_value).toBe('NULL');
  });

  test('migration is additive and only accepts null or a JSON array', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '138_form_submit_actions.sql'), 'utf8');
    expect(sql).toMatch(/ALTER TABLE formaloo_forms\s+ADD COLUMN on_submit_actions_json/i);
    expect(sql).not.toMatch(/\b(DROP|RENAME)\b/i);

    const legacy = new Database(':memory:');
    legacy.exec("CREATE TABLE formaloo_forms (id TEXT PRIMARY KEY, title TEXT NOT NULL)");
    legacy.prepare("INSERT INTO formaloo_forms (id, title) VALUES ('legacy', '旧フォーム')").run();
    legacy.exec(sql);
    expect(legacy.prepare(
      "SELECT on_submit_actions_json FROM formaloo_forms WHERE id = 'legacy'",
    ).get()).toEqual({ on_submit_actions_json: null });
    legacy.prepare(
      "UPDATE formaloo_forms SET on_submit_actions_json = '[]' WHERE id = 'legacy'",
    ).run();
    expect(() => legacy.prepare(
      "UPDATE formaloo_forms SET on_submit_actions_json = '{}' WHERE id = 'legacy'",
    ).run()).toThrow(/CHECK constraint failed/i);
  });
});

describe('formaloo form DAO — submit actions present-key round-trip', () => {
  const actionsJson = JSON.stringify([
    { type: 'add_tag', tagId: 'tag-a' },
    { type: 'set_field', fieldId: 'field-a', value: '済' },
  ]);

  test('Formaloo save writes ordered actions and later omitted saves preserve them', async () => {
    const form = await createFormalooForm(DB, { title: '申込フォーム' });
    expect(form.on_submit_actions_json).toBeNull();

    await saveFormalooDefinition(DB, form.id, {
      definitionJson: '{"fields":[],"logic":[]}',
      fields: [],
      onSubmitActionsJson: actionsJson,
    });
    expect((await getFormalooForm(DB, form.id))?.on_submit_actions_json).toBe(actionsJson);

    await saveFormalooDefinition(DB, form.id, {
      definitionJson: '{"fields":[],"logic":[]}',
      fields: [],
      title: '改題',
    });
    expect((await getFormalooForm(DB, form.id))?.on_submit_actions_json).toBe(actionsJson);

    await saveFormalooDefinition(DB, form.id, {
      definitionJson: '{"fields":[],"logic":[]}',
      fields: [],
      onSubmitActionsJson: '[]',
    });
    expect((await getFormalooForm(DB, form.id))?.on_submit_actions_json).toBe('[]');
  });

  test('internal save uses the same present-key contract', async () => {
    const form = await createFormalooForm(DB, { title: '自前フォーム' });
    raw.prepare(
      "UPDATE formaloo_forms SET render_backend = 'internal' WHERE id = ?",
    ).run(form.id);

    expect(await updateFormalooForm(DB, form.id, {
      definitionJson: '{"fields":[],"logic":[]}',
      title: form.title,
      description: null,
      updatedAt: '2026-07-23T12:00:00+09:00',
      onSubmitActionsJson: actionsJson,
    })).toBe(true);
    expect((await getFormalooForm(DB, form.id))?.on_submit_actions_json).toBe(actionsJson);

    expect(await updateFormalooForm(DB, form.id, {
      definitionJson: '{"fields":[],"logic":[]}',
      title: form.title,
      description: null,
      updatedAt: '2026-07-23T12:01:00+09:00',
    })).toBe(true);
    expect((await getFormalooForm(DB, form.id))?.on_submit_actions_json).toBe(actionsJson);
  });
});
