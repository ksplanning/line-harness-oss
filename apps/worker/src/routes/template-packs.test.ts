/**
 * template-packs route (F2 G16 C3) — pack + 順序付き items CRUD + account-scope guard + 送信ゼロ。
 *
 *   - POST 作成 (201) → GET 一覧 (account-scoped・itemCount 付き)
 *   - POST name 空を 400
 *   - flex item の不正 JSON を 400
 *   - PATCH で items 差し替え (並び替え) / rename
 *   - DELETE で pack 削除
 *   - 4 verb account-scope guard: 別 account のパックは list/GET/PATCH/DELETE で見えない/403
 *   - LINE Messaging API への outbound ゼロ
 *   - 未認証は 401
 */
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const hoisted = vi.hoisted(() => ({
  packs: new Map<string, { id: string; account_id: string; name: string; items: Array<{ order_index: number; message_type: string; message_content: string }> }>(),
  fetchCalls: [] as string[],
}));

vi.mock('@line-crm/db', async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  let seq = 0;
  const withItems = (p: { id: string; account_id: string; name: string; items: Array<{ order_index: number; message_type: string; message_content: string }> }) => ({
    id: p.id,
    account_id: p.account_id,
    name: p.name,
    created_at: 'now',
    updated_at: 'now',
    items: p.items.map((it, i) => ({ id: `${p.id}-i${i}`, pack_id: p.id, order_index: it.order_index, message_type: it.message_type, message_content: it.message_content, created_at: 'now', updated_at: 'now' })),
  });
  return {
    ...actual,
    listTemplatePacks: vi.fn(async (_db: unknown, accountId: string) =>
      [...hoisted.packs.values()].filter((p) => p.account_id === accountId).map((p) => ({ id: p.id, account_id: p.account_id, name: p.name, created_at: 'now', updated_at: 'now', itemCount: p.items.length })),
    ),
    getTemplatePackById: vi.fn(async (_db: unknown, id: string) => {
      const p = hoisted.packs.get(id);
      return p ? { id: p.id, account_id: p.account_id, name: p.name, created_at: 'now', updated_at: 'now' } : null;
    }),
    getTemplatePackWithItems: vi.fn(async (_db: unknown, id: string) => {
      const p = hoisted.packs.get(id);
      return p ? withItems(p) : null;
    }),
    createTemplatePack: vi.fn(async (_db: unknown, input: { accountId: string; name: string; items: Array<{ messageType: string; messageContent: string }> }) => {
      const id = `p-${++seq}`;
      const p = { id, account_id: input.accountId, name: input.name, items: input.items.map((it, i) => ({ order_index: i, message_type: it.messageType, message_content: it.messageContent })) };
      hoisted.packs.set(id, p);
      return withItems(p);
    }),
    updateTemplatePack: vi.fn(async (_db: unknown, id: string, input: { name?: string; items?: Array<{ messageType: string; messageContent: string }> }) => {
      const p = hoisted.packs.get(id);
      if (!p) return null;
      if (input.name !== undefined) p.name = input.name;
      if (input.items !== undefined) p.items = input.items.map((it, i) => ({ order_index: i, message_type: it.messageType, message_content: it.messageContent }));
      return withItems(p);
    }),
    deleteTemplatePack: vi.fn(async (_db: unknown, id: string) => hoisted.packs.delete(id)),
  };
});

import { authMiddleware } from '../middleware/auth.js';
import { templatePacks } from './template-packs.js';

const mockDb = { prepare() { return { bind() { return this; }, async first() { return null; }, async all() { return { results: [] }; }, async run() { return {}; } }; } } as unknown as D1Database;

function setupApp() {
  const app = new Hono();
  app.use('*', async (c, next) => { (c.env as unknown) = { DB: mockDb, API_KEY: 'test-key' }; await next(); });
  app.use('*', authMiddleware);
  app.route('/', templatePacks);
  return app;
}

