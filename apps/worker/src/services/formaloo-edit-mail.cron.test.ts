import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { outboxSpy } = vi.hoisted(() => ({
  outboxSpy: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0, skipped: 0 })),
}));
vi.mock('./formaloo-edit-mail.js', () => ({ runFormalooEditMailOutbox: outboxSpy }));

import worker from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
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
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(join(DB_ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    for (const sql of readFileSync(join(DB_ROOT, 'migrations', file), 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      try { db.exec(sql); } catch (error) { if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error; }
    }
  }
}

let raw: Database.Database;
const tick = (cron: string) => ({ cron, scheduledTime: Date.now(), type: 'scheduled' }) as unknown as ScheduledEvent;
const CTX = {} as ExecutionContext;

function env(patch: Record<string, unknown> = {}) {
  return {
    DB: d1(raw), IMAGES: {}, ASSETS: {},
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'k',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://worker.example.test',
    FORM_EDIT_MAIL_ENABLED: 'true',
    ...patch,
  };
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  outboxSpy.mockClear();
});

describe('scheduled() — Formaloo edit-mail outbox', () => {
  it("*/5 tickでbounded outbox runnerを1回呼ぶ", async () => {
    const bindings = env();
    await worker.scheduled(tick('*/5 * * * *'), bindings as never, CTX);
    expect(outboxSpy).toHaveBeenCalledTimes(1);
    expect(outboxSpy).toHaveBeenCalledWith(bindings);
  });

  it('6h tickではedit-mail outboxを呼ばない', async () => {
    await worker.scheduled(tick('0 */6 * * *'), env() as never, CTX);
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it('FORM_EDIT_MAIL_ENABLED未設定なら5分tickでも呼ばない', async () => {
    await worker.scheduled(tick('*/5 * * * *'), env({ FORM_EDIT_MAIL_ENABLED: undefined }) as never, CTX);
    expect(outboxSpy).not.toHaveBeenCalled();
  });
});
