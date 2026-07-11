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

vi.mock('@line-crm/line-sdk', () => ({ LineClient: class { constructor(public t: string) {} } }));

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
  raw = new Database(':memory:');
  replayAll(raw);
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES ('acc-1','ch-1','A','t','s')`).run();
});

const IMG = '{"originalContentUrl":"https://x/a.jpg","previewImageUrl":"https://x/a.jpg"}';
const base = { title: 'C案', targetType: 'all', lineAccountId: 'acc-1' };
type PostResp = { data: { id: string; messageType: string; messageContent: string; messages: Array<{ type: string; content: string }> | null } };

describe('POST /api/broadcasts combo messages', () => {
  test('messages len2 → 201, persists JSON + mirrors blocks[0] to message_type/content', async () => {
    const messages = [{ type: 'image', content: IMG }, { type: 'text', content: 'せつめい' }];
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
});

describe('POST /api/broadcasts/:id/test-send combo gate (F2)', () => {
  async function createComboDraft(): Promise<string> {
    const messages = [{ type: 'image', content: IMG }, { type: 'text', content: 'a' }];
    const res = await app().request('/api/broadcasts', { method: 'POST', body: JSON.stringify({ ...base, messageType: 'image', messageContent: IMG, messages }) });
    return (await res.json() as PostResp).data.id;
  }

  test('combo 行への test-send → 400 fail-loud (先頭ブロックだけ送って owner を誤認させない)', async () => {
    const id = await createComboDraft();
    const ts = await app().request(`/api/broadcasts/${id}/test-send`, { method: 'POST', body: JSON.stringify({}) });
    expect(ts.status).toBe(400);
    const body = await ts.json() as { error: string };
    expect(body.error).toContain('組み合わせメッセージのテスト送信');
  });

  test('single 行の test-send は combo gate を通過する (combo エラーは出ない)', async () => {
    const res = await app().request('/api/broadcasts', { method: 'POST', body: JSON.stringify({ ...base, messageType: 'text', messageContent: 'hi' }) });
    const id = (await res.json() as PostResp).data.id;
    const ts = await app().request(`/api/broadcasts/${id}/test-send`, { method: 'POST', body: JSON.stringify({}) });
    // single は combo gate に当たらない (test_recipients 未設定などで別 400 になり得るが combo メッセージは出ない)。
    const body = await ts.json() as { error?: string };
    expect(body.error ?? '').not.toContain('組み合わせメッセージのテスト送信');
  });
});
