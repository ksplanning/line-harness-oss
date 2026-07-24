import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  createStaffNotificationDestination: vi.fn(),
  deleteStaffNotificationDestination: vi.fn(),
  getStaffNotificationDestination: vi.fn(),
  issueStaffNotificationLineLinkCode: vi.fn(),
  listStaffNotificationDestinations: vi.fn(),
  toJstString: vi.fn(),
  unlinkStaffNotificationLine: vi.fn(),
  updateStaffNotificationDestination: vi.fn(),
}));

const notifyMocks = vi.hoisted(() => ({
  sendStaffNotificationTest: vi.fn(),
}));

const linkMocks = vi.hoisted(() => ({
  digestStaffLineLinkCode: vi.fn(),
}));

vi.mock('@line-crm/db', () => dbMocks);
vi.mock('../services/staff-notify/router.js', () => notifyMocks);
vi.mock('../services/staff-notify/line-link.js', () => linkMocks);

import { staffNotificationDestinations } from './staff-notification-destinations.js';

type Destination = {
  id: string;
  lineAccountId: string;
  label: string;
  channelType: string;
  config: Record<string, unknown>;
  notifyInquiry: boolean;
  notifyFormSubmission: boolean;
  notifyAutoReply: boolean;
  enabled: boolean;
  lineUserId: string | null;
  lineLinkCodeDigest: string | null;
  lineLinkCodeExpiresAt: string | null;
  lineLinkedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const NOW = '2026-07-23T10:00:00.000+09:00';
const EXPIRES_AT = '2026-07-23T10:10:00.000+09:00';

let rows: Destination[];
let app: Hono;

function destination(overrides: Partial<Destination> = {}): Destination {
  return {
    id: 'destination-1',
    lineAccountId: 'account-1',
    label: '受付通知',
    channelType: 'chatwork',
    config: { roomId: '12345', apiToken: 'chatwork-secret' },
    notifyInquiry: true,
    notifyFormSubmission: false,
    notifyAutoReply: false,
    enabled: true,
    lineUserId: null,
    lineLinkCodeDigest: null,
    lineLinkCodeExpiresAt: null,
    lineLinkedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function jsonRequest(path: string, method: string, body?: unknown): Promise<Response> {
  return app.request(
    `https://worker.example.test${path}`,
    {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    {
      DB: {} as D1Database,
      ADMIN_PUBLIC_URL: 'https://admin.example.test',
      WORKER_URL: 'https://worker.example.test',
    },
  );
}

function chatworkBody(overrides: Record<string, unknown> = {}) {
  const {
    roomId = '12345',
    apiToken = 'chatwork-secret',
    inquiryRoomId,
    formSubmissionRoomId,
    autoReplyRoomId,
    ...destinationOverrides
  } = overrides;
  const config: Record<string, unknown> = { roomId, apiToken };
  if (inquiryRoomId !== undefined) config.inquiryRoomId = inquiryRoomId;
  if (formSubmissionRoomId !== undefined) {
    config.formSubmissionRoomId = formSubmissionRoomId;
  }
  if (autoReplyRoomId !== undefined) config.autoReplyRoomId = autoReplyRoomId;
  return {
    lineAccountId: 'account-1',
    label: 'Chatwork 受付',
    channelType: 'chatwork',
    notifyInquiry: true,
    notifyFormSubmission: false,
    notifyAutoReply: false,
    enabled: true,
    config,
    ...destinationOverrides,
  };
}

function lineBody(overrides: Record<string, unknown> = {}) {
  return {
    lineAccountId: 'account-1',
    label: 'LINE 受付',
    channelType: 'line',
    notifyInquiry: true,
    notifyFormSubmission: true,
    notifyAutoReply: false,
    enabled: true,
    config: {},
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  app = new Hono();
  app.route('/', staffNotificationDestinations);

  dbMocks.toJstString.mockReturnValue(EXPIRES_AT);
  linkMocks.digestStaffLineLinkCode.mockImplementation(async (code: string) => `digest:${code}`);
  notifyMocks.sendStaffNotificationTest.mockResolvedValue({
    destinationId: 'destination-1',
    status: 'success',
    errorCode: null,
  });

  dbMocks.createStaffNotificationDestination.mockImplementation(async (_db, input) => {
    const created = destination({
      ...input,
      lineUserId: null,
      lineLinkCodeDigest: null,
      lineLinkCodeExpiresAt: null,
      lineLinkedAt: null,
    });
    rows.push(created);
    return created;
  });
  dbMocks.getStaffNotificationDestination.mockImplementation(
    async (_db, lineAccountId: string, id: string) =>
      rows.find((row) => row.lineAccountId === lineAccountId && row.id === id) ?? null,
  );
  dbMocks.listStaffNotificationDestinations.mockImplementation(
    async (_db, lineAccountId: string) =>
      rows.filter((row) => row.lineAccountId === lineAccountId),
  );
  dbMocks.updateStaffNotificationDestination.mockImplementation(async (_db, input) => {
    const index = rows.findIndex((row) =>
      row.lineAccountId === input.lineAccountId
      && row.id === input.id
      && row.channelType === input.channelType);
    if (index < 0) return null;
    rows[index] = {
      ...rows[index],
      label: input.label,
      config: input.config,
      notifyInquiry: input.notifyInquiry,
      notifyFormSubmission: input.notifyFormSubmission,
      notifyAutoReply: input.notifyAutoReply,
      enabled: input.enabled,
      updatedAt: NOW,
    };
    return rows[index];
  });
  dbMocks.deleteStaffNotificationDestination.mockImplementation(
    async (_db, lineAccountId: string, id: string) => {
      const index = rows.findIndex((row) =>
        row.lineAccountId === lineAccountId && row.id === id);
      if (index < 0) return false;
      rows.splice(index, 1);
      return true;
    },
  );
  dbMocks.issueStaffNotificationLineLinkCode.mockImplementation(async (_db, input) => {
    const row = rows.find((candidate) =>
      candidate.lineAccountId === input.lineAccountId
      && candidate.id === input.id
      && candidate.channelType === 'line');
    if (!row) return null;
    row.lineLinkCodeDigest = input.codeDigest;
    row.lineLinkCodeExpiresAt = input.expiresAt;
    return row;
  });
  dbMocks.unlinkStaffNotificationLine.mockImplementation(
    async (_db, lineAccountId: string, id: string) => {
      const row = rows.find((candidate) =>
        candidate.lineAccountId === lineAccountId
        && candidate.id === id
        && candidate.channelType === 'line');
      if (!row) return null;
      row.lineUserId = null;
      row.lineLinkedAt = null;
      row.lineLinkCodeDigest = null;
      row.lineLinkCodeExpiresAt = null;
      return row;
    },
  );
});

describe('staff notification destination admin CRUD', () => {
  test('worker本体へ管理routeがmountされている', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(source).toContain(
      "import { staffNotificationDestinations } from './routes/staff-notification-destinations.js';",
    );
    expect(source).toContain("app.route('/', staffNotificationDestinations);");
  });

  test('Chatwork設定を作成・一覧・更新・削除でき、生tokenを一度も返さない', async () => {
    const created = await jsonRequest(
      '/api/staff-notification-destinations',
      'POST',
      chatworkBody(),
    );
    expect(created.status).toBe(201);
    const createdText = await created.text();
    expect(createdText).not.toContain('chatwork-secret');
    expect(JSON.parse(createdText)).toMatchObject({
      success: true,
      data: {
        label: 'Chatwork 受付',
        channelType: 'chatwork',
        notifyInquiry: true,
        notifyFormSubmission: false,
        notifyAutoReply: false,
        enabled: true,
        config: {
          roomId: '12345',
          apiToken: '********',
        },
        unsupported: false,
        setupState: null,
      },
    });
    expect(JSON.parse(createdText).data).not.toHaveProperty('lineAccountId');

    const listed = await jsonRequest(
      '/api/staff-notification-destinations?lineAccountId=account-1',
      'GET',
    );
    const listedText = await listed.text();
    expect(listed.status).toBe(200);
    expect(listedText).not.toContain('chatwork-secret');
    expect(JSON.parse(listedText).data).toHaveLength(1);

    const updated = await jsonRequest(
      `/api/staff-notification-destinations/${rows[0].id}`,
      'PUT',
      chatworkBody({
        label: '申込み担当',
        notifyInquiry: false,
        notifyFormSubmission: true,
        notifyAutoReply: true,
        apiToken: '',
      }),
    );
    expect(updated.status).toBe(200);
    expect((await updated.clone().json()).data.notifyAutoReply).toBe(true);
    expect(rows[0].notifyAutoReply).toBe(true);
    expect(rows[0].config).toEqual({
      roomId: '12345',
      apiToken: 'chatwork-secret',
    });
    expect(await updated.text()).not.toContain('chatwork-secret');

    const maskRoundTrip = await jsonRequest(
      `/api/staff-notification-destinations/${rows[0].id}`,
      'PUT',
      chatworkBody({ apiToken: '********' }),
    );
    expect(maskRoundTrip.status).toBe(200);
    expect(rows[0].config.apiToken).toBe('chatwork-secret');

    const omittedToken = await jsonRequest(
      `/api/staff-notification-destinations/${rows[0].id}`,
      'PUT',
      chatworkBody({ apiToken: undefined }),
    );
    expect(omittedToken.status).toBe(200);
    expect(rows[0].config.apiToken).toBe('chatwork-secret');

    const removed = await jsonRequest(
      `/api/staff-notification-destinations/${rows[0].id}?lineAccountId=account-1`,
      'DELETE',
    );
    expect(removed.status).toBe(200);
    expect(rows).toEqual([]);
  });

  test('カテゴリ別ルームIDを保存・再取得でき、LINEアカウントA/Bで分離する', async () => {
    const accountA = await jsonRequest(
      '/api/staff-notification-destinations',
      'POST',
      chatworkBody({
        lineAccountId: 'account-a',
        label: 'A受付',
        inquiryRoomId: '111111',
        formSubmissionRoomId: '122222',
        autoReplyRoomId: '',
      }),
    );
    const accountB = await jsonRequest(
      '/api/staff-notification-destinations',
      'POST',
      chatworkBody({
        lineAccountId: 'account-b',
        label: 'B受付',
        roomId: '200000',
        inquiryRoomId: '211111',
        formSubmissionRoomId: '',
        autoReplyRoomId: '233333',
      }),
    );
    expect(accountA.status).toBe(201);
    expect(accountB.status).toBe(201);

    const listedA = await jsonRequest(
      '/api/staff-notification-destinations?lineAccountId=account-a',
      'GET',
    );
    const listedB = await jsonRequest(
      '/api/staff-notification-destinations?lineAccountId=account-b',
      'GET',
    );
    expect((await listedA.json()).data).toEqual([
      expect.objectContaining({
        label: 'A受付',
        config: {
          roomId: '12345',
          apiToken: '********',
          inquiryRoomId: '111111',
          formSubmissionRoomId: '122222',
          autoReplyRoomId: '',
        },
      }),
    ]);
    expect((await listedB.json()).data).toEqual([
      expect.objectContaining({
        label: 'B受付',
        config: {
          roomId: '200000',
          apiToken: '********',
          inquiryRoomId: '211111',
          formSubmissionRoomId: '',
          autoReplyRoomId: '233333',
        },
      }),
    ]);
    expect(rows.find((row) => row.lineAccountId === 'account-a')?.config)
      .toMatchObject({
        inquiryRoomId: '111111',
        formSubmissionRoomId: '122222',
      });
    expect(rows.find((row) => row.lineAccountId === 'account-b')?.config)
      .toMatchObject({
        inquiryRoomId: '211111',
        autoReplyRoomId: '233333',
      });
  });

  test.each([
    'inquiryRoomId',
    'formSubmissionRoomId',
    'autoReplyRoomId',
  ])('%s が数字以外なら日本語エラーで400を返す', async (key) => {
    const response = await jsonRequest(
      '/api/staff-notification-destinations',
      'POST',
      chatworkBody({ [key]: '12A34' }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: 'カテゴリ別ルームIDは半角数字のみで入力してください。',
    });

    rows.push(destination());
    const updateResponse = await jsonRequest(
      '/api/staff-notification-destinations/destination-1',
      'PUT',
      chatworkBody({ [key]: '12A34' }),
    );
    expect(updateResponse.status).toBe(400);
    expect(await updateResponse.json()).toEqual({
      success: false,
      error: 'カテゴリ別ルームIDは半角数字のみで入力してください。',
    });
  });

  test('入力を厳格検証し、channel変更と別accountからの操作を拒否する', async () => {
    for (const body of [
      chatworkBody({ lineAccountId: '' }),
      chatworkBody({ label: ' ' }),
      chatworkBody({ channelType: 'slack' }),
      chatworkBody({ channelType: 'constructor' }),
      chatworkBody({ channelType: 'toString' }),
      chatworkBody({ notifyInquiry: 1 }),
      chatworkBody({ notifyAutoReply: 1 }),
      chatworkBody({ roomId: 'not-a-room' }),
      chatworkBody({ apiToken: '' }),
    ]) {
      const response = await jsonRequest(
        '/api/staff-notification-destinations',
        'POST',
        body,
      );
      expect(response.status).toBe(400);
    }
    expect(dbMocks.createStaffNotificationDestination).not.toHaveBeenCalled();

    rows.push(destination());
    const changedChannel = await jsonRequest(
      '/api/staff-notification-destinations/destination-1',
      'PUT',
      lineBody(),
    );
    expect(changedChannel.status).toBe(400);
    expect(dbMocks.updateStaffNotificationDestination).not.toHaveBeenCalled();

    const crossAccount = await jsonRequest(
      '/api/staff-notification-destinations/destination-1',
      'PUT',
      chatworkBody({ lineAccountId: 'account-2' }),
    );
    expect(crossAccount.status).toBe(404);

    const missingAccount = await jsonRequest(
      '/api/staff-notification-destinations',
      'GET',
    );
    expect(missingAccount.status).toBe(400);
  });

  test('公開catalogだけで設定UIを構築でき、未登録channelの秘密configを返さない', async () => {
    const catalog = await jsonRequest(
      '/api/staff-notification-channels',
      'GET',
    );
    expect(catalog.status).toBe(200);
    const catalogText = await catalog.text();
    expect(catalogText).not.toContain('chatwork-secret');
    expect(JSON.parse(catalogText).data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        channelType: 'chatwork',
        label: 'Chatwork',
        configFields: expect.arrayContaining([
          expect.objectContaining({
            key: 'apiToken',
            inputType: 'secret',
            required: true,
          }),
        ]),
        capabilities: { testSend: true, setupKind: 'none' },
      }),
      expect.objectContaining({
        channelType: 'line',
        label: 'LINE',
        configFields: [],
        capabilities: { testSend: false, setupKind: 'line_one_time' },
      }),
    ]));

    rows.push(destination({
      id: 'retired-1',
      channelType: 'retired-slack',
      config: { botToken: 'must-never-leak' },
    }));
    const listed = await jsonRequest(
      '/api/staff-notification-destinations?lineAccountId=account-1',
      'GET',
    );
    const listedText = await listed.text();
    expect(listedText).not.toContain('must-never-leak');
    expect(JSON.parse(listedText).data[0]).toMatchObject({
      id: 'retired-1',
      channelType: 'retired-slack',
      config: {},
      unsupported: true,
      setupState: null,
    });
  });
});

