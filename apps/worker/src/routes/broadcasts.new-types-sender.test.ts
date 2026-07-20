/**
 * T-C5 / A1-A4 / A8 / D-1 / D-4 — broadcasts の新 type 保存前検証 + sender (preset-id 参照) + test-send。
 *
 *  - POST/PUT が video/audio/imagemap/richvideo の URL/必須を https で検証し不正で 400
 *  - broadcasts は sender_preset_id のみ受理 (生 name/iconUrl は無視) / 別 account・不存在 id は 400
 *  - test-send は sender_preset_id → sender_presets(account-scoped) を解決して Message に付与し、
 *    test_recipients (自分/検証専用) のみに送り friends に送らない (LINE client mock で outbound を検証)
 */
import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

const dbMocks = {
  getBroadcasts: vi.fn(),
  getBroadcastById: vi.fn(),
  createBroadcast: vi.fn(),
  updateBroadcast: vi.fn(),
  deleteBroadcast: vi.fn(),
  getLineAccountById: vi.fn(),
  getSenderPresetById: vi.fn(),
  resolveSenderForBroadcast: vi.fn(),
};
vi.mock('@line-crm/db', () => dbMocks);

// LINE client を mock して outbound (pushMessage) を捕捉する。test-send 以外の send 系は呼ばれない。
const pushCalls: Array<{ to: string; messages: unknown[] }> = [];
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    constructor(public token: string) {}
    async pushMessage(to: string, messages: unknown[]) {
      pushCalls.push({ to, messages });
      return {};
    }
  },
}));

const { broadcasts } = await import('./broadcasts.js');

type TestEnv = { Bindings: { DB: D1Database; WORKER_URL: string } };

/** test-send の raw DB クエリ (test_recipients / friends / messages_log insert) に応答する stub。 */
function makeDbStub(cfg: {
  testRecipients?: string[];
  friends?: Array<{ id: string; line_user_id: string }>;
  account?: { channel_access_token: string; liff_id: string | null };
} = {}): D1Database {
  return {
    prepare: (sql: string) => ({
      bind: (..._args: unknown[]) => ({
        async first<T>() {
          if (sql.includes('FROM line_accounts') && sql.includes('is_active = 1')) {
            return (cfg.account ?? { channel_access_token: 'tok', liff_id: null }) as T;
          }
          if (sql.includes('test_recipients')) {
            return (cfg.testRecipients ? { value: JSON.stringify(cfg.testRecipients) } : null) as T;
          }
          return null as T;
        },
        async all<T>() {
          if (sql.includes('FROM friends')) {
            return { results: (cfg.friends ?? []) as T[] };
          }
          return { results: [] as T[] };
        },
        async run() { return { meta: { changes: 1 } }; },
      }),
    }),
    batch: async () => [],
  } as unknown as D1Database;
}

function setupApp(dbCfg: Parameters<typeof makeDbStub>[0] = {}) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.env = { DB: makeDbStub(dbCfg), WORKER_URL: 'https://worker.example.com' } as never;
    await next();
  });
  app.route('/', broadcasts);
  return app;
}

const validVideo = JSON.stringify({ originalContentUrl: 'https://cdn.example.com/v.mp4', previewImageUrl: 'https://cdn.example.com/p.png' });
const validAudio = JSON.stringify({ originalContentUrl: 'https://cdn.example.com/a.m4a', duration: 60000 });

beforeEach(() => {
  for (const fn of Object.values(dbMocks)) fn.mockReset();
  pushCalls.length = 0;
  dbMocks.createBroadcast.mockImplementation(async (_db, input) => ({
    id: 'b1', title: input.title, message_type: input.messageType, message_content: input.messageContent,
    target_type: input.targetType, status: 'draft', sender_preset_id: input.senderPresetId ?? null,
    created_at: '2026-07-04T00:00:00.000',
  }));
});

