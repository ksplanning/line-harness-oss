/**
 * C6 — auto-track(offset 0)が messages 配列の各 text/flex 要素のリンクをトラッキング化し、
 * 更新後 messages を先頭ミラー付きで persist する。offset>0 で再走しない。single は従来挙動。
 * block 単位のクリック帰属は v1 対象外 (全要素のリンクが漏れなく tracking 化されればよい)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach, vi } from 'vitest';

const sendCalls: Array<{ messages: Array<{ type: string; text?: string }> }> = [];
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    constructor(public token: string) {}
    async multicast(_to: string[], msgs: Array<{ type: string; text?: string }>) { sendCalls.push({ messages: msgs }); return {}; }
    async broadcast() { return { requestId: 'r' }; }
    async pushMessage() { return {}; }
  },
}));

const { processQueuedBroadcasts } = await import('./broadcast.js');
const { LineClient } = await import('@line-crm/line-sdk');

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

const seg = JSON.stringify({ operator: 'AND', rules: [{ type: 'is_following', value: true }] });
let raw: Database.Database;
let db: D1Database;
beforeEach(() => {
  sendCalls.length = 0;
  raw = new Database(':memory:');
  replayAll(raw);
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES ('acc-1','ch','a','tok','sec')`).run();
  for (const [id, u] of [['f1', 'u1'], ['f2', 'u2']]) {
    raw.prepare(`INSERT INTO friends (id, line_user_id, line_account_id, is_following) VALUES (?,?,?,1)`).run(id, u, 'acc-1');
  }
  db = d1(raw);
});

function insertQueued(id: string, messages: string | null, firstContent: string, batchOffset = 0) {
  raw.prepare(
    `INSERT INTO broadcasts (id, title, message_type, message_content, target_type, status, batch_offset, segment_conditions, line_account_id, messages)
     VALUES (?, 'T','text',?,'all','sending',?,?, 'acc-1', ?)`,
  ).run(id, firstContent, batchOffset, seg, messages);
}

describe('C6 combo auto-track (queued / offset 0)', () => {
  test('every text element URL is tracking-wrapped; messages persisted + first-mirror', async () => {
    const messages = JSON.stringify([
      { type: 'text', content: '一つ目 https://example.com/a' },
      { type: 'text', content: '二つ目 https://example.com/b' },
    ]);
    insertQueued('bc', messages, '一つ目 https://example.com/a');
    await processQueuedBroadcasts(db, new LineClient('tok') as never, 'https://w');

    // DB messages 永続: 両要素のリンクが /t/ tracking URL 化。
    const row = raw.prepare(`SELECT messages, message_type, message_content FROM broadcasts WHERE id='bc'`).get() as { messages: string; message_type: string; message_content: string };
    const persisted = JSON.parse(row.messages) as Array<{ content: string }>;
    expect(persisted[0].content).toContain('https://w/t/');
    expect(persisted[1].content).toContain('https://w/t/'); // 2通目のリンクも追跡される
    expect(persisted[0].content).not.toContain('example.com'); // raw URL は tracking へ置換済
    // 先頭ミラー: message_content = tracked blocks[0].content。
    expect(row.message_content).toBe(persisted[0].content);
    expect(row.message_type).toBe('text');

    // multicast も tracked messages を受け取る (length 2)。
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].messages).toHaveLength(2);
    expect(sendCalls[0].messages[0].text).toContain('https://w/t/');
    expect(sendCalls[0].messages[1].text).toContain('https://w/t/');
  });

  test('single (messages NULL) with URL → message_content tracked (従来挙動)', async () => {
    insertQueued('bs', null, '見てね https://example.com/x');
    await processQueuedBroadcasts(db, new LineClient('tok') as never, 'https://w');
    const row = raw.prepare(`SELECT messages, message_content FROM broadcasts WHERE id='bs'`).get() as { messages: string | null; message_content: string };
    expect(row.messages).toBeNull();
    expect(row.message_content).toContain('https://w/t/');
  });

  test('offset>0 → auto-track は再走しない (messages 不変)', async () => {
    const messages = JSON.stringify([{ type: 'text', content: 'まだ raw https://example.com/z' }]);
    insertQueued('bo', messages, 'まだ raw https://example.com/z', 1); // batch_offset=1
    await processQueuedBroadcasts(db, new LineClient('tok') as never, 'https://w');
    const row = raw.prepare(`SELECT messages FROM broadcasts WHERE id='bo'`).get() as { messages: string };
    // 再走せず tracking 化されない (offset 0 でのみ走る)。
    expect(row.messages).toBe(messages);
    expect(row.messages).toContain('example.com');
    // tracked_links も新規生成されない (auto-track skip)。
    expect((raw.prepare(`SELECT COUNT(*) AS n FROM tracked_links`).get() as { n: number }).n).toBe(0);
  });
});
