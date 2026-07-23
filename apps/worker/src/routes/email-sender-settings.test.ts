import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  deleteEmailSenderSettings: vi.fn(),
  getEmailSenderSettings: vi.fn(),
  getLineAccountById: vi.fn(),
  saveEmailSenderSettings: vi.fn(),
  setEmailSenderDomainState: vi.fn(),
}));

const resendMocks = vi.hoisted(() => ({
  getResendDomain: vi.fn(),
  registerResendDomain: vi.fn(),
  startResendDomainVerification: vi.fn(),
}));

vi.mock('@line-crm/db', () => dbMocks);
vi.mock('../services/resend-domains.js', () => resendMocks);

import { emailSenderSettings } from './email-sender-settings.js';

type Stored = {
  lineAccountId: string;
  senderEmail: string;
  senderName: string | null;
  senderDomain: string;
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
        domainStatus: 'not_started',
        dnsRecords: [],
        usingFallback: false,
      },
    });
    expect(dbMocks.saveEmailSenderSettings).not.toHaveBeenCalled();
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

  it('保存済みメールのdomainだけを登録しDNS公開情報を保存する', async () => {
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
    expect(await response.json()).toMatchObject({
      success: true,
      data: { domainStatus: 'pending', dnsRecords: records, usingFallback: true },
    });
  });

  it('確認ボタン相当でpendingをverifiedへ更新しcustom送信状態にする', async () => {
    stored = view({
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
      expect.objectContaining({ RESEND_API_KEY: 'resend-secret' }),
      'domain_123',
    );
    expect(resendMocks.getResendDomain).toHaveBeenCalledWith(
      expect.anything(),
      'domain_123',
    );
    expect(await response.json()).toMatchObject({
      success: true,
      data: { domainStatus: 'pending', usingFallback: true },
    });
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
