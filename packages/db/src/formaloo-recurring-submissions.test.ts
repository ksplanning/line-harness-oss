import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import { createFormalooForm } from './formaloo.js';
import { acquireFormalooFormOperationLock } from './formaloo.js';
import {
  claimFormalooRecurringSubmission,
  completeFormalooRecurringSubmission,
  getFormalooRecurringSubmissionByFingerprint,
  getFormalooRecurringSubmissionByIdempotencyKey,
  getFormalooRecurringSubmissionBySlug,
  hasBlockingFormalooRecurringSubmissions,
  listFormalooRecurringSubmissions,
  markFormalooRecurringSubmissionFailed,
  releaseFormalooRecurringSubmissionClaim,
  FormalooRecurringReservationUnavailableError,
  reserveFormalooRecurringSubmission,
} from './formaloo-recurring-submissions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const MIGRATIONS_DIR = join(PKG_ROOT, 'migrations');
const BENIGN_REPLAY_ERROR = /duplicate column name|already exists/i;

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort()) {
    for (const sql of readFileSync(join(MIGRATIONS_DIR, file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean)) {
      try { db.exec(sql); } catch (error) {
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
let db: D1Database;

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  db = d1(raw);
});

const schedule = {
  interval: { 'provider-defined-key': 'provider-defined-value' },
  start_time: '2026-07-20T00:00:00Z',
  end_time: null,
};
const requestFingerprint = 'fp_form_schedule_submission';

describe('migration 109 — Formaloo recurring submission mirror', () => {
  test('is additive and creates a form-scoped ledger with status/schedule/slug columns', () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '109_formaloo_recurring_submissions.sql'), 'utf8');
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS formaloo_recurring_submissions/i);
    expect(sql).not.toMatch(/\b(DROP|RENAME)\b/i);
    const columns = raw.prepare('PRAGMA table_info(formaloo_recurring_submissions)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'form_id', 'idempotency_key', 'remote_slug', 'schedule_json', 'submission_data_json',
      'request_fingerprint', 'status', 'sync_state', 'operation_token', 'operation_lock_until',
    ]));
  });
});

