import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  clearFormalooWebhookRegistration,
  createFormalooForm,
  disableFormalooWebhookRegistration,
  getFormalooForm,
  prepareFormalooWebhookRegistration,
  setFormalooWebhookRegistration,
} from './formaloo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');
const BENIGN_REPLAY_ERROR = /duplicate column name|already exists/i;

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
        if (!BENIGN_REPLAY_ERROR.test(error instanceof Error ? error.message : String(error))) throw error;
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
        async run() {
          const info = statement.run(...(params as never[]));
          return { meta: { changes: info.changes } };
        },
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
});

describe('migration 106 — Formaloo outbound webhook registration', () => {
  test('既存 form は既定 OFF で webhook 情報を持たない', async () => {
    const columns = raw.prepare('PRAGMA table_info(formaloo_forms)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    expect(columns.find((column) => column.name === 'formaloo_webhook_enabled')).toMatchObject({
      notnull: 1,
      dflt_value: '0',
    });
    for (const name of ['formaloo_webhook_id', 'formaloo_webhook_secret', 'formaloo_webhook_url']) {
      expect(columns.find((column) => column.name === name)).toMatchObject({ notnull: 0 });
    }

    const form = await createFormalooForm(DB, { title: '既存フォーム' });
    expect(form.formaloo_webhook_enabled).toBe(0);
    expect(form.formaloo_webhook_id).toBeNull();
    expect(form.formaloo_webhook_secret).toBeNull();
    expect(form.formaloo_webhook_url).toBeNull();
  });

  test('migration 106 は additive のみ', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '106_formaloo_webhook_registration.sql'), 'utf8');
    expect(sql).toMatch(/ADD COLUMN formaloo_webhook_enabled INTEGER NOT NULL DEFAULT 0/i);
    expect(sql).not.toMatch(/\b(DROP|RENAME)\b/i);
  });
});

describe('Formaloo webhook registration DAO', () => {
  test('remote 作成前に callback secret/URL を OFF 状態で保存し、retry URL を固定する', async () => {
    const form = await createFormalooForm(DB, { title: '登録準備フォーム' });
    await prepareFormalooWebhookRegistration(DB, form.id, {
      secret: 'pending-secret',
      url: 'https://worker.example/formaloo/instant/fa_pending/pending-secret',
    });
    expect(await getFormalooForm(DB, form.id)).toMatchObject({
      formaloo_webhook_enabled: 0,
      formaloo_webhook_id: null,
      formaloo_webhook_secret: 'pending-secret',
      formaloo_webhook_url: 'https://worker.example/formaloo/instant/fa_pending/pending-secret',
    });
  });

  test('read-back 済み登録情報を保存し、解除時は全情報を消す', async () => {
    const form = await createFormalooForm(DB, { title: '即時通知フォーム' });

    await setFormalooWebhookRegistration(DB, form.id, {
      webhookId: 'wh_remote_1',
      secret: 'generated-per-form-secret',
      url: 'https://worker.example/formaloo/instant/fa_1/generated-per-form-secret',
    });
    expect(await getFormalooForm(DB, form.id)).toMatchObject({
      formaloo_webhook_enabled: 1,
      formaloo_webhook_id: 'wh_remote_1',
      formaloo_webhook_secret: 'generated-per-form-secret',
      formaloo_webhook_url: 'https://worker.example/formaloo/instant/fa_1/generated-per-form-secret',
    });

    await clearFormalooWebhookRegistration(DB, form.id);
    expect(await getFormalooForm(DB, form.id)).toMatchObject({
      formaloo_webhook_enabled: 0,
      formaloo_webhook_id: null,
      formaloo_webhook_secret: null,
      formaloo_webhook_url: null,
    });
  });

  test('remote DELETE 失敗時は受信だけ OFF にし、再 cleanup 用 id/secret/URL は保持する', async () => {
    const form = await createFormalooForm(DB, { title: '解除再試行フォーム' });
    await setFormalooWebhookRegistration(DB, form.id, {
      webhookId: 'wh_retry',
      secret: 'retry-secret',
      url: 'https://worker.example/formaloo/instant/fa_retry/retry-secret',
    });
    await disableFormalooWebhookRegistration(DB, form.id);
    expect(await getFormalooForm(DB, form.id)).toMatchObject({
      formaloo_webhook_enabled: 0,
      formaloo_webhook_id: 'wh_retry',
      formaloo_webhook_secret: 'retry-secret',
      formaloo_webhook_url: 'https://worker.example/formaloo/instant/fa_retry/retry-secret',
    });
  });
});
