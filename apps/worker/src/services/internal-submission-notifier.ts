import {
  getFormalooForm,
  getFriendById,
  getInternalFormNotificationSettings,
  getInternalFormSubmission,
  getLineAccountById,
  jstNow,
} from '@line-crm/db';
import { renderInternalSubmissionNotification } from '@line-crm/shared';
import { LineClient } from '@line-crm/line-sdk';
import { parseInternalFormDefinition } from './internal-form-runtime.js';
import { createInternalFormEditUrl } from './internal-form-edit.js';
import { sendEditMail, type EditMailSenderEnv } from './edit-mail-sender.js';

export interface InternalSubmissionNotificationEnv extends EditMailSenderEnv {
  DB: D1Database;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  FORMALOO_EDIT_TOKEN_SECRET?: string;
  WORKER_URL: string;
  WORKER_PUBLIC_URL?: string;
}

export type InternalSubmissionNotificationResult =
  | { status: 'sent'; channel: 'line' | 'email' }
  | { status: 'failed'; channel: 'line' | 'email'; reason: string }
  | { status: 'skipped'; reason: string };

const LINE_TEXT_MAX_CODE_UNITS = 5_000;
const LINE_PUSH_MAX_MESSAGES = 5;
const LINE_TRUNCATION_NOTICE = '\n…\n（回答が長いため、中間部分を省略しました）\n';

type LineTextMessage = { type: 'text'; text: string };

function chunkEnd(text: string, start: number, maxCodeUnits: number): number {
  let end = Math.min(text.length, start + maxCodeUnits);
  if (end < text.length) {
    const lastCodeUnit = text.charCodeAt(end - 1);
    if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
  }
  return end;
}

function splitLineText(text: string): LineTextMessage[] {
  const fullCapacity = LINE_TEXT_MAX_CODE_UNITS * LINE_PUSH_MAX_MESSAGES;
  if (text.length <= fullCapacity) {
    const messages: LineTextMessage[] = [];
    let cursor = 0;
    while (cursor < text.length) {
      const end = chunkEnd(text, cursor, LINE_TEXT_MAX_CODE_UNITS);
      messages.push({ type: 'text', text: text.slice(cursor, end) });
      cursor = end;
    }
    return messages;
  }

  const messages: LineTextMessage[] = [];
  let cursor = 0;
  for (let index = 0; index < LINE_PUSH_MAX_MESSAGES - 1; index += 1) {
    const end = chunkEnd(text, cursor, LINE_TEXT_MAX_CODE_UNITS);
    messages.push({ type: 'text', text: text.slice(cursor, end) });
    cursor = end;
  }

  const tailCapacity = LINE_TEXT_MAX_CODE_UNITS - LINE_TRUNCATION_NOTICE.length;
  let tailStart = Math.max(cursor, text.length - tailCapacity);
  const firstCodeUnit = text.charCodeAt(tailStart);
  if (firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff) tailStart += 1;
  messages.push({
    type: 'text',
    text: `${LINE_TRUNCATION_NOTICE}${text.slice(tailStart)}`,
  });
  return messages;
}

function redactEditLink(text: string, editUrl: string): string {
  return text.split(editUrl).join('[編集リンクを送信済み]');
}