const AUTH = { headers: { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' } };

const PACK_MEDIA_FIXTURES = [
  ['image', JSON.stringify({ originalContentUrl: 'https://cdn.example.com/original.png', previewImageUrl: 'https://cdn.example.com/preview.png' })],
  ['video', JSON.stringify({ originalContentUrl: 'https://cdn.example.com/video.mp4', previewImageUrl: 'https://cdn.example.com/video-preview.png' })],
  ['audio', JSON.stringify({ originalContentUrl: 'https://cdn.example.com/audio.m4a', duration: 60_000 })],
  ['sticker', JSON.stringify({ packageId: '11537', stickerId: '52002734' })],
  ['imagemap', JSON.stringify({
    baseUrl: 'https://cdn.example.com/imagemap',
    altText: '画像分割',
    baseSize: { width: 1040, height: 1040 },
    actions: [{ type: 'uri', linkUri: 'https://example.com', area: { x: 0, y: 0, width: 1040, height: 1040 } }],
  })],
  ['richvideo', JSON.stringify({
    baseUrl: 'https://cdn.example.com/richvideo',
    altText: '動画',
    baseSize: { width: 1040, height: 1040 },
    actions: [],
    video: { originalContentUrl: 'https://cdn.example.com/video.mp4', previewImageUrl: 'https://cdn.example.com/video-preview.png', area: { x: 0, y: 0, width: 1040, height: 1040 } },
  })],
] as const;

const BROKEN_PACK_MEDIA_FIXTURES = [
  ['image', '{broken'],
  ['video', JSON.stringify({ originalContentUrl: 'https://cdn.example.com/video.mp4' })],
  ['audio', JSON.stringify({ originalContentUrl: 'https://cdn.example.com/audio.m4a', duration: 0 })],
  ['sticker', JSON.stringify({ stickerId: '52002734' })],
  ['imagemap', JSON.stringify({ baseUrl: 'https://cdn.example.com/imagemap', actions: [] })],
  ['imagemap', JSON.stringify({ baseUrl: 'https://cdn.example.com/imagemap', baseSize: { width: 999, height: 1040 }, actions: [] })],
  ['richvideo', JSON.stringify({ baseUrl: 'https://cdn.example.com/richvideo', baseSize: { width: 1040, height: 1040 }, actions: [] })],
] as const;

beforeEach(() => {
  hoisted.packs.clear();
  hoisted.fetchCalls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { hoisted.fetchCalls.push(String(url)); return new Response('{}', { status: 200 }); }));
});

async function req(path: string, init?: RequestInit) {
  return setupApp().request(path, { ...AUTH, ...init });
}

