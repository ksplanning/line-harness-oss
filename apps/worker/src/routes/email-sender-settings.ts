import {
  deleteEmailSenderSettings,
  getEmailSenderSettings,
  getLineAccountById,
  saveEmailSenderSettings,
  setEmailSenderDomainState,
  type EmailSenderSettings,
} from '@line-crm/db';
import { Hono, type Context } from 'hono';
import type { Env } from '../index.js';
import {
  getResendDomain,
  registerResendDomain,
  startResendDomainVerification,
  type ResendDomain,
} from '../services/resend-domains.js';

const emailSenderSettings = new Hono<Env>();

interface SenderView {
  senderEmail: string | null;
  senderName: string | null;
  senderDomain: string | null;
  domainStatus: string;
  dnsRecords: EmailSenderSettings['dnsRecords'];
  usingFallback: boolean;
}

function emailIdentity(value: string): { email: string; domain: string } | null {
  const email = value.trim();
  if (
    email.length === 0
    || email.length > 254
    || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)
  ) {
    return null;
  }
  return {
    email,
    domain: email.slice(email.lastIndexOf('@') + 1).toLowerCase(),
  };
}

function senderView(settings: EmailSenderSettings | null): SenderView {
  if (!settings) {
    return {
      senderEmail: null,
      senderName: null,
      senderDomain: null,
      domainStatus: 'not_started',
      dnsRecords: [],
      usingFallback: false,
    };
  }
  const identity = emailIdentity(settings.senderEmail);
  const customReady = settings.resendDomainStatus === 'verified'
    && identity?.domain === settings.senderDomain.toLowerCase();
  return {
    senderEmail: settings.senderEmail,
    senderName: settings.senderName,
    senderDomain: settings.senderDomain,
    domainStatus: settings.resendDomainStatus,
    dnsRecords: settings.dnsRecords,
    usingFallback: !customReady,
  };
}