async function post(body: Record<string, unknown>) {
  return setupApp().request('/api/broadcasts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('T-C5 POST: new-type content validation (A1-A3)', () => {
  test('valid video is saved (201)', async () => {
    const res = await post({ title: 'V', messageType: 'video', messageContent: validVideo, targetType: 'all' });
    expect(res.status).toBe(201);
    expect(dbMocks.createBroadcast).toHaveBeenCalledOnce();
  });
  test('video with http (non-https) URL is 400 and not saved', async () => {
    const bad = JSON.stringify({ originalContentUrl: 'http://cdn/v.mp4', previewImageUrl: 'https://cdn/p.png' });
    const res = await post({ title: 'V', messageType: 'video', messageContent: bad, targetType: 'all' });
    expect(res.status).toBe(400);
    expect(dbMocks.createBroadcast).not.toHaveBeenCalled();
    const b = (await res.json()) as { error: string };
    expect(b.error).not.toMatch(/[a-zA-Z]{6,}/); // 日本語エラー (生英語専門語を出さない)
  });
  test('audio with non-positive duration is 400', async () => {
    const bad = JSON.stringify({ originalContentUrl: 'https://cdn/a.m4a', duration: 0 });
    const res = await post({ title: 'A', messageType: 'audio', messageContent: bad, targetType: 'all' });
    expect(res.status).toBe(400);
  });
  test('imagemap missing baseSize is 400', async () => {
    const bad = JSON.stringify({ baseUrl: 'https://cdn/im', actions: [] });
    const res = await post({ title: 'IM', messageType: 'imagemap', messageContent: bad, targetType: 'all' });
    expect(res.status).toBe(400);
  });
});

describe('T-C5 POST/PUT: sender preset-id only + account-scope (A4 / D-4)', () => {
  test('valid senderPresetId (own account) → 201, passed to createBroadcast', async () => {
    dbMocks.getSenderPresetById.mockResolvedValue({ id: 'sp-1', line_account_id: 'acc-1', name: '担当A', icon_url: null });
    const res = await post({ title: 'V', messageType: 'audio', messageContent: validAudio, targetType: 'all', lineAccountId: 'acc-1', senderPresetId: 'sp-1' });
    expect(res.status).toBe(201);
    expect(dbMocks.createBroadcast.mock.calls[0][1].senderPresetId).toBe('sp-1');
  });
  test('senderPresetId of another account / nonexistent → 400 (getSenderPresetById returns null)', async () => {
    dbMocks.getSenderPresetById.mockResolvedValue(null);
    const res = await post({ title: 'V', messageType: 'text', messageContent: 'hi', targetType: 'all', lineAccountId: 'acc-1', senderPresetId: 'sp-other' });
    expect(res.status).toBe(400);
    expect(dbMocks.createBroadcast).not.toHaveBeenCalled();
  });
  test('senderPresetId without lineAccountId → 400 (cannot account-scope)', async () => {
    const res = await post({ title: 'V', messageType: 'text', messageContent: 'hi', targetType: 'all', senderPresetId: 'sp-1' });
    expect(res.status).toBe(400);
  });
  test('raw sender name/iconUrl in body is IGNORED — never reaches createBroadcast', async () => {
    const res = await post({ title: 'V', messageType: 'text', messageContent: 'hi', targetType: 'all', sender: { name: 'なりすまし', iconUrl: 'https://evil/x.png' }, senderName: 'なりすまし' });
    expect(res.status).toBe(201);
    const input = dbMocks.createBroadcast.mock.calls[0][1] as Record<string, unknown>;
    expect(input.senderPresetId).toBeNull();
    expect(JSON.stringify(input)).not.toContain('なりすまし');
  });
});

describe('T-C5 test-send: resolves sender + sends only to test_recipients (A8 / D-1 / D-4)', () => {
  test('sender is resolved from preset and attached; push only to test recipients, no /send', async () => {
    dbMocks.getBroadcastById.mockResolvedValue({
      id: 'b1', title: 'V', message_type: 'video', message_content: validVideo, target_type: 'all',
      status: 'draft', line_account_id: 'acc-1', sender_preset_id: 'sp-1', created_at: '2026-07-04T00:00:00.000',
    });
    dbMocks.getLineAccountById.mockResolvedValue({ id: 'acc-1', channel_access_token: 'tok', is_active: 1 });
    dbMocks.resolveSenderForBroadcast.mockResolvedValue({ name: 'キャンペーン担当', iconUrl: 'https://cdn/i.png' });

    const app = setupApp({ testRecipients: ['f-self'], friends: [{ id: 'f-self', line_user_id: 'U-self' }] });
    const res = await app.request('/api/broadcasts/b1/test-send', { method: 'POST' });
    expect(res.status).toBe(200);
    // outbound は test_recipient の 1 件のみ (friends 全体には送らない)。
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0].to).toBe('U-self');
    // 送信 Message に解決済み sender が付与されている。
    const msg = pushCalls[0].messages[0] as { type: string; sender?: { name: string } };
    expect(msg.type).toBe('video');
    expect(msg.sender?.name).toBe('キャンペーン担当');
    // sender の解決は account-scoped 引数で呼ばれる (client の生 sender を使わない)。
    expect(dbMocks.resolveSenderForBroadcast).toHaveBeenCalledWith(expect.anything(), 'sp-1', 'acc-1');
  });
});
