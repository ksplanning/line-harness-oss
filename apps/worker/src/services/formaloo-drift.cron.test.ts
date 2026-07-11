// T-C1 — scheduled() の drift-check dispatch gating。
//   6h cron tick でのみ runFormalooDriftCheck を dispatch し、5min tick では dispatch しない。
//   FORMALOO_DRIFT_ENABLED='false' は 6h でも入口 skip。auto-apply flag は
//   env.FORMALOO_DRIFT_AUTO_APPLY==='true' で渡る (既定 OFF)。
// 手法: formaloo-drift モジュールのみ spy に差し替え、他 job は空 in-memory DB 上で no-op 実行させる
//   (scheduled の cron 分岐を behavior として検証 / 全 job は空テーブルで副作用なし)。
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { driftSpy } = vi.hoisted(() => ({
  driftSpy: vi.fn(async () => ({ checked: 0, bootstrapped: 0, autoApplied: 0, notified: 0, conflicts: 0, inSync: 0, skipped: 0 })),
}));
vi.mock('./formaloo-drift.js', () => ({ runFormalooDriftCheck: driftSpy }));

// index.ts は resolveFormalooClient も import するが drift gate では未使用 (client 解決は runner 内)。
import worker from '../index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const s = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (s.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: s.all(...(params as never[])) as T[] }; },
        async run() { const info = s.run(...(params as never[])); return { meta: { changes: info.changes } }; },
      };
      return api;
    },
  } as unknown as D1Database;
}
function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(DB_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(DB_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      try { db.exec(stmt); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

let raw: Database.Database;
function env(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    DB: d1(raw),
    IMAGES: {}, ASSETS: {},
    LINE_CHANNEL_SECRET: 's', LINE_CHANNEL_ACCESS_TOKEN: 't', API_KEY: 'k',
    LIFF_URL: 'https://liff.example.test', LINE_CHANNEL_ID: 'c', LINE_LOGIN_CHANNEL_ID: 'lc',
    LINE_LOGIN_CHANNEL_SECRET: 'ls', WORKER_URL: 'https://api.example.com',
    ...over,
  };
}
const CTX = {} as ExecutionContext;
const tick = (cron: string) => ({ cron, scheduledTime: Date.now(), type: 'scheduled' }) as unknown as ScheduledEvent;

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  driftSpy.mockClear();
});

describe('scheduled() — formaloo drift dispatch gating (T-C1)', () => {
  it("cron='0 */6 * * *' で runFormalooDriftCheck を dispatch する", async () => {
    await worker.scheduled(tick('0 */6 * * *'), env() as never, CTX);
    expect(driftSpy).toHaveBeenCalledTimes(1);
    expect(driftSpy.mock.calls[0][0]).toMatchObject({ autoApplyEnabled: false }); // 既定 OFF
  });

  it("cron='*/5 * * * *' では dispatch しない (5min では走らない)", async () => {
    await worker.scheduled(tick('*/5 * * * *'), env() as never, CTX);
    expect(driftSpy).not.toHaveBeenCalled();
  });

  it("FORMALOO_DRIFT_ENABLED='false' は 6h tick でも入口 skip", async () => {
    await worker.scheduled(tick('0 */6 * * *'), env({ FORMALOO_DRIFT_ENABLED: 'false' }) as never, CTX);
    expect(driftSpy).not.toHaveBeenCalled();
  });

  it("FORMALOO_DRIFT_AUTO_APPLY='true' で autoApplyEnabled=true が渡る (案 A)", async () => {
    await worker.scheduled(tick('0 */6 * * *'), env({ FORMALOO_DRIFT_AUTO_APPLY: 'true' }) as never, CTX);
    expect(driftSpy).toHaveBeenCalledTimes(1);
    expect(driftSpy.mock.calls[0][0]).toMatchObject({ autoApplyEnabled: true });
  });
});
