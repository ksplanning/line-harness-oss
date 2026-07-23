import { describe, expect, it, vi } from 'vitest';
import { buildEditMailMessage, sendEditMail } from './edit-mail-sender.js';

const dbMocks = vi.hoisted(() => ({
  getEmailSenderSettings: vi.fn(),
}));

vi.mock('@line-crm/db', () => ({
  getEmailSenderSettings: dbMocks.getEmailSenderSettings,
}));

describe('sendEditMail', () => {
  const input = {
    to: 'recipient@example.test',
    subject: '回答の控え',
    text: '本文',
    idempotencyKey: 'formaloo-edit-mail/submission-1',
  };

  it.each([
    [{}, 'disabled'],
    [{ FORM_EDIT_MAIL_ENABLED: 'false' }, 'disabled'],
    [{ FORM_EDIT_MAIL_ENABLED: 'true' }, 'missing_api_key'],
    [{ FORM_EDIT_MAIL_ENABLED: 'true', RESEND_API_KEY: 'secret' }, 'missing_from'],
  ])('設定不足は送信せず skip する (%s)', async (env, reason) => {
    const fetcher = vi.fn();

    await expect(sendEditMail(env, input, fetcher)).resolves.toEqual({ status: 'skipped', reason });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('Resend HTTP APIへenvの差出人・冪等キー・本文を送る', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'email_123' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const result = await sendEditMail({
      FORM_EDIT_MAIL_ENABLED: 'true',
      RESEND_API_KEY: 'resend-secret',
      FORM_EDIT_MAIL_FROM: '受付 <no-reply@testline.example>',
    }, input, fetcher);

    expect(result).toEqual({
      status: 'sent',
      providerMessageId: 'email_123',
      providerIdempotencyKey: input.idempotencyKey,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(input.idempotencyKey);
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer resend-secret');
    expect(JSON.parse(String(init?.body))).toEqual({
      from: '受付 <no-reply@testline.example>',
      to: ['recipient@example.test'],
      subject: '回答の控え',
      text: '本文',
    });
  });

  it.each([
    [new Response('{}', { status: 422 }), 'resend_http_422'],
    [new Response('{}', { status: 200 }), 'resend_invalid_response'],
  ])('provider失敗は本文を含まない固定コードにする', async (response, error) => {
    const fetcher = vi.fn(async () => response);

    await expect(sendEditMail({
      FORM_EDIT_MAIL_ENABLED: 'true',
      RESEND_API_KEY: 'resend-secret',
      FORM_EDIT_MAIL_FROM: 'no-reply@example.test',
    }, input, fetcher)).resolves.toEqual({
      status: 'failed',
      error,
      providerIdempotencyKey: input.idempotencyKey,
    });
  });

  it('network例外のmessageを返却・logせず固定コードにする', async () => {
    const fetcher = vi.fn(async () => { throw new Error('recipient@example.test 本文'); });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await expect(sendEditMail({
      FORM_EDIT_MAIL_ENABLED: 'true',
      RESEND_API_KEY: 'resend-secret',
      FORM_EDIT_MAIL_FROM: 'no-reply@example.test',
    }, input, fetcher)).resolves.toEqual({
      status: 'failed',
      error: 'resend_network_error',
      providerIdempotencyKey: input.idempotencyKey,
    });
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it('認証済みドメインならLINEアカウントの差出人名・アドレスを使う', async () => {
    dbMocks.getEmailSenderSettings.mockResolvedValueOnce({
      lineAccountId: 'account-1',
      senderEmail: 'notice@brand.example',
      senderName: 'ブランド受付',
      senderDomain: 'brand.example',
      resendDomainId: 'domain-1',
      resendDomainStatus: 'verified',
      dnsRecords: [],
      domainCheckedAt: '2026-07-23T12:00:00+09:00',
      createdAt: '2026-07-23T11:00:00+09:00',
      updatedAt: '2026-07-23T12:00:00+09:00',
    });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'email_custom' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await sendEditMail({
      DB: {} as D1Database,
      FORM_EDIT_MAIL_ENABLED: 'true',
      RESEND_API_KEY: 'resend-secret',
      FORM_EDIT_MAIL_FROM: '既定 <default@example.test>',
    }, { ...input, lineAccountId: 'account-1' }, fetcher);

    expect(dbMocks.getEmailSenderSettings).toHaveBeenCalledWith(expect.anything(), 'account-1');
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).from)
      .toBe('ブランド受付 <notice@brand.example>');
  });

  it('認証済みで差出人名が空ならアドレスだけを使う', async () => {
    dbMocks.getEmailSenderSettings.mockResolvedValueOnce({
      lineAccountId: 'account-1',
      senderEmail: 'notice@brand.example',
      senderName: null,
      senderDomain: 'brand.example',
      resendDomainId: 'domain-1',
      resendDomainStatus: 'verified',
      dnsRecords: [],
      domainCheckedAt: null,
      createdAt: '2026-07-23T11:00:00+09:00',
      updatedAt: '2026-07-23T11:00:00+09:00',
    });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'email_custom' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    await sendEditMail({
      DB: {} as D1Database,
      FORM_EDIT_MAIL_ENABLED: 'true',
      RESEND_API_KEY: 'resend-secret',
      FORM_EDIT_MAIL_FROM: 'default@example.test',
    }, { ...input, lineAccountId: 'account-1' }, fetcher);

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).from)
      .toBe('notice@brand.example');
  });

  it.each([
    ['pending', 'brand.example', 'notice@brand.example'],
    ['failed', 'brand.example', 'notice@brand.example'],
    ['verified', 'other.example', 'notice@brand.example'],
    ['verified', 'brand.example', 'invalid-address'],
  ])(
    '未認証・ドメイン不一致・不正アドレスは既定差出人へfallbackする (%s)',
    async (resendDomainStatus, senderDomain, senderEmail) => {
      dbMocks.getEmailSenderSettings.mockResolvedValueOnce({
        lineAccountId: 'account-1',
        senderEmail,
        senderName: 'ブランド受付',
        senderDomain,
        resendDomainId: 'domain-1',
        resendDomainStatus,
        dnsRecords: [],
        domainCheckedAt: null,
        createdAt: '2026-07-23T11:00:00+09:00',
        updatedAt: '2026-07-23T11:00:00+09:00',
      });
      const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'email_fallback' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

      await sendEditMail({
        DB: {} as D1Database,
        FORM_EDIT_MAIL_ENABLED: 'true',
        RESEND_API_KEY: 'resend-secret',
        FORM_EDIT_MAIL_FROM: '既定 <default@example.test>',
      }, { ...input, lineAccountId: 'account-1' }, fetcher);

      expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).from)
        .toBe('既定 <default@example.test>');
    },
  );

  it('設定DBの読取失敗でも送信を止めず既定差出人へfallbackする', async () => {
    dbMocks.getEmailSenderSettings.mockRejectedValueOnce(new Error('secret database detail'));
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'email_fallback' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await sendEditMail({
      DB: {} as D1Database,
      FORM_EDIT_MAIL_ENABLED: 'true',
      RESEND_API_KEY: 'resend-secret',
      FORM_EDIT_MAIL_FROM: 'default@example.test',
    }, { ...input, lineAccountId: 'account-1' }, fetcher);

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).from)
      .toBe('default@example.test');
    expect(consoleError).not.toHaveBeenCalled();
  });
});

