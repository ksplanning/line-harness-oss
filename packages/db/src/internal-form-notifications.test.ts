import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  bumpInternalFormEditLinkEpoch,
  getInternalFormNotificationSettings,
  upsertInternalFormNotificationSettings,
} from './internal-form-notifications.js';

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
     VALUES ('fa_notify', '通知フォーム', '{"fields":[],"logic":[]}')`,
  ).run();
});

describe('internal form notification settings persistence', () => {
  test('returns null until a form has notification settings', async () => {
    expect(await getInternalFormNotificationSettings(DB, 'fa_notify')).toBeNull();
  });

  test('upserts editable settings and maps the persisted row', async () => {
    const created = await upsertInternalFormNotificationSettings(DB, {
      formId: 'fa_notify',
      enabled: true,
      recipientEmailFieldId: 'field_email',
      messageTemplate: '{{display_name}}\n{{回答:氏名}}\n{{編集リンク}}',
    });

    expect(created).toMatchObject({
      formId: 'fa_notify',
      enabled: true,
      recipientEmailFieldId: 'field_email',
      messageTemplate: '{{display_name}}\n{{回答:氏名}}\n{{編集リンク}}',
      editLinkEpoch: 0,
    });
    expect(created.createdAt).toBeTruthy();
    expect(created.updatedAt).toBeTruthy();
    expect(await getInternalFormNotificationSettings(DB, 'fa_notify')).toEqual(created);

    const updated = await upsertInternalFormNotificationSettings(DB, {
      formId: 'fa_notify',
      enabled: false,
      recipientEmailFieldId: null,
      messageTemplate: null,
    });
    expect(updated).toMatchObject({
      formId: 'fa_notify',
      enabled: false,
      recipientEmailFieldId: null,
      messageTemplate: null,
      editLinkEpoch: 0,
    });
  });

  test('bumps the edit-link epoch atomically and preserves it across settings saves', async () => {
    expect(await bumpInternalFormEditLinkEpoch(DB, 'fa_notify')).toBe(1);
    expect(await bumpInternalFormEditLinkEpoch(DB, 'fa_notify')).toBe(2);

    const saved = await upsertInternalFormNotificationSettings(DB, {
      formId: 'fa_notify',
      enabled: true,
      recipientEmailFieldId: null,
      messageTemplate: '確認',
    });
    expect(saved.editLinkEpoch).toBe(2);
  });
});