describe('Formaloo recurring submission DAO', () => {
  test('the shared form operation lock cannot be acquired after soft deletion', async () => {
    const form = await createFormalooForm(db, { title: '削除済みフォーム' });
    raw.prepare('UPDATE formaloo_forms SET deleted = 1 WHERE id = ?').run(form.id);
    await expect(acquireFormalooFormOperationLock(db, form.id, {
      token: 'late-create', nowMs: 100, leaseMs: 1_000,
    })).resolves.toBe(false);
  });

  test('same form + idempotency key reserves one stable row and round-trips JSON', async () => {
    const form = await createFormalooForm(db, { title: '定期報告フォーム' });
    const input = {
      formId: form.id,
      idempotencyKey: 'create-attempt-1',
      requestFingerprint,
      schedule,
      submissionData: { inventory: 12 },
      status: 'resumed' as const,
    };
    const first = await reserveFormalooRecurringSubmission(db, input);
    const second = await reserveFormalooRecurringSubmission(db, input);
    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({
      formId: form.id,
      idempotencyKey: 'create-attempt-1',
      requestFingerprint,
      remoteSlug: null,
      schedule,
      submissionData: { inventory: 12 },
      status: 'resumed',
      syncState: 'pending',
    });
    const count = raw.prepare('SELECT COUNT(*) AS n FROM formaloo_recurring_submissions').get() as { n: number };
    expect(count.n).toBe(1);
  });

  test('does not reserve a new Formaloo schedule after the form switched to internal', async () => {
    const form = await createFormalooForm(db, { title: '切替競合フォーム' });
    raw.prepare("UPDATE formaloo_forms SET render_backend = 'internal' WHERE id = ?").run(form.id);

    await expect(reserveFormalooRecurringSubmission(db, {
      formId: form.id,
      idempotencyKey: 'late-after-switch',
      requestFingerprint,
      schedule,
      submissionData: { inventory: 12 },
      status: 'resumed',
    })).rejects.toBeInstanceOf(FormalooRecurringReservationUnavailableError);

    const count = raw.prepare('SELECT COUNT(*) AS n FROM formaloo_recurring_submissions').get() as { n: number };
    expect(count.n).toBe(0);
  });

  test('different idempotency keys share one active request fingerprint, while cancelled permits a new row', async () => {
    const form = await createFormalooForm(db, { title: '重複防止フォーム' });
    const first = await reserveFormalooRecurringSubmission(db, {
      formId: form.id,
      idempotencyKey: 'tab-a',
      requestFingerprint,
      schedule,
      submissionData: { inventory: 12 },
      status: 'resumed',
    });
    const second = await reserveFormalooRecurringSubmission(db, {
      formId: form.id,
      idempotencyKey: 'tab-b',
      requestFingerprint,
      schedule,
      submissionData: { inventory: 12 },
      status: 'resumed',
    });
    expect(second.id).toBe(first.id);
    expect(await getFormalooRecurringSubmissionByFingerprint(db, form.id, requestFingerprint))
      .toMatchObject({ id: first.id });

    raw.prepare("UPDATE formaloo_recurring_submissions SET status = 'cancelled', sync_state = 'synced' WHERE id = ?")
      .run(first.id);
    const replacement = await reserveFormalooRecurringSubmission(db, {
      formId: form.id,
      idempotencyKey: 'after-cancel',
      requestFingerprint,
      schedule,
      submissionData: { inventory: 12 },
      status: 'resumed',
    });
    expect(replacement.id).not.toBe(first.id);
  });

  test('pending, failed, resumed, or paused mirrors block form deletion; only verified cancellation clears it', async () => {
    const form = await createFormalooForm(db, { title: '削除ガードフォーム' });
    const reserved = await reserveFormalooRecurringSubmission(db, {
      formId: form.id,
      idempotencyKey: 'blocking',
      requestFingerprint,
      schedule,
      submissionData: {},
      status: 'resumed',
    });
    await expect(hasBlockingFormalooRecurringSubmissions(db, form.id)).resolves.toBe(true);
    raw.prepare("UPDATE formaloo_recurring_submissions SET status = 'cancelled', sync_state = 'failed' WHERE id = ?")
      .run(reserved.id);
    await expect(hasBlockingFormalooRecurringSubmissions(db, form.id)).resolves.toBe(true);
    raw.prepare("UPDATE formaloo_recurring_submissions SET sync_state = 'synced' WHERE id = ?")
      .run(reserved.id);
    await expect(hasBlockingFormalooRecurringSubmissions(db, form.id)).resolves.toBe(false);
  });

  test('claim fencing allows one worker, stores only read-back-complete state, and scopes slug by form', async () => {
    const firstForm = await createFormalooForm(db, { title: 'テナントA' });
    const secondForm = await createFormalooForm(db, { title: 'テナントB' });
    const reserved = await reserveFormalooRecurringSubmission(db, {
      formId: firstForm.id,
      idempotencyKey: 'claim-1',
      requestFingerprint,
      schedule,
      submissionData: { stock: 8 },
      status: 'resumed',
    });
    await expect(claimFormalooRecurringSubmission(db, reserved.id, {
      token: 'worker-a', nowMs: 1_000, leaseMs: 30_000,
    })).resolves.toBe(true);
    await expect(claimFormalooRecurringSubmission(db, reserved.id, {
      token: 'worker-b', nowMs: 1_001, leaseMs: 30_000,
    })).resolves.toBe(false);

    await expect(completeFormalooRecurringSubmission(db, reserved.id, {
      token: 'worker-b',
      remoteSlug: 'rs_verified',
      requestFingerprint,
      schedule,
      submissionData: { stock: 8 },
      status: 'resumed',
    })).resolves.toBe(false);
    await expect(completeFormalooRecurringSubmission(db, reserved.id, {
      token: 'worker-a',
      remoteSlug: 'rs_verified',
      requestFingerprint,
      schedule,
      submissionData: { stock: 8 },
      status: 'resumed',
    })).resolves.toBe(true);

    expect(await getFormalooRecurringSubmissionBySlug(db, firstForm.id, 'rs_verified'))
      .toMatchObject({ syncState: 'synced', remoteSlug: 'rs_verified' });
    expect(await getFormalooRecurringSubmissionBySlug(db, secondForm.id, 'rs_verified')).toBeNull();
    expect(await listFormalooRecurringSubmissions(db, firstForm.id)).toHaveLength(1);
  });

  test('provider uncertainty keeps candidate slug/error for retry and release is owner-token fenced', async () => {
    const form = await createFormalooForm(db, { title: '失敗復旧フォーム' });
    const reserved = await reserveFormalooRecurringSubmission(db, {
      formId: form.id,
      idempotencyKey: 'unknown-outcome',
      requestFingerprint,
      schedule,
      submissionData: {},
      status: 'resumed',
    });
    await claimFormalooRecurringSubmission(db, reserved.id, {
      token: 'owner', nowMs: 10, leaseMs: 100,
    });
    await expect(markFormalooRecurringSubmissionFailed(db, reserved.id, {
      token: 'owner', candidateSlug: 'rs_candidate', error: 'read_back_failed',
    })).resolves.toBe(true);
    expect(await getFormalooRecurringSubmissionByIdempotencyKey(db, form.id, 'unknown-outcome'))
      .toMatchObject({ remoteSlug: 'rs_candidate', syncState: 'failed', lastError: 'read_back_failed' });
    await releaseFormalooRecurringSubmissionClaim(db, reserved.id, 'wrong-owner');
    await expect(claimFormalooRecurringSubmission(db, reserved.id, {
      token: 'next', nowMs: 11, leaseMs: 100,
    })).resolves.toBe(false);
    await releaseFormalooRecurringSubmissionClaim(db, reserved.id, 'owner');
    await expect(claimFormalooRecurringSubmission(db, reserved.id, {
      token: 'next', nowMs: 12, leaseMs: 100,
    })).resolves.toBe(true);
  });
});
