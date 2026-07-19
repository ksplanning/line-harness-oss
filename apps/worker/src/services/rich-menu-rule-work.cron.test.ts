import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const { workSpy } = vi.hoisted(() => ({
  workSpy: vi.fn(async () => ({ attempted: 0, queueProcessed: 0, jobsCompleted: 0 })),
}));
vi.mock('./rich-menu-rule-work.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./rich-menu-rule-work.js')>(),
  processRichMenuRuleWork: workSpy,
}));

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
        async run() {
          const info = statement.run(...(params as never[]));
          return { meta: { changes: info.changes } };
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

function replayAll(db: Database.Database): void {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(join(DB_ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    for (const sql of readFileSync(join(DB_ROOT, 'migrations', file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/)
      .map((part) => part.trim())
      .filter(Boolean)) {
      try { db.exec(sql); } catch (error) {
        if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
  }
}

let raw: Database.Database;
const tick = (cron: string) => ({ cron, scheduledTime: Date.now(), type: 'scheduled' }) as unknown as ScheduledEvent;
const CTX = {} as ExecutionContext;

function env(): Record<string, unknown> {
  return {
    DB: d1(raw),
    IMAGES: {},
    ASSETS: {},
    LINE_CHANNEL_SECRET: 'secret',
    LINE_CHANNEL_ACCESS_TOKEN: 'token',
    API_KEY: 'key',
    LIFF_URL: 'https://liff.example.test',
    LINE_CHANNEL_ID: 'channel',
    LINE_LOGIN_CHANNEL_ID: 'login-channel',
    LINE_LOGIN_CHANNEL_SECRET: 'login-secret',
    WORKER_URL: 'https://api.example.test',
  };
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  workSpy.mockClear();
});

describe('scheduled rich menu rule work', () => {
  test('runs once on the five-minute tick', async () => {
    await worker.scheduled(tick('*/5 * * * *'), env() as never, CTX);
    expect(workSpy).toHaveBeenCalledTimes(1);
    expect(workSpy).toHaveBeenCalledWith(expect.anything());
  });

  test('does not run on the six-hour tick', async () => {
    await worker.scheduled(tick('0 */6 * * *'), env() as never, CTX);
    expect(workSpy).not.toHaveBeenCalled();
  });
});
