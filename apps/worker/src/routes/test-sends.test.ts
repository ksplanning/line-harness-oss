import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const pushCalls = vi.hoisted(() => [] as Array<{ token: string; to: string; messages: unknown[] }>);
const rejectedPushUserIds = vi.hoisted(() => new Set<string>());
const ALLOWED_TEST_USER_ID = 'U5217ceb4debd9849959446ce8f902a27';
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    constructor(private readonly token: string) {}
    async pushMessage(to: string, messages: unknown[]) {
      pushCalls.push({ token: this.token, to, messages });
      if (rejectedPushUserIds.has(to)) throw new Error('LINE push rejected fixture');
      return {};
    }
  },
}));

const { testSends } = await import('./test-sends.js');

type TestEnv = {
  Bindings: {
    DB: D1Database;
    WORKER_URL: string;
    TEST_SEND_ALLOWED_USER_IDS?: string;
  };
};

function asD1(raw: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = raw.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...values: unknown[]) { params = values; return api; },
        async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
        async run() {
          const result = statement.run(...(params as never[]));
          return { meta: { changes: result.changes } };
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

function createApp(raw: Database.Database, allowedUserIds?: string) {
  const app = new Hono<TestEnv>();
  app.use('*', async (c, next) => {
    c.env = {
      DB: asD1(raw),
      WORKER_URL: 'https://worker.example.test',
      TEST_SEND_ALLOWED_USER_IDS: allowedUserIds,
    };
    await next();
  });
  app.route('/', testSends);
  return app;
}

let requestSequence = 0;
function post(
  app: ReturnType<typeof createApp>,
  body: unknown,
  idempotencyKey = `test-request-${++requestSequence}`,
  pathSource?: string,
) {
  const payload = body && typeof body === 'object' && !Array.isArray(body)
    ? { idempotencyKey, ...(body as Record<string, unknown>) }
    : body;
  const source = pathSource ?? (
    body && typeof body === 'object' && !Array.isArray(body)
      ? String((body as Record<string, unknown>).source ?? 'broadcast')
      : 'broadcast'
  );
  return app.request(`/api/test-sends/${source}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

let raw: Database.Database;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  pushCalls.length = 0;
  rejectedPushUserIds.clear();
  requestSequence = 0;
  raw = new Database(':memory:');
  raw.exec(`
    CREATE TABLE line_accounts (
      id TEXT PRIMARY KEY,
      channel_access_token TEXT NOT NULL,
      liff_id TEXT,
      monthly_cap INTEGER,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE friends (
      id TEXT PRIMARY KEY,
      line_user_id TEXT NOT NULL,
      display_name TEXT,
      picture_url TEXT,
      is_following INTEGER NOT NULL DEFAULT 1,
      line_account_id TEXT,
      user_id TEXT,
      ref_code TEXT,
      metadata TEXT
    );
    CREATE TABLE account_settings (
      id TEXT PRIMARY KEY,
      line_account_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      UNIQUE(line_account_id, key)
    );
    CREATE TABLE sender_presets (
      id TEXT PRIMARY KEY,
      line_account_id TEXT NOT NULL,
      name TEXT NOT NULL,
      icon_url TEXT
    );
    CREATE TABLE messages_log (
      id TEXT PRIMARY KEY,
      friend_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      message_type TEXT NOT NULL,
      content TEXT NOT NULL,
      broadcast_id TEXT,
      scenario_step_id TEXT,
      delivery_type TEXT,
      source TEXT,
      line_account_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE test_send_requests (
      idempotency_key TEXT PRIMARY KEY,
      line_account_id TEXT NOT NULL,
      source TEXT NOT NULL,
      request_payload TEXT NOT NULL,
      status TEXT NOT NULL,
      response_json TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
  `);
  raw.prepare(`INSERT INTO line_accounts (id, channel_access_token, liff_id, monthly_cap) VALUES (?, ?, ?, ?)`)
    .run('acc-1', 'token-1', 'liff-1', 10);
  raw.prepare(`INSERT INTO line_accounts (id, channel_access_token, liff_id, monthly_cap) VALUES (?, ?, ?, ?)`)
    .run('acc-2', 'token-2', 'liff-2', 10);
  raw.prepare(`INSERT INTO friends (id, line_user_id, display_name, is_following, line_account_id, ref_code) VALUES (?, ?, ?, 1, ?, ?)`)
    .run('test-friend', ALLOWED_TEST_USER_ID, 'テスター', 'acc-1', '紹介A');
  raw.prepare(`INSERT INTO friends (id, line_user_id, display_name, is_following, line_account_id) VALUES (?, ?, ?, 1, ?)`)
    .run('real-recipient', 'U-real', '本番受信者', 'acc-1');
  raw.prepare(`INSERT INTO friends (id, line_user_id, display_name, is_following, line_account_id) VALUES (?, ?, ?, 1, ?)`)
    .run('other-account', 'U-other', '別アカ', 'acc-2');
  app = createApp(raw);
});

function configure(friendIds: string[]) {
  raw.prepare(`INSERT INTO account_settings (id, line_account_id, key, value) VALUES ('setting-1', 'acc-1', 'test_recipients', ?)`)
    .run(JSON.stringify(friendIds));
}

describe('POST /api/test-sends', () => {
  test('source-scoped recipient read returns only the configured same-account friends', async () => {
    configure(['test-friend']);
    const res = await app.request('/api/test-sends/scenario/recipients?accountId=acc-1');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: [{ id: 'test-friend', displayName: 'テスター', pictureUrl: null }],
    });
  });

  test('recipient read rejects an unknown permission source without leaking settings', async () => {
    configure(['test-friend']);
    const res = await app.request('/api/test-sends/unknown/recipients?accountId=acc-1');
    expect(res.status).toBe(400);
  });

  test('builds outbound payload only from configured same-account friend IDs and renders that friend data', async () => {
    configure(['test-friend']);
    const res = await post(app, {
      accountId: 'acc-1',
      source: 'broadcast',
      messages: [{ type: 'text', content: 'こんにちは {{display_name}} / {{liff_id}} / {{ref}} {{#if_ref}}紹介あり{{/if_ref}}' }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      sent: 1,
      failed: 0,
      sentUserIds: [ALLOWED_TEST_USER_ID],
    });
    expect(pushCalls).toEqual([{
      token: 'token-1',
      to: ALLOWED_TEST_USER_ID,
      messages: [{ type: 'text', text: '【テスト配信】\nこんにちは テスター / liff-1 / 紹介A 紹介あり' }],
    }]);
    expect(pushCalls.some((call) => call.to === 'U-real')).toBe(false);

    const logs = raw.prepare(`SELECT friend_id, delivery_type, source, line_account_id, broadcast_id, scenario_step_id, content FROM messages_log`).all() as Array<Record<string, unknown>>;
    expect(logs).toEqual([expect.objectContaining({
      friend_id: 'test-friend',
      delivery_type: 'test',
      source: 'test',
      line_account_id: 'acc-1',
      broadcast_id: null,
      scenario_step_id: null,
      content: '【テスト配信】\nこんにちは テスター / liff-1 / 紹介A 紹介あり',
    })]);
    const storedResult = raw.prepare(`SELECT response_json FROM test_send_requests`).get() as { response_json: string };
    expect(JSON.parse(storedResult.response_json)).toEqual({
      sent: 1,
      failed: 0,
      sentUserIds: [ALLOWED_TEST_USER_ID],
    });
  });

  test('rejects the whole request when a mistaken setting includes a same-account user outside the server allowlist', async () => {
    configure(['test-friend', 'real-recipient']);
    const res = await post(app, {
      accountId: 'acc-1',
      source: 'template_pack',
      messages: [{ type: 'sticker', content: JSON.stringify({ packageId: '1', stickerId: '1' }) }],
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      success: false,
      error: 'テスト送信先にサーバー許可リスト外のuserIdが含まれています: U-real',
    });
    expect(pushCalls).toEqual([]);
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM messages_log`).get()).toEqual({ count: 0 });
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM test_send_requests`).get()).toEqual({ count: 0 });
  });

  test('allows multiple configured recipients only when every userId is in the deployment allowlist', async () => {
    app = createApp(raw, `${ALLOWED_TEST_USER_ID}, U-real`);
    configure(['test-friend', 'real-recipient']);
    const res = await post(app, {
      accountId: 'acc-1',
      source: 'broadcast',
      messages: [{ type: 'text', content: '複数の安全な送信先' }],
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      sent: 2,
      failed: 0,
      sentUserIds: [ALLOWED_TEST_USER_ID, 'U-real'],
    });
    expect(pushCalls.map((call) => call.to)).toEqual([ALLOWED_TEST_USER_ID, 'U-real']);
  });

  test('returns only the userIds whose LINE pushes actually succeeded', async () => {
    app = createApp(raw, `${ALLOWED_TEST_USER_ID}, U-real`);
    configure(['test-friend', 'real-recipient']);
    rejectedPushUserIds.add('U-real');

    const res = await post(app, {
      accountId: 'acc-1',
      source: 'broadcast',
      messages: [{ type: 'text', content: '部分失敗の宛先確認' }],
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      sent: 1,
      failed: 1,
      sentUserIds: [ALLOWED_TEST_USER_ID],
    });
    expect(raw.prepare(`SELECT friend_id FROM messages_log`).all()).toEqual([{ friend_id: 'test-friend' }]);
  });

  test('an explicitly empty deployment allowlist fails closed before any LINE push', async () => {
    app = createApp(raw, '');
    configure(['test-friend']);

    const res = await post(app, {
      accountId: 'acc-1',
      source: 'broadcast',
      messages: [{ type: 'text', content: '空の許可リストでは送らない' }],
    });

    expect(res.status).toBe(400);
    expect(pushCalls).toEqual([]);
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM test_send_requests`).get()).toEqual({ count: 0 });
  });

  test('filters a cross-account configured friend and sends nothing', async () => {
    configure(['other-account']);
    const res = await post(app, {
      accountId: 'acc-1',
      source: 'scenario',
      messages: [{ type: 'text', content: '安全確認' }],
    });
    expect(res.status).toBe(400);
    expect(pushCalls).toEqual([]);
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM messages_log`).get()).toEqual({ count: 0 });
  });

  test('fails closed when a corrupted setting mixes a valid friend with a cross-account friend', async () => {
    configure(['test-friend', 'other-account']);
    const res = await post(app, {
      accountId: 'acc-1',
      source: 'broadcast',
      messages: [{ type: 'text', content: '部分送信しない' }],
    });
    expect(res.status).toBe(400);
    expect(pushCalls).toEqual([]);
  });

  test('sends a combo/template pack as one ordered push with up to five bubbles', async () => {
    configure(['test-friend']);
    const res = await post(app, {
      accountId: 'acc-1',
      source: 'template_pack',
      messages: [
        { type: 'text', content: '1通目' },
        { type: 'image', content: JSON.stringify({ originalContentUrl: 'https://cdn.test/original.png', previewImageUrl: 'https://cdn.test/preview.png' }) },
      ],
    });
    expect(res.status).toBe(200);
    expect(pushCalls[0].messages).toEqual([
      { type: 'text', text: '【テスト配信】\n1通目' },
      { type: 'image', originalContentUrl: 'https://cdn.test/original.png', previewImageUrl: 'https://cdn.test/preview.png' },
    ]);
  });

  test('broadcast sender is resolved server-side from an account-scoped preset id', async () => {
    configure(['test-friend']);
    raw.prepare(`INSERT INTO sender_presets (id, line_account_id, name, icon_url) VALUES (?, ?, ?, ?)`)
      .run('preset-1', 'acc-1', 'テスト担当', 'https://cdn.test/icon.png');
    const res = await post(app, {
      accountId: 'acc-1',
      source: 'broadcast',
      senderPresetId: 'preset-1',
      messages: [{ type: 'text', content: '送信者確認' }],
    });
    expect(res.status).toBe(200);
    expect(pushCalls[0].messages).toEqual([expect.objectContaining({
      type: 'text',
      sender: { name: 'テスト担当', iconUrl: 'https://cdn.test/icon.png' },
    })]);
  });

  test('a sender preset from another account fails closed before LINE push', async () => {
    configure(['test-friend']);
    raw.prepare(`INSERT INTO sender_presets (id, line_account_id, name, icon_url) VALUES (?, ?, ?, NULL)`)
      .run('preset-other', 'acc-2', '別アカ担当');
    const res = await post(app, {
      accountId: 'acc-1',
      source: 'broadcast',
      senderPresetId: 'preset-other',
      messages: [{ type: 'text', content: '送らない' }],
    });
    expect(res.status).toBe(400);
    expect(pushCalls).toEqual([]);
  });

  test('monthly cap includes test sends and blocks before any LINE call', async () => {
    configure(['test-friend']);
    raw.prepare(`UPDATE line_accounts SET monthly_cap = 0 WHERE id = 'acc-1'`).run();
    const res = await post(app, {
      accountId: 'acc-1',
      source: 'reminder',
      messages: [{ type: 'text', content: '上限確認' }],
    });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual(expect.objectContaining({ success: false, capBlocked: true }));
    expect(pushCalls).toEqual([]);
  });

  test('the same idempotency key never performs a second LINE push', async () => {
    configure(['test-friend']);
    const body = {
      accountId: 'acc-1',
      source: 'broadcast',
      messages: [{ type: 'text', content: '連打防止' }],
    };
    const first = await post(app, body, 'same-operation-key');
    const second = await post(app, body, 'same-operation-key');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(expect.objectContaining({
      success: true,
      deduplicated: true,
      sentUserIds: [ALLOWED_TEST_USER_ID],
    }));
    expect(pushCalls).toHaveLength(1);
    expect(raw.prepare(`SELECT COUNT(*) AS count FROM messages_log`).get()).toEqual({ count: 1 });
  });

  test('a completed replay returns its cached result even if the cap changed afterward', async () => {
    configure(['test-friend']);
    const body = {
      accountId: 'acc-1',
      source: 'broadcast',
      messages: [{ type: 'text', content: '完了済みは再送しない' }],
    };
    expect((await post(app, body, 'completed-before-cap')).status).toBe(200);
    raw.prepare(`UPDATE line_accounts SET monthly_cap = 0 WHERE id = 'acc-1'`).run();

    const replay = await post(app, body, 'completed-before-cap');
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(expect.objectContaining({ deduplicated: true }));
    expect(pushCalls).toHaveLength(1);
  });

  test('reusing an idempotency key for different content is rejected', async () => {
    configure(['test-friend']);
    const common = { accountId: 'acc-1', source: 'broadcast' };
    expect((await post(app, { ...common, messages: [{ type: 'text', content: 'A' }] }, 'reused-key')).status).toBe(200);
    expect((await post(app, { ...common, messages: [{ type: 'text', content: 'B' }] }, 'reused-key')).status).toBe(409);
    expect(pushCalls).toHaveLength(1);
  });

  test('rejects a body source that does not match the permission-scoped route', async () => {
    configure(['test-friend']);
    const res = await post(app, {
      accountId: 'acc-1',
      source: 'scenario',
      messages: [{ type: 'text', content: '権限境界' }],
    }, 'mismatched-source-key', 'broadcast');
    expect(res.status).toBe(400);
    expect(pushCalls).toEqual([]);
  });

  test.each([
    { accountId: 'acc-1', source: 'broadcast', messages: [] },
    { accountId: 'acc-1', source: 'broadcast', messages: Array.from({ length: 6 }, () => ({ type: 'text', content: 'x' })) },
    { accountId: 'acc-1', source: 'unknown', messages: [{ type: 'text', content: 'x' }] },
    { accountId: 'acc-1', source: 'broadcast', messages: [{ type: 'text', content: '' }] },
    { accountId: 'acc-1', source: 'broadcast', messages: [{ type: 'image', content: '{broken-json' }] },
  ])('rejects an unsafe payload without sending: %j', async (body) => {
    configure(['test-friend']);
    expect((await post(app, body)).status).toBe(400);
    expect(pushCalls).toEqual([]);
  });
});