function parseAnswers(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function respondentEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

async function logLineNotification(
  db: D1Database,
  friendId: string,
  lineAccountId: string | null,
  text: string,
): Promise<void> {
  await db.prepare(
    `INSERT INTO messages_log
       (id, friend_id, direction, message_type, content, delivery_type, source, line_account_id, created_at)
     VALUES (?, ?, 'outgoing', 'text', ?, 'push', 'internal_form_confirmation', ?, ?)`,
  ).bind(crypto.randomUUID(), friendId, text, lineAccountId, jstNow()).run();
}

/**
 * Deliver one internal-form confirmation using only persisted form/submission data.
 * No caller-provided address, LINE user id, or channel is accepted, so a caller cannot
 * redirect a respondent notification to a third party.
 */
export async function notifyInternalFormSubmission(
  env: InternalSubmissionNotificationEnv,
  input: { formId: string; submissionId: string },
): Promise<InternalSubmissionNotificationResult> {
  const [form, submission, settings] = await Promise.all([
    getFormalooForm(env.DB, input.formId),
    getInternalFormSubmission(env.DB, input.formId, input.submissionId),
    getInternalFormNotificationSettings(env.DB, input.formId),
  ]);
  if (!form || !submission || submission.form_id !== form.id) {
    return { status: 'skipped', reason: 'missing_submission' };
  }
  if (form.render_backend !== 'internal' || form.builder_status !== 'published') {
    return { status: 'skipped', reason: 'ineligible_form' };
  }
  if (!settings?.enabled) return { status: 'skipped', reason: 'disabled' };

  const definition = parseInternalFormDefinition(form.definition_json);
  const answers = parseAnswers(submission.answers_json);
  if (!definition.ok || !answers) return { status: 'skipped', reason: 'invalid_submission' };

  const editUrl = await createInternalFormEditUrl({
    publicBaseUrl: env.WORKER_PUBLIC_URL ?? env.WORKER_URL,
    formId: form.id,
    submissionId: submission.id,
    editLinkEpoch: settings.editLinkEpoch,
    secret: env.FORMALOO_EDIT_TOKEN_SECRET,
  });
  if (!editUrl) return { status: 'skipped', reason: 'edit_link_unavailable' };

  const origin = submission.origin_channel ?? 'embed';
  if (origin === 'invalid') return { status: 'skipped', reason: 'invalid_origin' };

  let displayName: string | null = null;
  let friend: Awaited<ReturnType<typeof getFriendById>> = null;
  if (origin === 'line') {
    if (!submission.friend_id) return { status: 'skipped', reason: 'missing_friend' };
    friend = await getFriendById(env.DB, submission.friend_id);
    if (!friend?.line_user_id || friend.is_following === 0) {
      return { status: 'skipped', reason: 'missing_friend' };
    }
    if (form.line_account_id && friend.line_account_id !== form.line_account_id) {
      return { status: 'skipped', reason: 'account_mismatch' };
    }
    displayName = friend.display_name;
  }

  const rendered = renderInternalSubmissionNotification({
    template: settings.messageTemplate,
    formTitle: form.title,
    displayName,
    fields: definition.definition.fields,
    answers,
    editUrl,
  });
  if (!rendered.ok) return { status: 'skipped', reason: 'invalid_template' };

  if (origin === 'line') {
    let accessToken = env.LINE_CHANNEL_ACCESS_TOKEN;
    if (friend!.line_account_id) {
      const account = await getLineAccountById(env.DB, friend!.line_account_id);
      if (!account || account.is_active !== 1 || !account.channel_access_token) {
        return { status: 'skipped', reason: 'missing_line_account' };
      }
      accessToken = account.channel_access_token;
    }
    const messages = splitLineText(rendered.text);
    try {
      await new LineClient(accessToken).pushMessage(friend!.line_user_id, messages);
    } catch {
      return { status: 'failed', channel: 'line', reason: 'line_push_failed' };
    }
    try {
      const safeLogText = splitLineText(redactEditLink(rendered.text, editUrl))
        .map((message) => message.text)
        .join('\n');
      await logLineNotification(env.DB, friend!.id, friend!.line_account_id, safeLogText);
    } catch (error) {
      console.error('internal form notification log failed:', error);
    }
    return { status: 'sent', channel: 'line' };
  }

  if (origin !== 'embed') return { status: 'skipped', reason: 'invalid_origin' };
  const recipientField = definition.definition.fields.find(
    (field) => field.id === settings.recipientEmailFieldId && field.type === 'email',
  );
  if (!recipientField) return { status: 'skipped', reason: 'invalid_recipient_field' };
  const recipient = respondentEmail(answers[recipientField.id]);
  if (!recipient) return { status: 'skipped', reason: 'invalid_recipient' };

  const result = await sendEditMail(env, {
    to: recipient,
    subject: `【${form.title}】回答内容のご確認`,
    text: rendered.text,
    idempotencyKey: `internal-form-notification/${submission.id}`,
  });
  if (result.status === 'sent') return { status: 'sent', channel: 'email' };
  if (result.status === 'failed') return { status: 'failed', channel: 'email', reason: result.error };
  return { status: 'skipped', reason: result.reason };
}
