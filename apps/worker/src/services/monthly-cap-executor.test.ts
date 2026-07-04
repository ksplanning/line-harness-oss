/**
 * T-C6 / D-4 (F2 batch4 G2) — authoritative executor gate の実 SQLite + mock LINE client 検証。
 * enqueue 後に cap 到達したケースで processQueuedBroadcasts が **実 multicast を叩かず** status を
 * draft に戻すこと、cap=null では通常どおり送ること (誤爆ゼロ) を証明する。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach, vi } from 'vitest';

// LINE client を mock して multicast/broadcast の呼び出しを捕捉する。
const multicastCalls: Array<{ to: string[]; unit: unknown }> = [];
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    constructor(public token: string) {}
    async multicast(to: string[], _msgs: unknown[], unit: unknown) { multicastCalls.push({ to, unit }); return {}; }
    async broadcast() { return { requestId: 'r' }; }
    async pushMessage() { return {}; }
  },
}));

const { processQueuedBroadcasts } = await import('./broadcast.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(DB_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const stmt of readFileSync(join(DB_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      try { db.exec(stmt); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const s = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...a: unknown[]) { params = a; return api; },
        async first<T>() { return (s.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: s.all(...(params as never[])) as T[] }; },
        async run() { const i = s.run(...(params as never[])); return { meta: { changes: i.changes } }; },
      };
      return api;
    },
    async batch(stmts: Array<{ run: () => Promise<unknown> }>) { const out = []; for (const st of stmts) out.push(await st.run()); return out; },
  } as unknown as D1Database;
}

function seedQueuedSegmentBroadcast(raw: Database.Database, cap: number | null) {
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, monthly_cap) VALUES ('acc-1','ch','a','tok','sec',?)`).run(cap);
  for (const [id, u] of [['f1', 'u1'], ['f2', 'u2'], ['f3', 'u3']]) {
    raw.prepare(`INSERT INTO friends (id, line_user_id, line_account_id, is_following) VALUES (?,?,?,1)`).run(id, u, 'acc-1');
  }
  const seg = JSON.stringify({ operator: 'AND', rules: [{ type: 'is_following', value: true }] });
  raw.prepare(
    `INSERT INTO broadcasts (id, title, message_type, message_content, target_type, status, batch_offset, segment_conditions, line_account_id, total_count, success_count)
     VALUES ('b1','T','text','hi','all','sending',0,?, 'acc-1', 0, 0)`,
  ).run(seg);
}

beforeEach(() => { multicastCalls.length = 0; });

describe('processQueuedBroadcasts authoritative cap gate', () => {
  test('cap exceeded → NO multicast, broadcast reset to draft (executor stops send)', async () => {
    const raw = new Database(':memory:');
    replayAll(raw);
    seedQueuedSegmentBroadcast(raw, 1); // cap=1, recipients=3 → 0+3 > 1 → block
    const db = d1(raw);
    await processQueuedBroadcasts(db, new (await import('@line-crm/line-sdk')).LineClient('tok'), undefined);
    expect(multicastCalls.length).toBe(0); // 実送信ゼロ
    const b = raw.prepare(`SELECT status, batch_offset FROM broadcasts WHERE id='b1'`).get() as { status: string; batch_offset: number };
    expect(b.status).toBe('draft'); // 上限まで送らず差し戻し
  });

  test('cap=null → sends normally (誤爆ゼロ・既定挙動不変)', async () => {
    const raw = new Database(':memory:');
    replayAll(raw);
    seedQueuedSegmentBroadcast(raw, null); // unlimited
    const db = d1(raw);
    await processQueuedBroadcasts(db, new (await import('@line-crm/line-sdk')).LineClient('tok'), undefined);
    expect(multicastCalls.length).toBe(1); // 3 friends = 1 batch
    expect(multicastCalls[0].to.sort()).toEqual(['u1', 'u2', 'u3']);
  });

  test('cap high enough → sends (count+pending <= cap)', async () => {
    const raw = new Database(':memory:');
    replayAll(raw);
    seedQueuedSegmentBroadcast(raw, 100);
    const db = d1(raw);
    await processQueuedBroadcasts(db, new (await import('@line-crm/line-sdk')).LineClient('tok'), undefined);
    expect(multicastCalls.length).toBe(1);
  });
});
