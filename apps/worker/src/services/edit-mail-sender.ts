export interface EditMailSenderEnv {
  FORM_EDIT_MAIL_ENABLED?: string;
  RESEND_API_KEY?: string;
  FORM_EDIT_MAIL_FROM?: string;
}

export interface SendEditMailInput {
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
}

export type SendEditMailResult =
  | { status: 'skipped'; reason: 'disabled' | 'missing_api_key' | 'missing_from' }
  | { status: 'sent'; providerMessageId: string; providerIdempotencyKey: string }
  | { status: 'failed'; error: string; providerIdempotencyKey: string };

export async function sendEditMail(
  env: EditMailSenderEnv,
  input: SendEditMailInput,
  fetcher: typeof fetch = fetch,
): Promise<SendEditMailResult> {
  if (env.FORM_EDIT_MAIL_ENABLED !== 'true') return { status: 'skipped', reason: 'disabled' };
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey) return { status: 'skipped', reason: 'missing_api_key' };
  const from = env.FORM_EDIT_MAIL_FROM?.trim();
  if (!from) return { status: 'skipped', reason: 'missing_from' };

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
