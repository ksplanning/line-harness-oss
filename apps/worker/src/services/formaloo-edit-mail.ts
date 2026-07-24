import {
  claimEditMailAttempt,
  claimEditMailSend,
  getEditMailSend,
  getEmailSenderSettings,
  getFormalooFieldMap,
  getFormalooForm,
  getFormalooSubmission,
  listRetryableEditMailSends,
  markEditMailPreSendSkipped,
  recordEditMailResult,
} from '@line-crm/db';
import {
  buildEditMailMessage,
  sendEditMail,
  type EditMailSenderEnv,
  type SendEditMailInput,
  type SendEditMailResult,
} from './edit-mail-sender.js';
import { editTokenExp, signEditToken } from './formaloo-edit-token.js';
import { resolveResendApiKey } from './resend-domains.js';

const MAX_ATTEMPTS = 3;
const SWEEP_LIMIT = 20;

export interface FormalooEditMailEnv extends EditMailSenderEnv {
  DB: D1Database;
  FORMALOO_EDIT_TOKEN_SECRET?: string;
  WORKER_PUBLIC_URL?: string;
}

type SendFunction = (
  env: EditMailSenderEnv,
  input: SendEditMailInput,
) => Promise<SendEditMailResult>;

export interface FormalooEditMailDependencies {
  send?: SendFunction;
}

interface ProcessFormalooEditMailInput {
  submissionId: string;
  mode: 'initial' | 'retry';
  expectedAttemptCount?: number;
}

export type ProcessFormalooEditMailResult =
  | { status: 'sent' }
  | { status: 'failed'; reason: string }
  | { status: 'skipped'; reason: string };

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** Formaloo が submit-time に返した3キーだけを whitelist 抽出する。 */
export function extractFormalooReceiptMetadata(payload: unknown): {
  trackingCode: string | null;
  submitNumber: string | null;
  pdfLink: string | null;
} {
  const root = objectValue(payload) ?? {};
  const data = objectValue(root.data) ?? {};
  return {
    trackingCode: stringValue(root.tracking_code, data.tracking_code),
    submitNumber: stringValue(root.submit_number, data.submit_number),
    pdfLink: stringValue(root.pdf_link, data.pdf_link),
  };
}

function configuredPublicBase(env: FormalooEditMailEnv):
  | { ok: true; base: string }
  | { ok: false; reason: string } {
  if (env.FORM_EDIT_MAIL_ENABLED !== 'true') return { ok: false, reason: 'disabled' };
  if (!env.FORM_EDIT_MAIL_FROM?.trim()) return { ok: false, reason: 'missing_from' };
  if (!env.FORMALOO_EDIT_TOKEN_SECRET?.trim()) return { ok: false, reason: 'missing_edit_secret' };
  const configured = env.WORKER_PUBLIC_URL?.trim();
  if (!configured) return { ok: false, reason: 'missing_public_url' };
  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return { ok: false, reason: 'invalid_public_url' };
    return { ok: true, base: configured.replace(/\/+$/, '') };
  } catch {
    return { ok: false, reason: 'invalid_public_url' };
  }
}

async function hasResendApiKey(
  env: FormalooEditMailEnv,
  lineAccountId: string | null,
): Promise<boolean> {
  let accountApiKey: string | null = null;
  if (lineAccountId) {
    try {
      accountApiKey = (await getEmailSenderSettings(env.DB, lineAccountId))?.resendApiKey ?? null;
    } catch {
      accountApiKey = null;
    }
  }
  return resolveResendApiKey(env, accountApiKey) !== null;
}

function parseAnswers(json: string): Record<string, unknown> | null {
  try {
    return objectValue(JSON.parse(json));
  } catch {
    return null;
  }
}

function recipientEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function finishPreSendSkip(
  db: D1Database,
  input: ProcessFormalooEditMailInput,
  reason: string,
): Promise<ProcessFormalooEditMailResult> {
  if (input.mode !== 'retry') return { status: 'skipped', reason };
  const outbox = await getEditMailSend(db, input.submissionId);
  if (!outbox) return { status: 'skipped', reason: 'missing_outbox' };
  const marked = await markEditMailPreSendSkipped(db, {
    submissionId: input.submissionId,
    expectedAttemptCount: input.expectedAttemptCount ?? outbox.attempt_count,
    error: reason,
  });
  return marked
    ? { status: 'skipped', reason }
    : { status: 'skipped', reason: 'attempt_not_claimed' };
}

async function finishFailedAttempt(
  db: D1Database,
  submissionId: string,
  error: string,
  providerIdempotencyKey: string,
): Promise<ProcessFormalooEditMailResult> {
  await recordEditMailResult(db, {
    submissionId,
    status: 'failed',
    error,
    providerIdempotencyKey,
    attemptClaimed: true,
  });
  return { status: 'failed', reason: error };
}

export async function processFormalooEditMail(
  env: FormalooEditMailEnv,
  input: ProcessFormalooEditMailInput,
  deps: FormalooEditMailDependencies = {},
): Promise<ProcessFormalooEditMailResult> {
  const runtime = configuredPublicBase(env);
  if (!runtime.ok) return { status: 'skipped', reason: runtime.reason };

  const submission = await getFormalooSubmission(env.DB, input.submissionId);
  if (!submission) return finishPreSendSkip(env.DB, input, 'missing_submission');
  const form = await getFormalooForm(env.DB, submission.form_id);
  if (!form) return finishPreSendSkip(env.DB, input, 'missing_form');
  if (!await hasResendApiKey(env, form.line_account_id)) {
    return finishPreSendSkip(env.DB, input, 'missing_api_key');
  }
  if (submission.verified !== 1 || form.builder_status !== 'published') {
    return finishPreSendSkip(env.DB, input, 'ineligible_submission');
  }
  if (form.allow_post_edit !== 1 || form.allow_edit_mail !== 1) {
    return finishPreSendSkip(env.DB, input, 'form_disabled');
  }
  const explicitSlug = form.edit_mail_field_slug?.trim();
  if (!explicitSlug) return finishPreSendSkip(env.DB, input, 'missing_recipient_slug');

  const fieldMap = await getFormalooFieldMap(env.DB, form.id);
  const recipientField = fieldMap.find(
    (field) => field.formaloo_field_slug === explicitSlug && field.field_type === 'email',
  );
  if (!recipientField) return finishPreSendSkip(env.DB, input, 'invalid_recipient_slug');
  const answers = parseAnswers(submission.answers_json);
  if (!answers) return finishPreSendSkip(env.DB, input, 'invalid_answers');
  const recipient = recipientEmail(answers[explicitSlug]);
  if (!recipient) return finishPreSendSkip(env.DB, input, 'invalid_recipient');

  const recipientHash = await sha256Hex(recipient.toLowerCase());
  const generatedProviderKey = `formaloo-edit-mail/${(await sha256Hex(submission.id)).slice(0, 40)}`;
  let outbox = await getEditMailSend(env.DB, submission.id);
  if (input.mode === 'initial') {
    const claimed = await claimEditMailSend(env.DB, {
      submissionId: submission.id,
      formId: form.id,
      recipientHash,
      providerIdempotencyKey: generatedProviderKey,
    });
    if (!claimed) return { status: 'skipped', reason: 'duplicate' };
    outbox = await getEditMailSend(env.DB, submission.id);
  }
  if (!outbox) return { status: 'skipped', reason: 'missing_outbox' };

  if (outbox.recipient_hash !== recipientHash) {
    if (input.mode === 'retry') return finishPreSendSkip(env.DB, input, 'recipient_changed');
    await recordEditMailResult(env.DB, {
      submissionId: submission.id,
      status: 'skipped',
      error: 'recipient_changed',
      attemptClaimed: true,
    });
    return { status: 'skipped', reason: 'recipient_changed' };
  }

  const providerIdempotencyKey = outbox.provider_idempotency_key ?? generatedProviderKey;
  const expectedAttemptCount = input.mode === 'retry'
    ? (input.expectedAttemptCount ?? outbox.attempt_count)
    : 0;
  const attemptClaimed = await claimEditMailAttempt(env.DB, {
    submissionId: submission.id,
    expectedAttemptCount,
    maxAttempts: MAX_ATTEMPTS,
    providerIdempotencyKey,
  });
  if (!attemptClaimed) return { status: 'skipped', reason: 'attempt_not_claimed' };

  const requestedAtSec = Math.floor(new Date(outbox.requested_at).getTime() / 1000);
  if (!Number.isFinite(requestedAtSec)) {
    return finishFailedAttempt(env.DB, submission.id, 'invalid_requested_at', providerIdempotencyKey);
  }
  let token: string | null = null;
  try {
    token = await signEditToken({
      formId: form.id,
      rowRef: submission.id,
      epoch: form.edit_link_epoch,
      exp: editTokenExp(requestedAtSec),
    }, env.FORMALOO_EDIT_TOKEN_SECRET);
  } catch {
    token = null;
  }
  if (!token) return finishFailedAttempt(env.DB, submission.id, 'token_unavailable', providerIdempotencyKey);

  const receiptAnswers = [...fieldMap]
    .sort((a, b) => a.position - b.position)
    .flatMap((field) => field.formaloo_field_slug && Object.hasOwn(answers, field.formaloo_field_slug)
      ? [{ label: field.label, value: answers[field.formaloo_field_slug] }]
      : []);
  const message = buildEditMailMessage({
    formTitle: form.title,
    answers: receiptAnswers,
    trackingCode: submission.tracking_code,
    submitNumber: submission.submit_number,
    pdfLink: submission.pdf_link,
    editUrl: `${runtime.base}/fe/${encodeURIComponent(token)}`,
  });

  const send = deps.send ?? sendEditMail;
  let result: SendEditMailResult;
  try {
    result = await send(env, {
      to: recipient,
      subject: message.subject,
      text: message.text,
      idempotencyKey: providerIdempotencyKey,
      lineAccountId: form.line_account_id,
    });
  } catch {
    result = { status: 'failed', error: 'resend_network_error', providerIdempotencyKey };
  }

  if (result.status === 'sent') {
    await recordEditMailResult(env.DB, {
      submissionId: submission.id,
      status: 'sent',
      providerMessageId: result.providerMessageId,
      providerIdempotencyKey: result.providerIdempotencyKey,
      attemptClaimed: true,
    });
    return { status: 'sent' };
  }
  if (result.status === 'failed') {
    return finishFailedAttempt(env.DB, submission.id, result.error, result.providerIdempotencyKey);
  }
  await recordEditMailResult(env.DB, {
    submissionId: submission.id,
    status: 'skipped',
    error: `sender_${result.reason}`,
    attemptClaimed: true,
  });
  return { status: 'skipped', reason: result.reason };
}

export async function runFormalooEditMailOutbox(
  env: FormalooEditMailEnv,
  deps: FormalooEditMailDependencies = {},
): Promise<{ attempted: number; sent: number; failed: number; skipped: number }> {
  if (!configuredPublicBase(env).ok) return { attempted: 0, sent: 0, failed: 0, skipped: 0 };
  const rows = await listRetryableEditMailSends(env.DB, { maxAttempts: MAX_ATTEMPTS, limit: SWEEP_LIMIT });
  const summary = { attempted: rows.length, sent: 0, failed: 0, skipped: 0 };
  for (const row of rows) {
    const result = await processFormalooEditMail(env, {
      submissionId: row.submission_id,
      mode: 'retry',
      expectedAttemptCount: row.attempt_count,
    }, deps);
    summary[result.status] += 1;
  }
  return summary;
}
