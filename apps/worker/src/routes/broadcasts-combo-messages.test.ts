/**
 * C3 — POST/PUT /api/broadcasts が messages[](len1..5)を受理・検証・先頭ミラーする。
 *
 * 真理値表 (plan §5 R-12 / codex HIGH #4):
 *  - POST messages len2 → 201・messages JSON 永続 + message_content=blocks[0].content (先頭ミラー)
 *  - POST messages len6 / 空[] / 壊れ要素 → 400 (送らない)
 *  - POST messages 無し (従来 single) → 無改変・messages NULL
 *  - PUT messages 配列 → 検証 + messages 更新 + 先頭ミラー (原子的)
 *  - combo 行への messageContent 単独 PUT (messages 省略) → 400 (先頭だけ書換えて messages と不整合になる
 *    silent 事故を fail-loud で防ぐ)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const pushCalls = vi.hoisted(() => [] as Array<{ to: string; messages: unknown[] }>);
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    constructor(public t: string) {}
    async pushMessage(to: string, messages: unknown[]) {
      pushCalls.push({ to, messages });
      return {};
    }
  },
}));

const { broadcasts } = await import('./broadcasts.js');

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
    async batch(stmts: Array<{ run: () => Promise<unknown> }>) { const o = []; for (const st of stmts) o.push(await st.run()); return o; },
  } as unknown as D1Database;
}

let raw: Database.Database;
function app() {
  const a = new Hono<{ Bindings: { DB: D1Database; WORKER_URL: string } }>();
  a.use('*', async (c, next) => { c.env = { DB: d1(raw), WORKER_URL: 'https://w' } as never; await next(); });
  a.route('/', broadcasts);
  return a;
}

beforeEach(() => {
  pushCalls.length = 0;
  raw = new Database(':memory:');
  replayAll(raw);
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES ('acc-1','ch-1','A','t','s')`).run();
});

const IMG = '{"originalContentUrl":"https://x/a.jpg","previewImageUrl":"https://x/a.jpg"}';
const base = { title: 'C案', targetType: 'all', lineAccountId: 'acc-1' };
type PostResp = { data: { id: string; messageType: string; messageContent: string; altText?: string | null; messages: Array<{ type: string; content: string; altText?: string }> | null } };

describe('POST /api/broadcasts combo messages', () => {
  test('messages len2 → 201, persists JSON + mirrors blocks[0] to message_type/content', async () => {
    const messages = [{ type: 'image', content: IMG, altText: 'IMG ALT' }, { type: 'text', content: 'せつめい' }];
    const res = await app().request('/api/broadcasts', {
      method: 'POST',
      body: JSON.stringify({ ...base, messageType: 'image', messageContent: IMG, messages }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as PostResp;
    expect(body.data.messages).toHaveLength(2);
    // 先頭ミラー: message_type/content = blocks[0]。
    expect(body.data.messageType).toBe('image');
    expect(body.data.messageContent).toBe(IMG);
    expect(body.data.altText).toBe('IMG ALT');
    // DB 直: messages JSON 永続 + message_content=blocks[0].content。
    const row = raw.prepare(`SELECT messages, message_type, message_content FROM broadcasts WHERE id=?`).get(body.data.id) as { messages: string; message_type: string; message_content: string };
    expect(JSON.parse(row.messages)).toHaveLength(2);
    expect(row.message_type).toBe('image');
    expect(row.message_content).toBe(IMG);
    // GET でも messages が返る。
    const got = await app().request(`/api/broadcasts/${body.data.id}`);
    const gotBody = await got.json() as PostResp;
    expect(gotBody.data.messages).toHaveLength(2);
  });

  test('messages len6 → 400 (最大5)', async () => {
    const messages = Array.from({ length: 6 }, (_, i) => ({ type: 'text', content: `m${i}` }));
    const res = await app().request('/api/broadcasts', { method: 'POST', body: JSON.stringify({ ...base, messageType: 'text', messageContent: 'm0', messages }) });
    expect(res.status).toBe(400);
  });

  test('messages [] → 400 (1件以上)', async () => {
    const res = await app().request('/api/broadcasts', { method: 'POST', body: JSON.stringify({ ...base, messageType: 'text', messageContent: 'x', messages: [] }) });
    expect(res.status).toBe(400);
  });

  test('messages with broken image JSON element → 400 (fail-loud, not stored)', async () => {
    const messages = [{ type: 'text', content: 'ok' }, { type: 'image', content: '{not json' }];
    const res = await app().request('/api/broadcasts', { method: 'POST', body: JSON.stringify({ ...base, messageType: 'text', messageContent: 'ok', messages }) });
    expect(res.status).toBe(400);
    expect((raw.prepare(`SELECT COUNT(*) AS n FROM broadcasts`).get() as { n: number }).n).toBe(0);
  });

  test('legacy single POST (no messages) → 201, messages NULL (unchanged)', async () => {
    const res = await app().request('/api/broadcasts', { method: 'POST', body: JSON.stringify({ ...base, messageType: 'text', messageContent: 'hi' }) });
    expect(res.status).toBe(201);
    const body = await res.json() as PostResp;
    expect(body.data.messages).toBeNull();
    const row = raw.prepare(`SELECT messages FROM broadcasts WHERE id=?`).get(body.data.id) as { messages: string | null };
    expect(row.messages).toBeNull();
  });
});

describe('PUT /api/broadcasts/:id combo messages', () => {
  async function createCombo(): Promise<string> {
    const messages = [{ type: 'image', content: IMG }, { type: 'text', content: 'a' }];
    const res = await app().request('/api/broadcasts', { method: 'POST', body: JSON.stringify({ ...base, messageType: 'image', messageContent: IMG, messages }) });
    return (await res.json() as PostResp).data.id;
  }

  test('PUT messages array updates + mirrors blocks[0]', async () => {
    const id = await createCombo();
    const next = [{ type: 'text', content: 'first' }, { type: 'text', content: 'second' }, { type: 'text', content: 'third' }];
    const res = await app().request(`/api/broadcasts/${id}`, { method: 'PUT', body: JSON.stringify({ messages: next }) });
    expect(res.status).toBe(200);
    const row = raw.prepare(`SELECT messages, message_type, message_content FROM broadcasts WHERE id=?`).get(id) as { messages: string; message_type: string; message_content: string };
    expect(JSON.parse(row.messages)).toHaveLength(3);
    expect(row.message_type).toBe('text');
    expect(row.message_content).toBe('first');
  });

  test('combo 行への messageContent 単独 PUT (messages 省略) → 400 (fail-loud)', async () => {
    const id = await createCombo();
    const res = await app().request(`/api/broadcasts/${id}`, { method: 'PUT', body: JSON.stringify({ messageContent: 'clobber' }) });
    expect(res.status).toBe(400);
    // messages/message_content は不変 (silent 破壊が起きていない)。
    const row = raw.prepare(`SELECT messages, message_content FROM broadcasts WHERE id=?`).get(id) as { messages: string; message_content: string };
    expect(row.message_content).toBe(IMG);
    expect(JSON.parse(row.messages)).toHaveLength(2);
  });

  test('single 行 (messages NULL) への従来 PUT は無改変で通る', async () => {
    const res = await app().request('/api/broadcasts', { method: 'POST', body: JSON.stringify({ ...base, messageType: 'text', messageContent: 'hi' }) });
    const id = (await res.json() as PostResp).data.id;
    const put = await app().request(`/api/broadcasts/${id}`, { method: 'PUT', body: JSON.stringify({ messageContent: 'updated' }) });
    expect(put.status).toBe(200);
    const row = raw.prepare(`SELECT messages, message_content FROM broadcasts WHERE id=?`).get(id) as { messages: string | null; message_content: string };
    expect(row.messages).toBeNull();
    expect(row.message_content).toBe('updated');
  });

  test('PUT messages len6 → 400', async () => {
    const id = await createCombo();
    const next = Array.from({ length: 6 }, (_, i) => ({ type: 'text', content: `m${i}` }));
    const res = await app().request(`/api/broadcasts/${id}`, { method: 'PUT', body: JSON.stringify({ messages: next }) });
    expect(res.status).toBe(400);
  });

  // ---- len1 (messages 配列 len1 = 実質 single) 行: 単一フィールド PUT を許し messages[0] を同期する ----
  // (line-combo-iscombo-fix / 将来のインライン編集で len1 行が 400 で詰む地雷の除去 + ミラー乖離ゼロ)
  async function createLen1(altText?: string): Promise<string> {
    const block: Record<string, unknown> = { type: 'text', content: 'orig' };
    if (altText !== undefined) block.altText = altText;
    const res = await app().request('/api/broadcasts', {
      method: 'POST',
      body: JSON.stringify({ ...base, messageType: 'text', messageContent: 'orig', messages: [block] }),
    });
    return (await res.json() as PostResp).data.id;
  }

  test('len1 行への messageContent 単独 PUT → 200 + messages[0].content 同期 + ミラー列更新', async () => {
    const id = await createLen1();
    const res = await app().request(`/api/broadcasts/${id}`, { method: 'PUT', body: JSON.stringify({ messageContent: 'updated' }) });
    expect(res.status).toBe(200);
    const row = raw.prepare(`SELECT messages, message_type, message_content FROM broadcasts WHERE id=?`).get(id) as { messages: string; message_type: string; message_content: string };
    // ミラー列が更新される。
    expect(row.message_content).toBe('updated');
    // messages[0] も同一書込で同期 → ミラー⇔messages[0] 乖離ゼロ (送信経路 buildBroadcastMessages は messages 優先)。
    const blocks = JSON.parse(row.messages) as Array<{ type: string; content: string }>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('text');
    expect(blocks[0].content).toBe('updated');
  });

  test('len1 行の単一フィールド PUT は messages[0].altText を保持する (single-field 更新で消さない)', async () => {
    const id = await createLen1('ALTKEEP');
    const res = await app().request(`/api/broadcasts/${id}`, { method: 'PUT', body: JSON.stringify({ messageContent: 'new body' }) });
    expect(res.status).toBe(200);
    const row = raw.prepare(`SELECT messages FROM broadcasts WHERE id=?`).get(id) as { messages: string };
    const blocks = JSON.parse(row.messages) as Array<{ type: string; content: string; altText?: string }>;
    expect(blocks[0].content).toBe('new body');
    expect(blocks[0].altText).toBe('ALTKEEP');
  });
});

describe('POST /api/broadcasts/:id/test-send combo gate (F2)', () => {
  async function createComboDraft(): Promise<string> {
    const messages = [{ type: 'image', content: IMG }, { type: 'text', content: 'a' }];
    const res = await app().request('/api/broadcasts', { method: 'POST', body: JSON.stringify({ ...base, messageType: 'image', messageContent: IMG, messages }) });
    return (await res.json() as PostResp).data.id;
  }

  function configureTestRecipient(friendId = 'friend-self', accountId = 'acc-1') {
    raw.prepare(`INSERT INTO friends (id, line_user_id, display_name, line_account_id, is_following) VALUES (?, ?, ?, ?, 1)`)
      .run(friendId, `U-${friendId}`, '自分', accountId);
    raw.prepare(`INSERT INTO account_settings (id, line_account_id, key, value) VALUES (?, ?, 'test_recipients', ?)`)
      .run(`setting-${accountId}`, accountId, JSON.stringify([friendId]));
  }

  test('combo 行の test-send は設定先にのみ全ブロックを順序どおり送る', async () => {
    const id = await createComboDraft();
    configureTestRecipient();
    const ts = await app().request(`/api/broadcasts/${id}/test-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: 'saved-combo-test-send' }),
    });
    expect(ts.status).toBe(200);
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0].to).toBe('U-friend-self');
    expect(pushCalls[0].messages).toHaveLength(2);
    expect((pushCalls[0].messages[1] as { text: string }).text).toContain('a');
    expect(raw.prepare(`SELECT friend_id, delivery_type, source, broadcast_id FROM messages_log`).all()).toEqual([
      { friend_id: 'friend-self', delivery_type: 'test', source: 'test', broadcast_id: null },
    ]);
  });

  test('壊れた設定の別アカウント友だちには送らない', async () => {
    const id = await createComboDraft();
    raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES ('acc-2','ch-2','B','t2','s2')`).run();
    configureTestRecipient('friend-other', 'acc-2');
    raw.prepare(`INSERT INTO account_settings (id, line_account_id, key, value) VALUES ('setting-corrupt', 'acc-1', 'test_recipients', ?)`)
      .run(JSON.stringify(['friend-other']));
    const ts = await app().request(`/api/broadcasts/${id}/test-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: 'saved-cross-account' }),
    });
    expect(ts.status).toBe(400);
    expect(pushCalls).toEqual([]);
  });

  test('single 行の test-send は combo gate を通過する (combo エラーは出ない)', async () => {
    const res = await app().request('/api/broadcasts', { method: 'POST', body: JSON.stringify({ ...base, messageType: 'text', messageContent: 'hi' }) });
    const id = (await res.json() as PostResp).data.id;
    const ts = await app().request(`/api/broadcasts/${id}/test-send`, { method: 'POST', body: JSON.stringify({}) });
    // single は combo gate に当たらない (test_recipients 未設定などで別 400 になり得るが combo メッセージは出ない)。
    const body = await ts.json() as { error?: string };
    expect(body.error ?? '').not.toContain('組み合わせメッセージのテスト送信');
  });

  test('len1 (messages 配列 len1 = 実質 single) 行の test-send は combo gate を通過する', async () => {
    const res = await app().request('/api/broadcasts', { method: 'POST', body: JSON.stringify({ ...base, messageType: 'text', messageContent: 'hi', messages: [{ type: 'text', content: 'hi' }] }) });
    const id = (await res.json() as PostResp).data.id;
    const ts = await app().request(`/api/broadcasts/${id}/test-send`, { method: 'POST', body: JSON.stringify({}) });
    // len1 は真 combo (len>1) ではない → combo gate に当たらない (別 400 になり得るが combo メッセージは出ない)。
    const body = await ts.json() as { error?: string };
    expect(body.error ?? '').not.toContain('組み合わせメッセージのテスト送信');
  });
});

describe('GET /api/broadcasts/:id/per-account-stats test-send isolation', () => {
  test("delivery_type='test' は実配信数に混ぜない", async () => {
    const created = await app().request('/api/broadcasts', {
      method: 'POST',
      body: JSON.stringify({ ...base, messageType: 'text', messageContent: 'stats' }),
    });
    const id = (await created.json() as PostResp).data.id;
    raw.prepare(`INSERT INTO friends (id, line_user_id, display_name, line_account_id, is_following) VALUES ('friend-stats', 'U-stats', '集計', 'acc-1', 1)`).run();
    const insert = raw.prepare(
      `INSERT INTO messages_log
         (id, friend_id, direction, message_type, content, broadcast_id, delivery_type, source, line_account_id, created_at)
       VALUES (?, 'friend-stats', 'outgoing', 'text', 'stats', ?, ?, ?, 'acc-1', '2026-07-20T00:00:00+09:00')`,
    );
    insert.run('log-push', id, 'push', 'broadcast');
    insert.run('log-test', id, 'test', 'test');

    const res = await app().request(`/api/broadcasts/${id}/per-account-stats`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<{ accountId: string; sent: number }> };
    expect(body.data).toEqual([expect.objectContaining({ accountId: 'acc-1', sent: 1 })]);
  });
});
