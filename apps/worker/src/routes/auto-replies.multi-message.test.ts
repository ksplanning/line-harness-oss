import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const state = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
  createInput: null as null | Record<string, unknown>,
  updateInput: null as null | Record<string, unknown>,
}));

vi.mock('@line-crm/db', () => ({
  getAutoReplies: vi.fn(async () => []),
  getAutoReplyById: vi.fn(async () => state.row),
  createAutoReply: vi.fn(async (_db: unknown, input: Record<string, unknown>) => {
    state.createInput = input;
    state.row = {
      id: 'rule-1',
      keyword: input.keyword,
      match_type: input.matchType ?? 'exact',
      response_type: input.responseType ?? 'text',
      response_content: input.responseContent ?? '',
      response_messages: input.responseMessages ? JSON.stringify(input.responseMessages) : null,
      template_id: input.templateId ?? null,
      line_account_id: input.lineAccountId ?? null,
      is_active: 1,
      created_at: '2026-07-21T00:00:00+09:00',
    };
    return state.row;
  }),
  updateAutoReply: vi.fn(async (_db: unknown, _id: string, input: Record<string, unknown>) => {
    state.updateInput = input;
    return state.row;
  }),
  deleteAutoReply: vi.fn(async () => undefined),
  getTemplateById: vi.fn(async () => null),
}));

import { autoReplies } from './auto-replies.js';

const db = {
  prepare() {
    const statement = {
      bind() { return statement; },
      async all() { return { results: [] }; },
    };
    return statement;
  },
} as unknown as D1Database;

function app() {
  const instance = new Hono();
  instance.route('/', autoReplies);
  return instance;
}

function request(path: string, init?: RequestInit) {
  return app().request(path, init, { DB: db } as never);
}

const responseMessages = [
  { messageType: 'text', messageContent: 'A' },
  { messageType: 'flex', messageContent: '{"type":"bubble","body":{"type":"box","layout":"vertical","contents":[{"type":"text","text":"Flex"}]}}' },
  { messageType: 'text', messageContent: 'B' },
];

const mediaResponseMessages = [
  { messageType: 'image', messageContent: JSON.stringify({ originalContentUrl: 'https://cdn.example.com/o.png', previewImageUrl: 'https://cdn.example.com/p.png' }) },
  { messageType: 'video', messageContent: JSON.stringify({ originalContentUrl: 'https://cdn.example.com/v.mp4', previewImageUrl: 'https://cdn.example.com/v.png' }) },
  { messageType: 'audio', messageContent: JSON.stringify({ originalContentUrl: 'https://cdn.example.com/a.m4a', duration: 60_000 }) },
  { messageType: 'sticker', messageContent: JSON.stringify({ packageId: '11537', stickerId: '52002734' }) },
  { messageType: 'imagemap', messageContent: JSON.stringify({
    baseUrl: 'https://cdn.example.com/imagemap',
    altText: '画像分割',
    baseSize: { width: 1040, height: 1040 },
    actions: [{ type: 'uri', linkUri: 'https://example.com', area: { x: 0, y: 0, width: 1040, height: 1040 } }],
  }) },
];

const flexRejectedBySavePolicy = JSON.stringify({
  type: 'bubble',
  body: {
    type: 'box',
    layout: 'vertical',
    contents: [{
      type: 'button',
      action: { type: 'uri', label: 'LINEを開く', uri: 'line://nv/location' },
    }],
  },
});

beforeEach(() => {
  state.row = null;
  state.createInput = null;
  state.updateInput = null;
});