describe('staff notification test send', () => {
  test('account-scoped destinationと安全な共通テストpayloadだけをserviceへ渡す', async () => {
    rows.push(destination());
    const response = await jsonRequest(
      '/api/staff-notification-destinations/destination-1/test',
      'POST',
      { lineAccountId: 'account-1' },
    );

    expect(response.status).toBe(200);
    expect(notifyMocks.sendStaffNotificationTest).toHaveBeenCalledWith(
      expect.objectContaining({ DB: expect.anything() }),
      expect.objectContaining({
        id: 'destination-1',
        config: { roomId: '12345', apiToken: 'chatwork-secret' },
      }),
      {
        eventType: 'test',
        lineAccountId: 'account-1',
        name: 'テスト通知',
        excerpt: 'スタッフ通知のテスト送信です',
        deepLink: 'https://admin.example.test/accounts',
      },
    );
    expect(await response.json()).toEqual({ success: true, data: null });
  });

  test('provider失敗を固定502へ変換し、応答にもlogにも失敗本文やtokenを出さない', async () => {
    rows.push(destination());
    notifyMocks.sendStaffNotificationTest.mockResolvedValueOnce({
      destinationId: 'destination-1',
      status: 'failed',
      errorCode: 'provider-secret chatwork-secret',
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await jsonRequest(
      '/api/staff-notification-destinations/destination-1/test',
      'POST',
      { lineAccountId: 'account-1' },
    );
    const text = await response.text();
    const log = JSON.stringify(errorSpy.mock.calls);

    expect(response.status).toBe(502);
    expect(text).not.toContain('provider-secret');
    expect(text).not.toContain('chatwork-secret');
    expect(log).not.toContain('provider-secret');
    expect(log).not.toContain('chatwork-secret');
    errorSpy.mockRestore();
  });
});

describe('LINE one-time link management', () => {
  test('平文codeを一回だけ返し、DBにはdigestと10分後期限だけを渡す', async () => {
    rows.push(destination({
      id: 'line-1',
      label: 'LINE 受付',
      channelType: 'line',
      config: {},
    }));

    const response = await jsonRequest(
      '/api/staff-notification-destinations/line-1/line-link-code',
      'POST',
      { lineAccountId: 'account-1' },
    );
    const body = await response.json() as {
      success: boolean;
      data: { code: string; expiresAt: string };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
    expect(body.data.expiresAt).toBe(EXPIRES_AT);
    expect(linkMocks.digestStaffLineLinkCode).toHaveBeenCalledWith(body.data.code);
    expect(dbMocks.issueStaffNotificationLineLinkCode).toHaveBeenCalledWith(
      expect.anything(),
      {
        id: 'line-1',
        lineAccountId: 'account-1',
        codeDigest: `digest:${body.data.code}`,
        expiresAt: EXPIRES_AT,
      },
    );
    expect(JSON.stringify(body)).not.toContain(`digest:${body.data.code}`);

    const listed = await jsonRequest(
      '/api/staff-notification-destinations?lineAccountId=account-1',
      'GET',
    );
    const listedText = await listed.text();
    expect(listedText).not.toContain(body.data.code);
    expect(listedText).not.toContain(`digest:${body.data.code}`);
    expect(JSON.parse(listedText).data[0]).toMatchObject({
      setupState: { kind: 'line_one_time', linked: false },
    });
  });

  test('LINE解除はaccount-scopedで、userIdを応答へ返さない', async () => {
    rows.push(destination({
      id: 'line-1',
      channelType: 'line',
      config: {},
      lineUserId: 'U-sensitive-user-id',
      lineLinkedAt: NOW,
    }));

    const response = await jsonRequest(
      '/api/staff-notification-destinations/line-1/line-link?lineAccountId=account-1',
      'DELETE',
    );
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).not.toContain('U-sensitive-user-id');
    expect(JSON.parse(text)).toMatchObject({
      success: true,
      data: {
        setupState: { kind: 'line_one_time', linked: false },
      },
    });

    const foreign = await jsonRequest(
      '/api/staff-notification-destinations/line-1/line-link?lineAccountId=account-2',
      'DELETE',
    );
    expect(foreign.status).toBe(404);
  });
});
