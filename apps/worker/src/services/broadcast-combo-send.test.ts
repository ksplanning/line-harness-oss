/**
 * C5 — 4 送信経路が buildBroadcastMessages の全メッセージを broadcast()/multicast() に
 * 同順序で渡す。combo(messages非NULL)は length N、single(messages NULL)は length 1。
 * scheduled/queued combo が cron 送信で全要素として送られる (codex HIGH #1/#8)。
 * multi-batch では text 要素のみ variation (applyBatchVariation)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach, vi } from 'vitest';

const sendCalls: Array<{ method: 'broadcast' | 'multicast'; messages: unknown[] }> = [];
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    constructor(public token: string) {}
    async multicast(_to: string[], msgs: unknown[]) { sendCalls.push({ method: 'multicast', messages: msgs }); return {}; }
    async broadcast(msgs: unknown[]) { sendCalls.push({ method: 'broadcast', messages: msgs }); return { requestId: 'r' }; }
    async pushMessage() { return {}; }
  },
}));

const { processQueuedBroadcasts, processBroadcastSend, applyBatchVariation } = await import('./broadcast.js');
const { processSegmentSend } = await import('./segment-send.js');
const { LineClient } = await import('@line-crm/line-sdk');
import type { Message } from '@line-crm/line-sdk';

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

const IMG = '{"originalContentUrl":"https://x/a.jpg","previewImageUrl":"https://x/a.jpg"}';
const COMBO = JSON.stringify([{ type: 'image', content: IMG }, { type: 'text', content: 'せつめい' }]);

let raw: Database.Database;
let db: D1Database;
beforeEach(() => {
  sendCalls.length = 0;
  raw = new Database(':memory:');
  replayAll(raw);
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES ('acc-1','ch','a','tok','sec')`).run();
  for (const [id, u] of [['f1', 'u1'], ['f2', 'u2'], ['f3', 'u3']]) {
    raw.prepare(`INSERT INTO friends (id, line_user_id, line_account_id, is_following) VALUES (?,?,?,1)`).run(id, u, 'acc-1');
  }
  db = d1(raw);
});

describe('applyBatchVariation (text 要素のみ揺らぎ / 順序保存 / 単一バッチ no-op)', () => {
  const combo: Message[] = [
    { type: 'image', originalContentUrl: 'https://x/a.jpg', previewImageUrl: 'https://x/a.jpg' } as unknown as Message,
    { type: 'text', text: 'hello' } as Message,
    { type: 'text', text: 'world' } as Message,
  ];
  test('single batch (totalBatches=1) → 不変', () => {
    expect(applyBatchVariation(combo, 0, 1)).toEqual(combo);
  });
  test('multi batch → text 要素のみ variation・非text不変・順序/長さ保存', () => {
    const out = applyBatchVariation(combo, 1, 2);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual(combo[0]); // image 不変
    expect((out[1] as { type: string }).type).toBe('text');
    expect((out[2] as { type: string }).type).toBe('text');
    // text は addMessageVariation で微変 (visible 変化なし・長さ >= 元)。
    expect((out[1] as { text: string }).text).not.toBe('hello');
    expect((out[2] as { text: string }).text).not.toBe('world');
  });
});

describe('processBroadcastSend (immediate / target=all → broadcast API)', () => {
  test('combo → broadcast(messages) length 2 (順序保存)', async () => {
    raw.prepare(`INSERT INTO broadcasts (id, title, message_type, message_content, target_type, status, messages, line_account_id) VALUES ('b-all','T','image',?,'all','draft',?,'acc-1')`).run(IMG, COMBO);
    await processBroadcastSend(db, new LineClient('tok') as never, 'b-all', undefined);
    const bcast = sendCalls.filter((c) => c.method === 'broadcast');
    expect(bcast).toHaveLength(1);
    expect(bcast[0].messages).toHaveLength(2);
    expect((bcast[0].messages[0] as { type: string }).type).toBe('image');
    expect((bcast[0].messages[1] as { type: string }).type).toBe('text');
  });
  test('single (messages NULL) → broadcast length 1 (byte-equivalent)', async () => {
    raw.prepare(`INSERT INTO broadcasts (id, title, message_type, message_content, target_type, status, line_account_id) VALUES ('b-s','T','text','hi','all','draft','acc-1')`).run();
    await processBroadcastSend(db, new LineClient('tok') as never, 'b-s', undefined);
    const bcast = sendCalls.filter((c) => c.method === 'broadcast');
    expect(bcast[0].messages).toHaveLength(1);
    expect((bcast[0].messages[0] as { type: string; text: string })).toEqual({ type: 'text', text: 'hi' });
  });
});

describe('processQueuedBroadcasts (cron / segment → multicast) — 予約 combo が全要素で送られる', () => {
  const seg = JSON.stringify({ operator: 'AND', rules: [{ type: 'is_following', value: true }] });
  test('scheduled/queued combo → multicast length 2 (単発送信されない)', async () => {
    raw.prepare(`INSERT INTO broadcasts (id, title, message_type, message_content, target_type, status, batch_offset, segment_conditions, line_account_id, messages) VALUES ('bq','T','image',?,'all','sending',0,?, 'acc-1',?)`).run(IMG, seg, COMBO);
    await processQueuedBroadcasts(db, new LineClient('tok') as never, undefined);
    const mc = sendCalls.filter((c) => c.method === 'multicast');
    expect(mc).toHaveLength(1);
    expect(mc[0].messages).toHaveLength(2);
    expect((mc[0].messages[0] as { type: string }).type).toBe('image');
  });
  test('queued single (messages NULL) → multicast length 1', async () => {
    raw.prepare(`INSERT INTO broadcasts (id, title, message_type, message_content, target_type, status, batch_offset, segment_conditions, line_account_id) VALUES ('bq2','T','text','hi','all','sending',0,?, 'acc-1')`).run(seg);
    await processQueuedBroadcasts(db, new LineClient('tok') as never, undefined);
    const mc = sendCalls.filter((c) => c.method === 'multicast');
    expect(mc[0].messages).toHaveLength(1);
  });
});

describe('processSegmentSend (segment → multicast)', () => {
  const cond = { operator: 'AND', rules: [{ type: 'is_following', value: true }] } as never;
  test('combo → multicast length 2', async () => {
    raw.prepare(`INSERT INTO broadcasts (id, title, message_type, message_content, target_type, status, line_account_id, messages) VALUES ('bs','T','image',?,'all','draft','acc-1',?)`).run(IMG, COMBO);
    await processSegmentSend(db, new LineClient('tok') as never, 'bs', cond);
    const mc = sendCalls.filter((c) => c.method === 'multicast');
    expect(mc).toHaveLength(1);
    expect(mc[0].messages).toHaveLength(2);
  });
  test('single → multicast length 1', async () => {
    raw.prepare(`INSERT INTO broadcasts (id, title, message_type, message_content, target_type, status, line_account_id) VALUES ('bs2','T','text','hi','all','draft','acc-1')`).run();
    await processSegmentSend(db, new LineClient('tok') as never, 'bs2', cond);
    const mc = sendCalls.filter((c) => c.method === 'multicast');
    expect(mc[0].messages).toHaveLength(1);
  });
});