describe('auto-replies API responseMessages contract', () => {
  test('POST saves and returns an ordered multi-bubble response', async () => {
    const result = await request('/api/auto-replies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: '資料', responseMessages }),
    });
    const body = await result.json<{ data: { responseMessages: unknown[] } }>();

    expect(result.status).toBe(201);
    expect(state.createInput?.responseMessages).toEqual(responseMessages);
    expect(body.data.responseMessages).toEqual(responseMessages);
  });

  test('POST accepts a five-item media/sticker pack for the shared auto-reply renderer without rewriting bytes', async () => {
    const result = await request('/api/auto-replies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: 'メディア', responseMessages: mediaResponseMessages }),
    });
    const body = await result.json<{ data?: { responseMessages: unknown[] }; error?: string }>();

    expect(result.status, body.error).toBe(201);
    expect(state.createInput?.responseMessages).toEqual(mediaResponseMessages);
    expect(body.data?.responseMessages).toEqual(mediaResponseMessages);
  });

  test('POST rejects an empty response and more than five bubbles with an honest 400', async () => {
    for (const messages of [[], Array.from({ length: 6 }, (_, i) => ({ messageType: 'text', messageContent: `${i}` }))]) {
      const result = await request('/api/auto-replies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyword: '上限', responseMessages: messages }),
      });
      expect(result.status).toBe(400);
      expect((await result.json<{ error: string }>()).error).toMatch(/1.*5|最大5/);
    }
    expect(state.createInput).toBeNull();
  });

  test.each([
    { responseMessages: [{ messageType: 'flex', messageContent: flexRejectedBySavePolicy }] },
    { responseType: 'flex', responseContent: flexRejectedBySavePolicy },
  ])('POST keeps Flex URI policy in every persistence shape', async (response) => {
    const result = await request('/api/auto-replies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: '保存ポリシー', ...response }),
    });

    expect(result.status).toBe(400);
    expect(state.createInput).toBeNull();
  });

  test('GET upgrades a legacy single-response fixture without changing its stored fields', async () => {
    state.row = {
      id: 'legacy',
      keyword: '営業時間',
      match_type: 'exact',
      response_type: 'text',
      response_content: '10時からです',
      response_messages: null,
      template_id: null,
      line_account_id: null,
      is_active: 1,
      created_at: '2026-07-21T00:00:00+09:00',
    };

    const result = await request('/api/auto-replies/legacy');
    const body = await result.json<{ data: { responseMessages: unknown[]; responseContent: string } }>();

    expect(body.data.responseMessages).toEqual([{ messageType: 'text', messageContent: '10時からです' }]);
    expect(body.data.responseContent).toBe('10時からです');
  });

  test('GET keeps a legacy parseable-but-now-invalid Flex row readable so the UI can repair it', async () => {
    const legacyMessages = [{ messageType: 'flex', messageContent: '{}' }];
    state.row = {
      id: 'legacy-flex',
      keyword: '旧Flex',
      match_type: 'exact',
      response_type: 'flex',
      response_content: '{}',
      response_messages: JSON.stringify(legacyMessages),
      template_id: null,
      line_account_id: null,
      is_active: 1,
      created_at: '2026-07-21T00:00:00+09:00',
    };

    const result = await request('/api/auto-replies/legacy-flex');
    const body = await result.json<{ data?: { responseMessages: unknown[] } }>();
    expect(result.status).toBe(200);
    expect(body.data?.responseMessages).toEqual(legacyMessages);
  });

  test('PUT validates and forwards five bubbles', async () => {
    state.row = {
      id: 'rule-1', keyword: '資料', match_type: 'exact', response_type: 'text', response_content: 'A',
      response_messages: null, template_id: null, line_account_id: null, is_active: 1, created_at: 'now',
    };
    const five = Array.from({ length: 5 }, (_, i) => ({ messageType: 'text', messageContent: `${i + 1}` }));

    const result = await request('/api/auto-replies/rule-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ responseMessages: five }),
    });

    expect(result.status).toBe(200);
    expect(state.updateInput?.responseMessages).toEqual(five);
  });

  test('legacy POST validates responseType/responseContent through the shared renderer', async () => {
    const result = await request('/api/auto-replies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: '壊れたスタンプ', responseType: 'sticker', responseContent: '{broken' }),
    });

    expect(result.status).toBe(400);
    expect(state.createInput).toBeNull();
  });

  test('legacy PUT validates the resulting single response through the shared renderer', async () => {
    state.row = {
      id: 'rule-1', keyword: '資料', match_type: 'exact', response_type: 'text', response_content: 'A',
      response_messages: null, template_id: null, line_account_id: null, is_active: 1, created_at: 'now',
    };
    const result = await request('/api/auto-replies/rule-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ responseType: 'sticker', responseContent: '{broken' }),
    });

    expect(result.status).toBe(400);
    expect(state.updateInput).toBeNull();
  });
});
