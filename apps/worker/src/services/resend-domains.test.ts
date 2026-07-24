import { describe, expect, it, vi } from 'vitest';
import {
  getResendDomain,
  registerResendDomain,
  resolveResendApiKey,
  startResendDomainVerification,
} from './resend-domains.js';

const providerDomain = {
  id: 'domain_123',
  name: 'brand.example',
  status: 'not_started',
  created_at: '2026-07-23T00:00:00Z',
  secret_internal_value: 'must-not-leak',
  records: [
    {
      record: 'SPF',
      type: 'MX',
      name: 'send',
      value: 'feedback-smtp.example.com',
      ttl: 'Auto',
      status: 'pending',
      priority: 10,
      provider_secret: 'must-not-leak',
    },
    {
      record: 'DKIM',
      type: 'TXT',
      name: 'resend._domainkey',
      value: 'public-dkim-value',
      ttl: 'Auto',
      status: 'pending',
    },
  ],
};

describe('resolveResendApiKey', () => {
  it('uses the LINE-account key first and falls back to the unchanged shared key', () => {
    expect(resolveResendApiKey(
      { RESEND_API_KEY: ' shared-key ' },
      ' account-key ',
    )).toBe('account-key');
    expect(resolveResendApiKey(
      { RESEND_API_KEY: ' shared-key ' },
      null,
    )).toBe('shared-key');
    expect(resolveResendApiKey({}, null)).toBeNull();
  });
});

describe('registerResendDomain', () => {
  it('保存メールから決めたドメインを登録し、公開DNS項目だけを返す', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(providerDomain), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));

    const result = await registerResendDomain(
      { RESEND_API_KEY: 'resend-secret' },
      'brand.example',
      fetcher,
    );
    expect(result).toEqual({
      ok: true,
      domain: {
        id: 'domain_123',
        name: 'brand.example',
        status: 'not_started',
        records: [
          {
            record: 'SPF',
            type: 'MX',
            name: 'send',
            value: 'feedback-smtp.example.com',
            ttl: 'Auto',
            status: 'pending',
            priority: 10,
          },
          {
            record: 'DKIM',
            type: 'TXT',
            name: 'resend._domainkey',
            value: 'public-dkim-value',
            ttl: 'Auto',
            status: 'pending',
            priority: null,
          },
        ],
      },
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.resend.com/domains');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer resend-secret');
    expect(JSON.parse(String(init?.body))).toEqual({ name: 'brand.example' });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
  });

  it('API key不足はproviderを呼ばず固定エラーにする', async () => {
    const fetcher = vi.fn();
    await expect(registerResendDomain({}, 'brand.example', fetcher))
      .resolves.toEqual({ ok: false, error: 'missing_api_key' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    [
      'プラン上限',
      403,
      {
        name: 'validation_error',
        statusCode: 403,
        message: 'Your plan includes 1 domain. Remove an existing domain or upgrade your plan.',
      },
      'resend_domains_plan_limit',
    ],
    [
      '権限不足のAPI key',
      401,
      {
        name: 'restricted_api_key',
        statusCode: 401,
        message: 'This API key is restricted to only send emails.',
      },
      'resend_domains_auth_error',
    ],
    [
      '無効なAPI key',
      403,
      {
        name: 'invalid_api_key',
        statusCode: 403,
        message: 'API key is invalid.',
      },
      'resend_domains_auth_error',
    ],
    [
      '不正なドメイン',
      422,
      {
        name: 'validation_error',
        statusCode: 422,
        message: 'The `name` field must be a valid domain.',
      },
      'resend_domains_invalid_domain',
    ],
  ] as const)(
    'providerの%sは生メッセージではなく安全な内部コードへ分類する',
    async (_label, status, providerError, error) => {
      const fetcher = vi.fn(async () => new Response(JSON.stringify(providerError), {
        status,
        headers: { 'content-type': 'application/json' },
      }));

      const result = await registerResendDomain(
        { RESEND_API_KEY: 'resend-secret' },
        'brand.example',
        fetcher,
      );

      expect(result).toEqual({ ok: false, error });
      expect(JSON.stringify(result)).not.toContain(providerError.message);
      expect(JSON.stringify(result)).not.toContain('resend-secret');
    },
  );

  it('未知のproviderエラーはHTTP codeだけを残し、生メッセージを漏らさない', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      name: 'unexpected_provider_error',
      statusCode: 503,
      message: 'provider-secret resend-secret internal diagnostic',
    }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }));

    const result = await registerResendDomain(
      { RESEND_API_KEY: 'resend-secret' },
      'brand.example',
      fetcher,
    );

    expect(result).toEqual({ ok: false, error: 'resend_domains_http_503' });
    expect(JSON.stringify(result)).not.toContain('provider-secret');
    expect(JSON.stringify(result)).not.toContain('resend-secret');
    expect(JSON.stringify(result)).not.toContain('internal diagnostic');
  });

  it.each([
    [async () => new Response('provider secret body', { status: 422 }), 'resend_domains_http_422'],
    [async () => new Response('{}', { status: 200 }), 'resend_domains_invalid_response'],
    [async () => { throw new Error('resend-secret provider body'); }, 'resend_domains_network_error'],
  ])('provider失敗の本文を返却・logせず固定コードにする', async (implementation, error) => {
    const fetcher = vi.fn(implementation);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(registerResendDomain(
      { RESEND_API_KEY: 'resend-secret' },
      'brand.example',
      fetcher,
    )).resolves.toEqual({ ok: false, error });
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });
});

describe('startResendDomainVerification', () => {
  it('未開始・再試行時だけ非同期の認証開始を依頼する', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'domain_123' }), {
      status: 200,
    }));

    await expect(startResendDomainVerification(
      { RESEND_API_KEY: 'resend-secret' },
      'domain_123',
      fetcher,
    )).resolves.toEqual({ ok: true });
    expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['https://api.resend.com/domains/domain_123/verify', 'POST'],
    ]);
  });

  it('認証開始失敗は固定コードにする', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 503 }));

    await expect(startResendDomainVerification(
      { RESEND_API_KEY: 'resend-secret' },
      'domain_123',
      fetcher,
    )).resolves.toEqual({ ok: false, error: 'resend_domains_http_503' });
  });
});

describe('getResendDomain', () => {
  it('認証を再開始せずGETだけで最新の verified 状態とDNS一覧を返す', async () => {
    const verified = {
      ...providerDomain,
      status: 'verified',
      records: providerDomain.records.map((record) => ({ ...record, status: 'verified' })),
    };
    const fetcher = vi.fn(async () => new Response(JSON.stringify(verified), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const result = await getResendDomain(
      { RESEND_API_KEY: 'resend-secret' },
      'domain_123',
      fetcher,
    );

    expect(result).toMatchObject({
      ok: true,
      domain: { id: 'domain_123', name: 'brand.example', status: 'verified' },
    });
    expect(fetcher.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      ['https://api.resend.com/domains/domain_123', 'GET'],
    ]);
  });

  it('取得失敗は固定コードにする', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 503 }));

    await expect(getResendDomain(
      { RESEND_API_KEY: 'resend-secret' },
      'domain_123',
      fetcher,
    )).resolves.toEqual({ ok: false, error: 'resend_domains_http_503' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
