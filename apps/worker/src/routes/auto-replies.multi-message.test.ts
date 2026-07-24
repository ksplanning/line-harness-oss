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
      on_reply_actions_json: input.onReplyActionsJson ?? null,
      template_id: input.templateId ?? null,
      line_account_id: input.lineAccountId ?? null,
      keep_in_unresponded: input.keepInUnresponded ? 1 : 0,
      is_active: 1,
      created_at: '2026-07-21T00:00:00+09:00',
    };
    return state.row;
  }),
  updateAutoReply: vi.fn(async (_db: unknown, _id: string, input: Record<string, unknown>) => {
    state.updateInput = input;
    if (state.row && Object.prototype.hasOwnProperty.call(input, 'onReplyActionsJson')) {
      state.row = {
        ...state.row,
        on_reply_actions_json: input.onReplyActionsJson,
      };
    }
    return state.row;
  }),
  deleteAutoReply: vi.fn(async () => undefined),
  getTemplateById: vi.fn(async () => null),
  addTagToFriend: vi.fn(),
  removeTagFromFriend: vi.fn(),
  getFriendFieldDefinition: vi.fn(),
  mergeFriendMetadata: vi.fn(),
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

const replyActions = [
  { type: 'add_tag', tagId: 'tag-new' },
  { type: 'remove_tag', tagId: 'tag-old' },
  { type: 'set_field', fieldId: 'field-status', value: '済' },
  { type: 'clear_field', fieldId: 'field-note' },
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
  test('POST saves and returns ordered replyActions through the P1 action contract', async () => {
    const result = await request('/api/auto-replies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keyword: '申込',
        responseType: 'text',
        responseContent: '受け付けました',
        replyActions,
      }),
    });
    const body = await result.json<{ data: { replyActions: unknown[] } }>();

    expect(result.status).toBe(201);
    expect(JSON.parse(String(state.createInput?.onReplyActionsJson))).toEqual(replyActions);
    expect(body.data.replyActions).toEqual(replyActions);
  });

  test('PUT round-trips explicit [] while an omitted replyActions key stays omitted', async () => {
    state.row = {
      id: 'rule-1', keyword: '申込', match_type: 'exact', response_type: 'text', response_content: '受け付けました',
      response_messages: null, on_reply_actions_json: JSON.stringify(replyActions), template_id: null,
      line_account_id: null, keep_in_unresponded: 0, is_active: 1, created_at: 'now',
    };

    const unrelated = await request('/api/auto-replies/rule-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: '申込完了' }),
    });
    expect(unrelated.status).toBe(200);
    expect(state.updateInput).not.toHaveProperty('onReplyActionsJson');

    const cleared = await request('/api/auto-replies/rule-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ replyActions: [] }),
    });
    const body = await cleared.json<{ data: { replyActions: unknown[] } }>();

    expect(cleared.status).toBe(200);
    expect(state.updateInput?.onReplyActionsJson).toBe('[]');
    expect(body.data.replyActions).toEqual([]);
  });

  test('legacy NULL returns [] and invalid replyActions never reaches persistence', async () => {
    state.row = {
      id: 'legacy', keyword: '従来', match_type: 'exact', response_type: 'text', response_content: '従来本文',
      response_messages: null, on_reply_actions_json: null, template_id: null,
      line_account_id: null, keep_in_unresponded: 0, is_active: 1, created_at: 'now',
    };
    const legacy = await request('/api/auto-replies/legacy');
    expect((await legacy.json<{ data: { replyActions: unknown[] } }>()).data.replyActions).toEqual([]);

    for (const invalid of [
      {},
      [{ type: 'add_tag', tagId: '' }],
      [{ type: 'set_field', fieldId: 'field-status' }],
      [{ type: 'unknown' }],
    ]) {
      state.createInput = null;
      const result = await request('/api/auto-replies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keyword: '不正',
          responseType: 'text',
          responseContent: '本文',
          replyActions: invalid,
        }),
      });
      expect(result.status).toBe(400);
      expect(state.createInput).toBeNull();
    }
  });

  test('POST forwards and serializes keepInUnresponded opt-in', async () => {
    const result = await request('/api/auto-replies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        keyword: '問い合わせ',
        responseType: 'text',
        responseContent: '確認します',
        keepInUnresponded: true,
      }),
    });
    const body = await result.json<{ data: { keepInUnresponded: boolean } }>();

    expect(result.status).toBe(201);
    expect(state.createInput?.keepInUnresponded).toBe(true);
    expect(body.data.keepInUnresponded).toBe(true);
  });

  test('PUT forwards an explicit keepInUnresponded change', async () => {
    state.row = {
      id: 'rule-1', keyword: '問い合わせ', match_type: 'exact', response_type: 'text', response_content: '確認します',
      response_messages: null, template_id: null, line_account_id: null, keep_in_unresponded: 0, is_active: 1, created_at: 'now',
    };

    const result = await request('/api/auto-replies/rule-1', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keepInUnresponded: true }),
    });

    expect(result.status).toBe(200);
    expect(state.updateInput?.keepInUnresponded).toBe(true);
  });

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