async function jsonBody(c: Context<Env>): Promise<Record<string, unknown> | null> {
  try {
    const value = await c.req.json<unknown>();
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function validAccountId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function accountExists(db: D1Database, accountId: string): Promise<boolean> {
  return Boolean(await getLineAccountById(db, accountId));
}

function domainMatches(expected: EmailSenderSettings, domain: ResendDomain): boolean {
  return domain.name === expected.senderDomain.toLowerCase();
}

function registerDomainErrorMessage(error: string): string {
  switch (error) {
    case 'resend_domains_plan_limit':
      return 'プランの上限です（1ドメインまで）。既存ドメインの削除かプラン変更が必要です。';
    case 'missing_api_key':
    case 'resend_domains_auth_error':
      return 'Resend の認証設定に問題があります。APIキーと権限を確認してください。';
    case 'resend_domains_invalid_domain':
      return 'ドメインの形式が正しくありません。差出人メールアドレスのドメインを確認してください。';
    default: {
      const safeCode = (
        /^resend_domains_http_\d{3}$/.test(error)
        || [
          'resend_domains_invalid_response',
          'resend_domains_network_error',
        ].includes(error)
      )
        ? error
        : 'resend_domains_unknown_error';
      return `ドメインを登録できませんでした（コード: ${safeCode}）`;
    }
  }
}

emailSenderSettings.get('/api/account-settings/email-sender', async (c) => {
  const accountId = validAccountId(c.req.query('accountId'));
  if (!accountId) return c.json({ success: false, error: 'accountId required' }, 400);
  if (!await accountExists(c.env.DB, accountId)) {
    return c.json({ success: false, error: 'LINE account not found' }, 404);
  }

  const settings = await getEmailSenderSettings(c.env.DB, accountId);
  return c.json({ success: true, data: senderView(settings) });
});

emailSenderSettings.put('/api/account-settings/email-sender', async (c) => {
  const body = await jsonBody(c);
  const accountId = validAccountId(body?.accountId);
  if (!body || !accountId) {
    return c.json({ success: false, error: 'accountId and JSON body required' }, 400);
  }
  if (!await accountExists(c.env.DB, accountId)) {
    return c.json({ success: false, error: 'LINE account not found' }, 404);
  }

  if (body.senderEmail === null || (typeof body.senderEmail === 'string' && !body.senderEmail.trim())) {
    await deleteEmailSenderSettings(c.env.DB, accountId);
    return c.json({ success: true, data: senderView(null) });
  }
  if (typeof body.senderEmail !== 'string') {
    return c.json({ success: false, error: '差出人メールアドレスを入力してください' }, 400);
  }
  const identity = emailIdentity(body.senderEmail);
  if (!identity) {
    return c.json({ success: false, error: '差出人メールアドレスの形式が正しくありません' }, 400);
  }
  if (body.senderName !== null && body.senderName !== undefined && typeof body.senderName !== 'string') {
    return c.json({ success: false, error: '差出人名の形式が正しくありません' }, 400);
  }
  const senderName = typeof body.senderName === 'string' ? body.senderName.trim() : '';
  if (senderName.length > 100 || /[\r\n<>]/.test(senderName)) {
    return c.json({ success: false, error: '差出人名の形式が正しくありません' }, 400);
  }

  const settings = await saveEmailSenderSettings(c.env.DB, {
    lineAccountId: accountId,
    senderEmail: identity.email,
    senderName: senderName || null,
    senderDomain: identity.domain,
  });
  return c.json({ success: true, data: senderView(settings) });
});

emailSenderSettings.post('/api/account-settings/email-sender/domain', async (c) => {
  const body = await jsonBody(c);
  const accountId = validAccountId(body?.accountId);
  if (!body || !accountId) {
    return c.json({ success: false, error: 'accountId and JSON body required' }, 400);
  }
  if (!await accountExists(c.env.DB, accountId)) {
    return c.json({ success: false, error: 'LINE account not found' }, 404);
  }

  const settings = await getEmailSenderSettings(c.env.DB, accountId);
  if (!settings) {
    return c.json({ success: false, error: '先に差出人メールアドレスを保存してください' }, 409);
  }
  if (settings.resendDomainId) {
    return c.json({ success: true, data: senderView(settings) });
  }

  const registered = await registerResendDomain(c.env, settings.senderDomain);
  if (!registered.ok) {
    return c.json({
      success: false,
      error: registerDomainErrorMessage(registered.error),
    }, 502);
  }
  if (!domainMatches(settings, registered.domain)) {
    return c.json({ success: false, error: '登録先ドメインを確認できませんでした' }, 502);
  }

  const current = await getEmailSenderSettings(c.env.DB, accountId);
  if (!current || current.senderDomain !== settings.senderDomain || current.resendDomainId) {
    return c.json({ success: false, error: '設定が更新されたため、もう一度お試しください' }, 409);
  }
  const updated = await setEmailSenderDomainState(c.env.DB, {
    lineAccountId: accountId,
    expectedSenderDomain: settings.senderDomain,
    expectedResendDomainId: null,
    resendDomainId: registered.domain.id,
    resendDomainStatus: registered.domain.status,
    dnsRecords: registered.domain.records,
  });
  if (!updated) return c.json({ success: false, error: '設定を保存できませんでした' }, 409);
  return c.json({ success: true, data: senderView(updated) });
});

emailSenderSettings.post('/api/account-settings/email-sender/domain/check', async (c) => {
  const body = await jsonBody(c);
  const accountId = validAccountId(body?.accountId);
  if (!body || !accountId) {
    return c.json({ success: false, error: 'accountId and JSON body required' }, 400);
  }
  if (!await accountExists(c.env.DB, accountId)) {
    return c.json({ success: false, error: 'LINE account not found' }, 404);
  }

  const settings = await getEmailSenderSettings(c.env.DB, accountId);
  if (!settings?.resendDomainId) {
    return c.json({ success: false, error: '先にドメインを登録してください' }, 409);
  }

  if (['not_started', 'failed', 'temporary_failure'].includes(settings.resendDomainStatus)) {
    const started = await startResendDomainVerification(c.env, settings.resendDomainId);
    if (!started.ok) {
      return c.json({ success: false, error: '認証を開始できませんでした' }, 502);
    }
  }

  const checked = await getResendDomain(c.env, settings.resendDomainId);
  if (!checked.ok) {
    return c.json({ success: false, error: '認証状態を確認できませんでした' }, 502);
  }
  if (
    checked.domain.id !== settings.resendDomainId
    || !domainMatches(settings, checked.domain)
  ) {
    return c.json({ success: false, error: '認証先ドメインを確認できませんでした' }, 502);
  }

  const current = await getEmailSenderSettings(c.env.DB, accountId);
  if (
    !current
    || current.senderDomain !== settings.senderDomain
    || current.resendDomainId !== settings.resendDomainId
  ) {
    return c.json({ success: false, error: '設定が更新されたため、もう一度お試しください' }, 409);
  }
  const updated = await setEmailSenderDomainState(c.env.DB, {
    lineAccountId: accountId,
    expectedSenderDomain: settings.senderDomain,
    expectedResendDomainId: settings.resendDomainId,
    resendDomainId: checked.domain.id,
    resendDomainStatus: checked.domain.status,
    dnsRecords: checked.domain.records,
  });
  if (!updated) return c.json({ success: false, error: '設定を保存できませんでした' }, 409);
  return c.json({ success: true, data: senderView(updated) });
});

export { emailSenderSettings };
