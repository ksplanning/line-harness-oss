import { getEmailSenderSettings } from '@line-crm/db';

export interface EditMailSenderEnv {
  DB?: D1Database;
  FORM_EDIT_MAIL_ENABLED?: string;
  RESEND_API_KEY?: string;
  FORM_EDIT_MAIL_FROM?: string;
}

export interface SendEditMailInput {
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
  lineAccountId?: string | null;
}

export type SendEditMailResult =
  | { status: 'skipped'; reason: 'disabled' | 'missing_api_key' | 'missing_from' }
  | { status: 'sent'; providerMessageId: string; providerIdempotencyKey: string }
  | { status: 'failed'; error: string; providerIdempotencyKey: string };

function validatedSenderEmail(value: string): { email: string; domain: string } | null {
  const email = value.trim();
  if (
    email.length === 0
    || email.length > 254
    || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)
  ) {
    return null;
  }
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  return { email, domain };
}

function safeSenderName(value: string | null): string | null {
  const name = value?.trim() ?? '';
  return name && name.length <= 100 && !/[\r\n<>]/.test(name) ? name : null;
}

async function resolveFrom(
  env: EditMailSenderEnv,
  lineAccountId: string | null | undefined,
  fallback: string,
): Promise<string> {
  if (!env.DB || !lineAccountId) return fallback;

  try {
    const settings = await getEmailSenderSettings(env.DB, lineAccountId);
    if (!settings || settings.resendDomainStatus !== 'verified') return fallback;

    const sender = validatedSenderEmail(settings.senderEmail);
    if (!sender || sender.domain !== settings.senderDomain.toLowerCase()) return fallback;

    const name = safeSenderName(settings.senderName);
    return name ? `${name} <${sender.email}>` : sender.email;
  } catch {
    return fallback;
  }
}

export async function sendEditMail(
  env: EditMailSenderEnv,
  input: SendEditMailInput,
  fetcher: typeof fetch = fetch,
): Promise<SendEditMailResult> {
  if (env.FORM_EDIT_MAIL_ENABLED !== 'true') return { status: 'skipped', reason: 'disabled' };
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) return { status: 'skipped', reason: 'missing_api_key' };
  const fallbackFrom = env.FORM_EDIT_MAIL_FROM?.trim();
  if (!fallbackFrom) return { status: 'skipped', reason: 'missing_from' };
  const from = await resolveFrom(env, input.lineAccountId, fallbackFrom);

  try {
    const response = await fetcher('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': input.idempotencyKey,
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        text: input.text,
      }),
    });
    if (!response.ok) {
      return {
        status: 'failed',
        error: `resend_http_${response.status}`,
        providerIdempotencyKey: input.idempotencyKey,
      };
    }
    const data = await response.json().catch(() => null) as { id?: unknown } | null;
    if (!data || typeof data.id !== 'string' || !data.id) {
      return {
        status: 'failed',
        error: 'resend_invalid_response',
        providerIdempotencyKey: input.idempotencyKey,
      };
    }
    return {
      status: 'sent',
      providerMessageId: data.id,
      providerIdempotencyKey: input.idempotencyKey,
    };
  } catch {
    return {
      status: 'failed',
      error: 'resend_network_error',
      providerIdempotencyKey: input.idempotencyKey,
    };
  }
}

export interface BuildEditMailMessageInput {
  formTitle: string;
  answers: Array<{ label: string; value: unknown }>;
  trackingCode?: string | null;
  submitNumber?: string | null;
  pdfLink?: string | null;
  editUrl: string;
}

function answerText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const items = value
      .map((item) => (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' ? String(item).trim() : ''))
      .filter(Boolean);
    return items.length ? items.join('、') : null;
  }
  return null;
}

export function buildEditMailMessage(input: BuildEditMailMessageInput): { subject: string; text: string } {
  const receiptNumber = input.trackingCode?.trim() || input.submitNumber?.trim() || '（未発行）';
  const answerLines = input.answers.flatMap(({ label, value }) => {
    const rendered = answerText(value);
    const cleanLabel = label.replace(/[\r\n]+/g, ' ').trim();
    return rendered && cleanLabel ? [`${cleanLabel}: ${rendered}`] : [];
  });
  const lines = [
    `${input.formTitle} への回答を受け付けました。`,
    '',
    `受付番号: ${receiptNumber}`,
    '',
    '回答内容',
    ...(answerLines.length ? answerLines : ['（回答項目なし）']),
    '',
    ...(input.pdfLink?.trim() ? [`控えPDF: ${input.pdfLink.trim()}`, ''] : []),
    `編集用URL: ${input.editUrl}`,
    '',
    '内容を変更する場合は、上の編集用URLを開いてください。',
  ];
  return {
    subject: `【${input.formTitle}】回答の控えと編集用リンク`,
    text: lines.join('\n'),
  };
}
