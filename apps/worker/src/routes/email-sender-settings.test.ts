import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  deleteEmailSenderSettings: vi.fn(),
  getEmailSenderSettings: vi.fn(),
  getLineAccountById: vi.fn(),
  saveEmailSenderSettings: vi.fn(),
  setEmailSenderResendApiKey: vi.fn(),
  setEmailSenderDomainState: vi.fn(),
}));

const resendMocks = vi.hoisted(() => ({
  getResendDomain: vi.fn(),
  registerResendDomain: vi.fn(),
  startResendDomainVerification: vi.fn(),
}));

vi.mock('@line-crm/db', () => dbMocks);
vi.mock('../services/resend-domains.js', async () => ({
  ...(await vi.importActual('../services/resend-domains.js')),
  ...resendMocks,
}));

import { emailSenderSettings } from './email-sender-settings.js';

type Stored = {
  lineAccountId: string;
  senderEmail: string;
  senderName: string | null;
  senderDomain: string;
  resendApiKey: string | null;
  resendDomainId: string | null;
  resendDomainStatus: string;
  dnsRecords: Array<{
    record: string | null;
    type: string;
    name: string;
    value: string;
    ttl: string | null;
    status: string | null;
    priority: number | null;
  }>;
  domainCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

const records: Stored['dnsRecords'] = [{
  record: 'DKIM',
  type: 'TXT',
  name: 'resend._domainkey',
  value: 'public-dkim-value',
  ttl: 'Auto',
  status: 'pending',
  priority: null,
}];

let stored: Stored | null;
let app: Hono;

function view(overrides: Partial<Stored> = {}): Stored {
  return {
    lineAccountId: 'account-1',
    senderEmail: 'notice@brand.example',
    senderName: 'ブランド受付',
    senderDomain: 'brand.example',
    resendApiKey: null,
    resendDomainId: null,
    resendDomainStatus: 'not_started',
    dnsRecords: [],
    domainCheckedAt: null,
    createdAt: '2026-07-23T10:00:00+09:00',
    updatedAt: '2026-07-23T10:00:00+09:00',
    ...overrides,
  };
}

async function request(path: string, init?: RequestInit) {
  return app.request(`https://worker.example.test${path}`, init, {
    DB: {} as D1Database,
    RESEND_API_KEY: 'resend-secret',
    FORM_EDIT_MAIL_ENABLED: 'true',
    FORM_EDIT_MAIL_FROM: '既定 <default@example.test>',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stored = null;
  app = new Hono();
  app.route('/', emailSenderSettings);
  dbMocks.getLineAccountById.mockResolvedValue({ id: 'account-1' });
  dbMocks.getEmailSenderSettings.mockImplementation(async () => stored);
  dbMocks.saveEmailSenderSettings.mockImplementation(async (_db, input) => {
    const sameDomain = stored?.senderDomain === input.senderDomain;
    stored = view({
      senderEmail: input.senderEmail,
      senderName: input.senderName,
      senderDomain: input.senderDomain,
      resendDomainId: sameDomain ? stored?.resendDomainId ?? null : null,
      resendDomainStatus: sameDomain ? stored?.resendDomainStatus ?? 'not_started' : 'not_started',
      dnsRecords: sameDomain ? stored?.dnsRecords ?? [] : [],
    });
    return stored;
  });
  dbMocks.deleteEmailSenderSettings.mockImplementation(async () => { stored = null; });
  dbMocks.setEmailSenderResendApiKey.mockImplementation(async (_db, _accountId, resendApiKey) => {
    stored = stored ? {
      ...stored,
      resendApiKey,
      resendDomainId: null,
      resendDomainStatus: 'not_started',
      dnsRecords: [],
      domainCheckedAt: null,
    } : null;
    return stored;
  });
  dbMocks.setEmailSenderDomainState.mockImplementation(async (_db, input) => {
    stored = stored ? {
      ...stored,
      resendDomainId: input.resendDomainId,
      resendDomainStatus: input.resendDomainStatus,
      dnsRecords: input.dnsRecords,
      domainCheckedAt: '2026-07-23T11:00:00+09:00',
    } : null;
    return stored;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('email sender settings admin route', () => {
  it('worker本体へ管理routeがmountされている', () => {
    const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(source).toContain("import { emailSenderSettings } from './routes/email-sender-settings.js';");
    expect(source).toContain("app.route('/', emailSenderSettings);");
  });

  it('未設定GETは書き込まず従来差出人の状態を返す', async () => {
    const response = await request('/api/account-settings/email-sender?accountId=account-1');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        senderEmail: null,
        senderName: null,
        senderDomain: null,
        resendApiKeyMasked: null,
        resendDomainId: null,
        domainStatus: 'not_started',
        dnsRecords: [],
        usingFallback: false,
      },
    });
    expect(dbMocks.saveEmailSenderSettings).not.toHaveBeenCalled();
  });

  it('Resend APIキーを保存・マスク再取得・削除し、平文を応答しない', async () => {
    stored = view();
    const saved = await request('/api/account-settings/email-sender/resend-key', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: 'account-1',
        resendApiKey: ' re_account_secret ',
      }),
    });
    const savedText = await saved.text();

    expect(saved.status).toBe(200);
    expect(dbMocks.setEmailSenderResendApiKey).toHaveBeenCalledWith(
      expect.anything(),
      'account-1',
      're_account_secret',
    );
    expect(savedText).not.toContain('re_account_secret');
    expect(JSON.parse(savedText)).toMatchObject({
      success: true,
      data: { resendApiKeyMasked: '********' },
    });

    const loadedText = await (
      await request('/api/account-settings/email-sender?accountId=account-1')
    ).text();
    expect(loadedText).not.toContain('re_account_secret');
    expect(JSON.parse(loadedText)).toMatchObject({
      success: true,
      data: { resendApiKeyMasked: '********' },
    });

    const deleted = await request('/api/account-settings/email-sender/resend-key', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'account-1', resendApiKey: null }),
    });
    expect(deleted.status).toBe(200);
    expect(dbMocks.setEmailSenderResendApiKey).toHaveBeenLastCalledWith(
      expect.anything(),
      'account-1',
      null,
    );
    expect(await deleted.json()).toMatchObject({
      success: true,
      data: { resendApiKeyMasked: null },
    });
  });

  it('差出人をtrimして保存し、再取得して同じ値を返す', async () => {
    const saved = await request('/api/account-settings/email-sender', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: 'account-1',
        senderEmail: '  notice@Brand.Example ',
        senderName: ' ブランド受付 ',
      }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      success: true,
      data: {
        senderEmail: 'notice@Brand.Example',
        senderName: 'ブランド受付',
        senderDomain: 'brand.example',
        domainStatus: 'not_started',
        usingFallback: true,
      },
    });

    const loaded = await request('/api/account-settings/email-sender?accountId=account-1');
    expect(await loaded.json()).toMatchObject({
      success: true,
      data: {
        senderEmail: 'notice@Brand.Example',
        senderName: 'ブランド受付',
        senderDomain: 'brand.example',
      },
    });
  });

  it('空メールで設定を解除し、不正email・header注入名を拒否する', async () => {
    stored = view();
    const cleared = await request('/api/account-settings/email-sender', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'account-1', senderEmail: ' ', senderName: '' }),
    });
    expect(cleared.status).toBe(200);
    expect(stored).toBeNull();

    for (const body of [
      { accountId: 'account-1', senderEmail: 'not-an-email', senderName: '' },
      { accountId: 'account-1', senderEmail: 'notice@brand.example', senderName: '受付\r\nBcc: victim@example.test' },
    ]) {
      const response = await request('/api/account-settings/email-sender', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }
  });

  it('保存済みメールのdomainだけを登録しDNS公開情報を保存する成功経路は不変', async () => {
    stored = view();
    resendMocks.registerResendDomain.mockResolvedValue({
      ok: true,
      domain: {
        id: 'domain_123',
        name: 'brand.example',
        status: 'pending',
        records,
      },
    });

    const response = await request('/api/account-settings/email-sender/domain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'account-1', domain: 'attacker.example' }),
    });

    expect(response.status).toBe(200);
    expect(resendMocks.registerResendDomain).toHaveBeenCalledWith(
      expect.objectContaining({ RESEND_API_KEY: 'resend-secret' }),
      'brand.example',
    );
    expect(dbMocks.setEmailSenderDomainState).toHaveBeenCalledWith(expect.anything(), {
      lineAccountId: 'account-1',
      expectedSenderDomain: 'brand.example',
      expectedResendDomainId: null,
      resendDomainId: 'domain_123',
      resendDomainStatus: 'pending',
      dnsRecords: records,
    });
    expect(await response.json()).toEqual({
      success: true,
      data: {
        senderEmail: 'notice@brand.example',
        senderName: 'ブランド受付',
        senderDomain: 'brand.example',
        resendApiKeyMasked: null,
        resendDomainId: 'domain_123',
        domainStatus: 'pending',
        dnsRecords: records,
        usingFallback: true,
      },
    });
  });

  it('ドメイン登録はLINEアカウント専用キーを共通キーより優先する', async () => {
    stored = view({ resendApiKey: 're_account_secret' });
    resendMocks.registerResendDomain.mockResolvedValue({
      ok: true,
      domain: {
        id: 'domain_account',
        name: 'brand.example',
        status: 'pending',
        records,
      },
    });

    const response = await request('/api/account-settings/email-sender/domain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'account-1' }),
    });

    expect(response.status).toBe(200);
    expect(resendMocks.registerResendDomain).toHaveBeenCalledWith(
      expect.objectContaining({ RESEND_API_KEY: 're_account_secret' }),
      'brand.example',
    );
  });

  it.each([
    [
      'プラン上限',
      'resend_domains_plan_limit',
      'プランの上限です（1ドメインまで）。既存ドメインの削除かプラン変更が必要です。',
    ],
    [
      'Resend認証エラー',
      'resend_domains_auth_error',
      'Resend の認証設定に問題があります。APIキーと権限を確認してください。',
    ],
    [
      'API key未設定',
      'missing_api_key',
      'Resend の認証設定に問題があります。APIキーと権限を確認してください。',
    ],
    [
      '不正なドメイン',
      'resend_domains_invalid_domain',
      'ドメインの形式が正しくありません。差出人メールアドレスのドメインを確認してください。',
    ],
  ] as const)(
    'ドメイン登録の%sを安全な日本語の理由と次の一手で返す',
    async (_label, error, expectedMessage) => {
      stored = view();
      resendMocks.registerResendDomain.mockResolvedValue({ ok: false, error });

      const response = await request('/api/account-settings/email-sender/domain', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: 'account-1' }),
      });

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        success: false,
        error: expectedMessage,
      });
      expect(dbMocks.setEmailSenderDomainState).not.toHaveBeenCalled();
    },
  );

  it('未知の登録失敗は汎用文言と安全なHTTP codeを返す', async () => {
    stored = view();
    resendMocks.registerResendDomain.mockResolvedValue({
      ok: false,
      error: 'resend_domains_http_503',
    });

    const response = await request('/api/account-settings/email-sender/domain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'account-1' }),
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      success: false,
      error: 'ドメインを登録できませんでした（コード: resend_domains_http_503）',
    });
    expect(dbMocks.setEmailSenderDomainState).not.toHaveBeenCalled();
  });

  it('任意のprovider由来文字列をcodeとして表示せず、秘密値を応答しない', async () => {
    stored = view();
    resendMocks.registerResendDomain.mockResolvedValue({
      ok: false,
      error: 'resend_domains_http_422 provider-secret resend-secret',
    });

    const response = await request('/api/account-settings/email-sender/domain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'account-1' }),
    });
    const responseText = await response.text();

    expect(response.status).toBe(502);
    expect(JSON.parse(responseText)).toEqual({
      success: false,
      error: 'ドメインを登録できませんでした（コード: resend_domains_unknown_error）',
    });
    expect(responseText).not.toContain('provider-secret');
    expect(responseText).not.toContain('resend-secret');
    expect(dbMocks.setEmailSenderDomainState).not.toHaveBeenCalled();
  });

  it('確認ボタン相当でpendingをverifiedへ更新しcustom送信状態にする', async () => {
    stored = view({
      resendApiKey: 're_account_secret',
      resendDomainId: 'domain_123',
      resendDomainStatus: 'pending',
      dnsRecords: records,
    });
    resendMocks.getResendDomain.mockResolvedValue({
      ok: true,
      domain: {
        id: 'domain_123',
        name: 'brand.example',
        status: 'verified',
        records: records.map((record) => ({ ...record, status: 'verified' })),
      },
    });

    const response = await request('/api/account-settings/email-sender/domain/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'account-1' }),
    });

    expect(response.status).toBe(200);
    expect(resendMocks.startResendDomainVerification).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      success: true,
      data: { domainStatus: 'verified', usingFallback: false },
    });
  });

  it('not_startedの初回確認だけ認証を開始し、最新pending状態を取得する', async () => {
    stored = view({
      resendApiKey: 're_account_secret',
      resendDomainId: 'domain_123',
      resendDomainStatus: 'not_started',
      dnsRecords: records,
    });
    resendMocks.startResendDomainVerification.mockResolvedValue({ ok: true });
    resendMocks.getResendDomain.mockResolvedValue({
      ok: true,
      domain: {
        id: 'domain_123',
        name: 'brand.example',
        status: 'pending',
        records,
      },
    });

    const response = await request('/api/account-settings/email-sender/domain/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'account-1' }),
    });

    expect(response.status).toBe(200);
    expect(resendMocks.startResendDomainVerification).toHaveBeenCalledWith(
      expect.objectContaining({ RESEND_API_KEY: 're_account_secret' }),
      'domain_123',
    );
    expect(resendMocks.getResendDomain).toHaveBeenCalledWith(
      expect.objectContaining({ RESEND_API_KEY: 're_account_secret' }),
      'domain_123',
    );
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        resendDomainId: 'domain_123',
        domainStatus: 'pending',
        usingFallback: true,
      },
    });
  });

  it('テスト送信は保存済み差出人だけを宛先にし、成功理由を返す', async () => {
    stored = view({
      resendApiKey: 're_account_secret',
      resendDomainId: 'domain_123',
      resendDomainStatus: 'verified',
    });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'email_test_1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetcher);

    const response = await request('/api/account-settings/email-sender/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: 'account-1',
        to: 'attacker@example.test',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { message: 'テストメールを送信しました。' },
    });
    const [, init] = fetcher.mock.calls[0];
    expect(new Headers(init?.headers).get('Authorization'))
      .toBe('Bearer re_account_secret');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      from: 'ブランド受付 <notice@brand.example>',
      to: ['notice@brand.example'],
    });
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('attacker@example.test');
  });

  it('テスト送信のprovider失敗は秘密値を含まない固定理由を返す', async () => {
    stored = view({ resendApiKey: 're_account_secret' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      'provider-secret re_account_secret',
      { status: 422 },
    )));

    const response = await request('/api/account-settings/email-sender/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'account-1' }),
    });
    const responseText = await response.text();

    expect(response.status).toBe(502);
    expect(responseText).toContain('resend_http_422');
    expect(responseText).not.toContain('provider-secret');
    expect(responseText).not.toContain('re_account_secret');
  });

  it('providerのdomain不一致と失敗本文を固定エラー化し、秘密値を応答しない', async () => {
    stored = view();
    resendMocks.registerResendDomain
      .mockResolvedValueOnce({
        ok: true,
        domain: { id: 'domain_bad', name: 'other.example', status: 'verified', records },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: 'resend_domains_http_422 provider-secret resend-secret',
      });

    const mismatch = await request('/api/account-settings/email-sender/domain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'account-1' }),
    });
    expect(mismatch.status).toBe(502);
    expect(dbMocks.setEmailSenderDomainState).not.toHaveBeenCalled();

    const failed = await request('/api/account-settings/email-sender/domain', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: 'account-1' }),
    });
    const failedText = await failed.text();
    expect(failed.status).toBe(502);
    expect(failedText).not.toContain('provider-secret');
    expect(failedText).not.toContain('resend-secret');
  });

  it('存在しないLINEアカウントは404にする', async () => {
    dbMocks.getLineAccountById.mockResolvedValueOnce(null);
    const response = await request('/api/account-settings/email-sender?accountId=missing');
    expect(response.status).toBe(404);
  });
});