describe('buildEditMailMessage', () => {
  it('日本語本文へ控え・受付番号・PDF・編集URLを含める', () => {
    const message = buildEditMailMessage({
      formTitle: '資料請求フォーム',
      answers: [
        { label: 'お名前', value: '山田 太郎' },
        { label: '希望日', value: ['月曜', '火曜'] },
        { label: '添付', value: { unsupported: true } },
      ],
      trackingCode: 'TRACK-001',
      submitNumber: '42',
      pdfLink: 'https://files.example.test/receipt.pdf',
      editUrl: 'https://worker.example.test/fe/signed-token',
    });

    expect(message.subject).toBe('【資料請求フォーム】回答の控えと編集用リンク');
    expect(message.text).toContain('受付番号: TRACK-001');
    expect(message.text).toContain('お名前: 山田 太郎');
    expect(message.text).toContain('希望日: 月曜、火曜');
    expect(message.text).not.toContain('unsupported');
    expect(message.text).toContain('控えPDF: https://files.example.test/receipt.pdf');
    expect(message.text).toContain('編集用URL: https://worker.example.test/fe/signed-token');
  });

  it('tracking codeが無ければsubmit numberを使い、PDF欠落時は行ごと省略する', () => {
    const message = buildEditMailMessage({
      formTitle: '申込',
      answers: [],
      trackingCode: null,
      submitNumber: '0007',
      pdfLink: null,
      editUrl: 'https://worker.example.test/fe/token',
    });

    expect(message.text).toContain('受付番号: 0007');
    expect(message.text).not.toContain('控えPDF:');
    expect(message.text).toContain('回答内容\n（回答項目なし）');
  });
});
