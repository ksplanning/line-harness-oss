import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  acquireFormalooWebhookOperationLock,
  claimFormalooWebhookPull,
  clearFormalooWebhookRegistration,
  completeFormalooWebhookPull,
  createFormalooForm,
  disableFormalooWebhookRegistration,
  getFormalooForm,
  markFormalooWebhookPullPending,
  prepareFormalooWebhookRegistration,
  releaseFormalooWebhookOperationLock,
  renewFormalooWebhookOperationLock,
  renewFormalooWebhookPullLock,
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
    for (const name of [
      'formaloo_webhook_id',
      'formaloo_webhook_secret',
      'formaloo_webhook_url',
      'formaloo_webhook_lock_token',
      'formaloo_webhook_lock_until',
      'formaloo_webhook_pull_lock_token',
      'formaloo_webhook_pull_lock_until',
    ]) {
      expect(columns.find((column) => column.name === name)).toMatchObject({ notnull: 0 });
    }
    for (const name of [
      'formaloo_webhook_pull_generation',
      'formaloo_webhook_pull_processed_generation',
      'formaloo_webhook_pull_not_before',
    ]) {
      expect(columns.find((column) => column.name === name)).toMatchObject({
        notnull: 1,
        dflt_value: '0',
      });
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
  test('form lock は同時操作を1件に絞り、owner release または期限切れ後だけ再取得できる', async () => {
    const form = await createFormalooForm(DB, { title: '同時登録防止フォーム' });
    await expect(acquireFormalooWebhookOperationLock(DB, form.id, {
      token: 'operation-a', nowMs: 1_000, leaseMs: 30_000,
    })).resolves.toBe(true);
    await expect(acquireFormalooWebhookOperationLock(DB, form.id, {
      token: 'operation-b', nowMs: 1_001, leaseMs: 30_000,
    })).resolves.toBe(false);

    await releaseFormalooWebhookOperationLock(DB, form.id, 'wrong-owner');
    await expect(acquireFormalooWebhookOperationLock(DB, form.id, {
      token: 'operation-b', nowMs: 1_002, leaseMs: 30_000,
    })).resolves.toBe(false);

    await expect(renewFormalooWebhookOperationLock(DB, form.id, {
      token: 'wrong-owner', nowMs: 1_002, leaseMs: 30_000,
    })).resolves.toBe(false);
    await expect(renewFormalooWebhookOperationLock(DB, form.id, {
      token: 'operation-a', nowMs: 1_002, leaseMs: 30_000,
    })).resolves.toBe(true);

    await releaseFormalooWebhookOperationLock(DB, form.id, 'operation-a');
    await expect(acquireFormalooWebhookOperationLock(DB, form.id, {
      token: 'operation-b', nowMs: 1_003, leaseMs: 30_000,
    })).resolves.toBe(true);
    await expect(acquireFormalooWebhookOperationLock(DB, form.id, {
      token: 'operation-c', nowMs: 31_004, leaseMs: 30_000,
    })).resolves.toBe(true);
  });

  test('remote 作成前に callback secret/URL を OFF 状態で保存し、retry URL を固定する', async () => {
    const form = await createFormalooForm(DB, { title: '登録準備フォーム' });
    await acquireFormalooWebhookOperationLock(DB, form.id, {
      token: 'prepare-owner', nowMs: 1_000, leaseMs: 30_000,
    });
    await prepareFormalooWebhookRegistration(DB, form.id, {
      secret: 'pending-secret',
      url: 'https://worker.example/formaloo/instant/fa_pending/pending-secret',
    }, 'prepare-owner');
    expect(await getFormalooForm(DB, form.id)).toMatchObject({
      formaloo_webhook_enabled: 0,
      formaloo_webhook_id: null,
      formaloo_webhook_secret: 'pending-secret',
      formaloo_webhook_url: 'https://worker.example/formaloo/instant/fa_pending/pending-secret',
    });

    await prepareFormalooWebhookRegistration(DB, form.id, {
      secret: 'racing-secret-must-not-win',
      url: 'https://worker.example/formaloo/instant/fa_pending/racing-secret-must-not-win',
    }, 'prepare-owner');
    expect(await getFormalooForm(DB, form.id)).toMatchObject({
      formaloo_webhook_secret: 'pending-secret',
      formaloo_webhook_url: 'https://worker.example/formaloo/instant/fa_pending/pending-secret',
    });
  });

  test('read-back 済み登録情報を保存し、解除時は全情報を消す', async () => {
    const form = await createFormalooForm(DB, { title: '即時通知フォーム' });
    await acquireFormalooWebhookOperationLock(DB, form.id, {
      token: 'set-owner', nowMs: 1_000, leaseMs: 30_000,
    });

    await expect(setFormalooWebhookRegistration(DB, form.id, {
      webhookId: 'wh_remote_1',
      secret: 'generated-per-form-secret',
      url: 'https://worker.example/formaloo/instant/fa_1/generated-per-form-secret',
    }, 'set-owner')).resolves.toBe(true);
    expect(await getFormalooForm(DB, form.id)).toMatchObject({
      formaloo_webhook_enabled: 1,
      formaloo_webhook_id: 'wh_remote_1',
      formaloo_webhook_secret: 'generated-per-form-secret',
      formaloo_webhook_url: 'https://worker.example/formaloo/instant/fa_1/generated-per-form-secret',
    });

    await expect(clearFormalooWebhookRegistration(DB, form.id, 'set-owner')).resolves.toBe(true);
    expect(await getFormalooForm(DB, form.id)).toMatchObject({
      formaloo_webhook_enabled: 0,
      formaloo_webhook_id: null,
      formaloo_webhook_secret: null,
      formaloo_webhook_url: null,
    });
  });

  test('remote DELETE 失敗時は受信だけ OFF にし、再 cleanup 用 id/secret/URL は保持する', async () => {
    const form = await createFormalooForm(DB, { title: '解除再試行フォーム' });
    await acquireFormalooWebhookOperationLock(DB, form.id, {
      token: 'disable-owner', nowMs: 1_000, leaseMs: 30_000,
    });
    await setFormalooWebhookRegistration(DB, form.id, {
      webhookId: 'wh_retry',
      secret: 'retry-secret',
      url: 'https://worker.example/formaloo/instant/fa_retry/retry-secret',
    }, 'disable-owner');
    await expect(disableFormalooWebhookRegistration(DB, form.id, 'disable-owner')).resolves.toBe(true);
    expect(await getFormalooForm(DB, form.id)).toMatchObject({
      formaloo_webhook_enabled: 0,
      formaloo_webhook_id: 'wh_retry',
      formaloo_webhook_secret: 'retry-secret',
      formaloo_webhook_url: 'https://worker.example/formaloo/instant/fa_retry/retry-secret',
    });
  });

  test('期限切れ owner の最終 write は fencing token で拒否し、新しい OFF 決定を上書きしない', async () => {
    const form = await createFormalooForm(DB, { title: 'fencing フォーム' });
    await acquireFormalooWebhookOperationLock(DB, form.id, {
      token: 'stale-enable', nowMs: 1_000, leaseMs: 100,
    });
    await prepareFormalooWebhookRegistration(DB, form.id, {
      secret: 'stable-secret',
      url: 'https://worker.example/formaloo/instant/fencing/stable-secret',
    }, 'stale-enable');
    await acquireFormalooWebhookOperationLock(DB, form.id, {
      token: 'new-disable', nowMs: 1_101, leaseMs: 100,
    });
    await disableFormalooWebhookRegistration(DB, form.id, 'new-disable');

    await expect(setFormalooWebhookRegistration(DB, form.id, {
      webhookId: 'wh_stale',
      secret: 'stable-secret',
      url: 'https://worker.example/formaloo/instant/fencing/stable-secret',
    }, 'stale-enable')).resolves.toBe(false);
    expect(await getFormalooForm(DB, form.id)).toMatchObject({ formaloo_webhook_enabled: 0 });
  });

  test('pull 世代は callback を永続 dirty 化し、複数 worker の claim を form 単位で1件にする', async () => {
    const form = await createFormalooForm(DB, { title: 'pull scheduler フォーム' });
    await acquireFormalooWebhookOperationLock(DB, form.id, {
      token: 'enable-owner', nowMs: 1_000, leaseMs: 30_000,
    });
    await setFormalooWebhookRegistration(DB, form.id, {
      webhookId: 'wh_pull', secret: 'pull-secret',
      url: 'https://worker.example/formaloo/instant/pull/pull-secret',
    }, 'enable-owner');

    await expect(markFormalooWebhookPullPending(DB, form.id)).resolves.toBe(true);
    await expect(claimFormalooWebhookPull(DB, form.id, {
      token: 'pull-a', nowMs: 10_000, leaseMs: 20_000, cooldownMs: 15_000,
    })).resolves.toEqual({ claimed: true, generation: 1 });
    await expect(markFormalooWebhookPullPending(DB, form.id)).resolves.toBe(true);
    await expect(claimFormalooWebhookPull(DB, form.id, {
      token: 'pull-b', nowMs: 10_001, leaseMs: 20_000, cooldownMs: 15_000,
    })).resolves.toMatchObject({ claimed: false, pending: true });

    await completeFormalooWebhookPull(DB, form.id, {
      token: 'pull-a', generation: 1, success: true,
    });
    await expect(claimFormalooWebhookPull(DB, form.id, {
      token: 'pull-b', nowMs: 24_999, leaseMs: 20_000, cooldownMs: 15_000,
    })).resolves.toEqual({ claimed: false, pending: true, retryAt: 25_000 });
    await expect(claimFormalooWebhookPull(DB, form.id, {
      token: 'pull-b', nowMs: 25_000, leaseMs: 20_000, cooldownMs: 15_000,
    })).resolves.toEqual({ claimed: true, generation: 2 });
    await completeFormalooWebhookPull(DB, form.id, {
      token: 'pull-b', generation: 2, success: true,
    });
    await expect(claimFormalooWebhookPull(DB, form.id, {
      token: 'pull-c', nowMs: 40_000, leaseMs: 20_000, cooldownMs: 15_000,
    })).resolves.toEqual({ claimed: false, pending: false, retryAt: 40_000 });
  });

  test('pull owner だけが lease を延長でき、失効 token は復活できない', async () => {
    const form = await createFormalooForm(DB, { title: 'pull lease 更新フォーム' });
    await acquireFormalooWebhookOperationLock(DB, form.id, {
      token: 'enable-owner', nowMs: 1_000, leaseMs: 30_000,
    });
    await setFormalooWebhookRegistration(DB, form.id, {
      webhookId: 'wh_pull', secret: 'pull-secret',
      url: 'https://worker.example/formaloo/instant/pull/pull-secret',
    }, 'enable-owner');
    await markFormalooWebhookPullPending(DB, form.id);
    await claimFormalooWebhookPull(DB, form.id, {
      token: 'pull-owner', nowMs: 10_000, leaseMs: 12_000, cooldownMs: 15_000,
    });

    await expect(renewFormalooWebhookPullLock(DB, form.id, {
      token: 'wrong-owner', nowMs: 10_001, leaseMs: 12_000,
    })).resolves.toBe(false);
    await expect(renewFormalooWebhookPullLock(DB, form.id, {
      token: 'pull-owner', nowMs: 10_001, leaseMs: 12_000,
    })).resolves.toBe(true);
    await expect(renewFormalooWebhookPullLock(DB, form.id, {
      token: 'pull-owner', nowMs: 22_002, leaseMs: 12_000,
    })).resolves.toBe(false);
  });
});