describe('template-packs CRUD (account-scoped)', () => {
  test('POST creates (201) and GET lists with itemCount, account-scoped', async () => {
    const post = await req('/api/template-packs?accountId=acc-1', {
      method: 'POST',
      body: JSON.stringify({ name: '初回あいさつ', items: [{ messageType: 'text', messageContent: 'hi' }, { messageType: 'text', messageContent: 'bye' }] }),
    });
    expect(post.status).toBe(201);
    const list = await req('/api/template-packs?accountId=acc-1');
    const body = await list.json<{ data: Array<{ name: string; itemCount: number }> }>();
    expect(body.data).toEqual([expect.objectContaining({ name: '初回あいさつ', itemCount: 2 })]);
    // 別 account には出ない。
    expect((await (await req('/api/template-packs?accountId=acc-2')).json<{ data: unknown[] }>()).data).toEqual([]);
  });

  test('POST with empty name is 400', async () => {
    const res = await req('/api/template-packs?accountId=acc-1', { method: 'POST', body: JSON.stringify({ name: ' ', items: [] }) });
    expect(res.status).toBe(400);
  });

  test('POST with invalid flex JSON is 400', async () => {
    const res = await req('/api/template-packs?accountId=acc-1', {
      method: 'POST',
      body: JSON.stringify({ name: 'p', items: [{ messageType: 'flex', messageContent: '{not json' }] }),
    });
    expect(res.status).toBe(400);
  });

  test.each(PACK_MEDIA_FIXTURES)('POST accepts a valid %s item without rewriting its content bytes', async (messageType, messageContent) => {
    const res = await req('/api/template-packs?accountId=acc-1', {
      method: 'POST',
      body: JSON.stringify({ name: `${messageType} pack`, items: [{ messageType, messageContent }] }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ data: { items: Array<{ message_type: string; message_content: string }> } }>();
    expect(body.data.items).toEqual([
      expect.objectContaining({ message_type: messageType, message_content: messageContent }),
    ]);
    expect(new TextEncoder().encode(body.data.items[0].message_content)).toEqual(new TextEncoder().encode(messageContent));
  });

  test.each(BROKEN_PACK_MEDIA_FIXTURES)('POST rejects malformed %s content before persistence', async (messageType, messageContent) => {
    const res = await req('/api/template-packs?accountId=acc-1', {
      method: 'POST',
      body: JSON.stringify({ name: `${messageType} broken`, items: [{ messageType, messageContent }] }),
    });
    expect(res.status).toBe(400);
  });

  test('GET /:id returns pack with ordered items', async () => {
    const { data } = await (await req('/api/template-packs?accountId=acc-1', { method: 'POST', body: JSON.stringify({ name: 'p', items: [{ messageType: 'text', messageContent: 'A' }, { messageType: 'text', messageContent: 'B' }] }) })).json<{ data: { id: string } }>();
    const detail = await req(`/api/template-packs/${data.id}?accountId=acc-1`);
    const body = await detail.json<{ data: { items: Array<{ order_index: number; message_content: string }> } }>();
    expect(body.data.items.map((i) => i.message_content)).toEqual(['A', 'B']);
  });

  test('PATCH replaces items (reorder) and renames', async () => {
    const { data } = await (await req('/api/template-packs?accountId=acc-1', { method: 'POST', body: JSON.stringify({ name: '旧', items: [{ messageType: 'text', messageContent: 'A' }] }) })).json<{ data: { id: string } }>();
    const patch = await req(`/api/template-packs/${data.id}?accountId=acc-1`, { method: 'PATCH', body: JSON.stringify({ name: '新', items: [{ messageType: 'text', messageContent: 'B' }, { messageType: 'text', messageContent: 'A' }] }) });
    const body = await patch.json<{ data: { name: string; items: Array<{ message_content: string }> } }>();
    expect(body.data.name).toBe('新');
    expect(body.data.items.map((i) => i.message_content)).toEqual(['B', 'A']);
  });

  test('PATCH with invalid flex JSON is 400', async () => {
    const { data } = await (await req('/api/template-packs?accountId=acc-1', { method: 'POST', body: JSON.stringify({ name: 'p', items: [] }) })).json<{ data: { id: string } }>();
    const patch = await req(`/api/template-packs/${data.id}?accountId=acc-1`, { method: 'PATCH', body: JSON.stringify({ items: [{ messageType: 'flex', messageContent: 'oops' }] }) });
    expect(patch.status).toBe(400);
  });

  test('DELETE removes the pack', async () => {
    const { data } = await (await req('/api/template-packs?accountId=acc-1', { method: 'POST', body: JSON.stringify({ name: 'p', items: [] }) })).json<{ data: { id: string } }>();
    expect((await req(`/api/template-packs/${data.id}?accountId=acc-1`, { method: 'DELETE' })).status).toBe(200);
    expect(hoisted.packs.size).toBe(0);
  });

  test('nonexistent pack is 404 on GET/PATCH/DELETE', async () => {
    expect((await req('/api/template-packs/nope?accountId=acc-1')).status).toBe(404);
    expect((await req('/api/template-packs/nope?accountId=acc-1', { method: 'PATCH', body: JSON.stringify({ name: 'x' }) })).status).toBe(404);
    expect((await req('/api/template-packs/nope?accountId=acc-1', { method: 'DELETE' })).status).toBe(404);
  });
});

describe('template-packs 4-verb account-scope guard', () => {
  test('GET/PATCH/DELETE of another account pack is rejected 403', async () => {
    const { data } = await (await req('/api/template-packs?accountId=acc-1', { method: 'POST', body: JSON.stringify({ name: 'x', items: [] }) })).json<{ data: { id: string } }>();
    expect((await req(`/api/template-packs/${data.id}?accountId=acc-2`)).status).toBe(403);
    expect((await req(`/api/template-packs/${data.id}?accountId=acc-2`, { method: 'PATCH', body: JSON.stringify({ name: 'hijack' }) })).status).toBe(403);
    expect((await req(`/api/template-packs/${data.id}?accountId=acc-2`, { method: 'DELETE' })).status).toBe(403);
    expect(hoisted.packs.size).toBe(1);
  });

  test('missing accountId on a scoped row is rejected 403', async () => {
    const { data } = await (await req('/api/template-packs?accountId=acc-1', { method: 'POST', body: JSON.stringify({ name: 'x', items: [] }) })).json<{ data: { id: string } }>();
    expect((await req(`/api/template-packs/${data.id}`)).status).toBe(403);
  });
});

describe('template-packs send-zero', () => {
  test('no LINE Messaging API fetch across CRUD', async () => {
    const { data } = await (await req('/api/template-packs?accountId=acc-1', { method: 'POST', body: JSON.stringify({ name: 'p', items: [{ messageType: 'text', messageContent: 'A' }] }) })).json<{ data: { id: string } }>();
    await req(`/api/template-packs/${data.id}?accountId=acc-1`);
    await req(`/api/template-packs/${data.id}?accountId=acc-1`, { method: 'PATCH', body: JSON.stringify({ name: 'x' }) });
    await req(`/api/template-packs/${data.id}?accountId=acc-1`, { method: 'DELETE' });
    expect(hoisted.fetchCalls.filter((u) => /api\.line\.me|api-data\.line\.me/.test(u))).toEqual([]);
  });
});

describe('template-packs auth', () => {
  test('unauthenticated request is 401', async () => {
    expect((await setupApp().request('/api/template-packs?accountId=acc-1')).status).toBe(401);
  });
});
