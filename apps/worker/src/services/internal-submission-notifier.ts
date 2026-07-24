import {
  claimInternalFormExternalEditNotification,
  getFormalooForm,
  getFriendById,
  getInternalFormNotificationSettings,
  getInternalFormSubmission,
  getLineAccountById,
  jstNow,
  type InternalFormExternalEditChange,
} from '@line-crm/db';
import {
  formatInternalSubmissionNotificationAnswer,
  getInternalSubmissionNotificationAnswerFields,
  renderInternalSubmissionNotification,
} from '@line-crm/shared';
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

export type InternalSubmissionChannelResult =
  | { status: 'sent' }
  | { status: 'failed'; reason: string }
  | { status: 'skipped'; reason: string };

export interface InternalSubmissionNotificationResult {
  line: InternalSubmissionChannelResult;
  email: InternalSubmissionChannelResult;
}

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

function splitLineText(text: string, editUrl?: string): LineTextMessage[] {
  if (text.length <= LINE_TEXT_MAX_CODE_UNITS) return [{ type: 'text', text }];

  if (editUrl && text.includes(editUrl)) {
    const content = text.split(editUrl).join('');
    const editLinkSuffix = `\n\n編集リンク\n${editUrl}`;
    const finalContentCapacity = LINE_TEXT_MAX_CODE_UNITS - editLinkSuffix.length;
    const messages: LineTextMessage[] = [];
    let cursor = 0;

    while (
      content.length - cursor > finalContentCapacity
      && messages.length < LINE_PUSH_MAX_MESSAGES - 1
    ) {
      const end = chunkEnd(content, cursor, LINE_TEXT_MAX_CODE_UNITS);
      messages.push({ type: 'text', text: content.slice(cursor, end) });
      cursor = end;
    }

    if (content.length - cursor <= finalContentCapacity) {
      messages.push({ type: 'text', text: `${content.slice(cursor)}${editLinkSuffix}` });
      return messages;
    }

    const tailCapacity = finalContentCapacity - LINE_TRUNCATION_NOTICE.length;
    let tailStart = Math.max(cursor, content.length - tailCapacity);
    const firstCodeUnit = content.charCodeAt(tailStart);
    if (firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff) tailStart += 1;
    messages.push({
      type: 'text',
      text: `${LINE_TRUNCATION_NOTICE}${content.slice(tailStart)}${editLinkSuffix}`,
    });
    return messages;
  }

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

function bothSkipped(reason: string): InternalSubmissionNotificationResult {
  return {
    line: { status: 'skipped', reason },
    email: { status: 'skipped', reason },
  };
}

type ResolvedFriend = NonNullable<Awaited<ReturnType<typeof getFriendById>>>;

type LineTarget =
  | { ok: true; friend: ResolvedFriend }
  | { ok: false; reason: string };

type LineAccessToken =
  | { ok: true; accessToken: string }
  | { ok: false; reason: 'missing_line_account' };

async function resolveLineTarget(
  env: InternalSubmissionNotificationEnv,
  form: { line_account_id: string | null },
  submission: { origin_channel: string | null; friend_id: string | null },
): Promise<LineTarget> {
  if ((submission.origin_channel ?? 'embed') === 'invalid') {
    return { ok: false, reason: 'invalid_origin' };
  }
  if (!submission.friend_id) return { ok: false, reason: 'missing_friend' };

  const friend = await getFriendById(env.DB, submission.friend_id);
  if (!friend?.line_user_id || friend.is_following !== 1) {
    return { ok: false, reason: 'missing_friend' };
  }
  if (friend.line_account_id !== form.line_account_id) {
    return { ok: false, reason: 'account_mismatch' };
  }
  return { ok: true, friend };
}

async function resolveLineAccessToken(
  env: InternalSubmissionNotificationEnv,
  friend: ResolvedFriend,
): Promise<LineAccessToken> {
  if (!friend.line_account_id) return { ok: true, accessToken: env.LINE_CHANNEL_ACCESS_TOKEN };

  const account = await getLineAccountById(env.DB, friend.line_account_id);
  if (!account || account.is_active !== 1 || !account.channel_access_token) {
    return { ok: false, reason: 'missing_line_account' };
  }
  return { ok: true, accessToken: account.channel_access_token };
}

async function deliverLine(
  env: InternalSubmissionNotificationEnv,
  friend: ResolvedFriend,
  text: string,
  editUrl: string,
): Promise<InternalSubmissionChannelResult> {
  const token = await resolveLineAccessToken(env, friend);
  if (!token.ok) return { status: 'skipped', reason: token.reason };

  const messages = splitLineText(text, editUrl);
  try {
    await new LineClient(token.accessToken).pushMessage(friend.line_user_id, messages);
  } catch {
    return { status: 'failed', reason: 'line_push_failed' };
  }

  try {
    const safeLogText = redactEditLink(messages.map((message) => message.text).join('\n'), editUrl);
    await logLineNotification(env.DB, friend.id, friend.line_account_id, safeLogText);
  } catch {
    console.error('internal form notification log failed');
  }
  return { status: 'sent' };
}

async function deliverEmail(
  env: InternalSubmissionNotificationEnv,
  input: {
    formTitle: string;
    submissionId: string;
    lineAccountId: string | null;
    recipientEmailFieldId: string | null;
    fields: Parameters<typeof getInternalSubmissionNotificationAnswerFields>[0];
    answers: Record<string, unknown>;
    text: string;
  },
): Promise<InternalSubmissionChannelResult> {
  if (!input.recipientEmailFieldId) return { status: 'skipped', reason: 'no_email_field' };

  const recipientField = getInternalSubmissionNotificationAnswerFields(input.fields).find(
    (field) => field.id === input.recipientEmailFieldId && field.type === 'email',
  );
  if (!recipientField) return { status: 'skipped', reason: 'invalid_recipient_field' };

  const recipient = respondentEmail(input.answers[recipientField.id]);
  if (!recipient) return { status: 'skipped', reason: 'invalid_recipient' };

  const result = await sendEditMail(env, {
    to: recipient,
    subject: `【${input.formTitle}】回答内容のご確認`,
    text: input.text,
    idempotencyKey: `internal-form-notification/${input.submissionId}`,
    lineAccountId: input.lineAccountId,
  });
  if (result.status === 'sent') return { status: 'sent' };
  if (result.status === 'failed') return { status: 'failed', reason: result.error };
  return { status: 'skipped', reason: result.reason };
}

/**
 * Deliver internal-form confirmations using only persisted form/submission data.
 * No caller-provided address, LINE user id, or channel is accepted, so a caller cannot
 * redirect a respondent notification to a third party.
 * LINE and email are evaluated independently and may both send for one submission.
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
    return bothSkipped('missing_submission');
  }
  if (form.render_backend !== 'internal' || form.builder_status !== 'published') {
    return bothSkipped('ineligible_form');
  }
  if (!settings?.enabled) return bothSkipped('disabled');

  const definition = parseInternalFormDefinition(form.definition_json);
  const answers = parseAnswers(submission.answers_json);
  if (!definition.ok || !answers) return bothSkipped('invalid_submission');

  const editUrl = await createInternalFormEditUrl({
    publicBaseUrl: env.WORKER_PUBLIC_URL ?? env.WORKER_URL,
    formId: form.id,
    submissionId: submission.id,
    editLinkEpoch: settings.editLinkEpoch,
    secret: env.FORMALOO_EDIT_TOKEN_SECRET,
  });
  if (!editUrl) return bothSkipped('edit_link_unavailable');

  const lineTarget = await resolveLineTarget(env, form, submission);

  const rendered = renderInternalSubmissionNotification({
    template: settings.messageTemplate,
    formTitle: form.title,
    displayName: lineTarget.ok ? lineTarget.friend.display_name : null,
    fields: definition.definition.fields,
    answers,
    editUrl,
  });
  if (!rendered.ok) return bothSkipped('invalid_template');

  const line = lineTarget.ok
    ? await deliverLine(env, lineTarget.friend, rendered.text, editUrl)
    : { status: 'skipped' as const, reason: lineTarget.reason };
  const email = await deliverEmail(env, {
    formTitle: form.title,
    submissionId: submission.id,
    lineAccountId: form.line_account_id,
    recipientEmailFieldId: settings.recipientEmailFieldId,
    fields: definition.definition.fields,
    answers,
    text: rendered.text,
  });

  return { line, email };
}

export type InternalFormExternalEditNotificationResult =
  | { status: 'sent'; channel: 'line' | 'email' }
  | { status: 'failed'; channel: 'line' | 'email'; reason: string }
  | { status: 'skipped'; reason: string };

const EXTERNAL_EDIT_MAX_CHANGES = 12;
const EXTERNAL_EDIT_MAX_LABEL_CODE_UNITS = 60;
const EXTERNAL_EDIT_MAX_VALUE_CODE_UNITS = 120;

function parseExternalEditChanges(value: string | null): InternalFormExternalEditChange[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((change): change is InternalFormExternalEditChange => {
      if (!change || typeof change !== 'object' || Array.isArray(change)) return false;
      const record = change as Record<string, unknown>;
      return typeof record.fieldId === 'string'
        && record.fieldId.length > 0
        && Object.prototype.hasOwnProperty.call(record, 'before')
        && Object.prototype.hasOwnProperty.call(record, 'after');
    });
  } catch {
    return [];
  }
}

function truncateExternalEditText(value: string, maxCodeUnits: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxCodeUnits) return normalized;
  return `${normalized.slice(0, chunkEnd(normalized, 0, maxCodeUnits - 1))}…`;
}

function renderExternalEditSummary(
  changes: readonly InternalFormExternalEditChange[],
  definition: ReturnType<typeof parseInternalFormDefinition> & { ok: true },
): string | null {
  const fields = new Map(
    getInternalSubmissionNotificationAnswerFields(definition.definition.fields)
      .map((field) => [field.id, field]),
  );
  const eligibleChanges = changes.flatMap((change) => {
    const field = fields.get(change.fieldId);
    return field ? [{ change, field }] : [];
  });
  if (eligibleChanges.length === 0) return null;

  const displayed = eligibleChanges.slice(0, EXTERNAL_EDIT_MAX_CHANGES);
  const lines = displayed.map(({ change, field }) => {
    const label = truncateExternalEditText(
      field.label.trim() || field.id,
      EXTERNAL_EDIT_MAX_LABEL_CODE_UNITS,
    );
    const before = truncateExternalEditText(
      formatInternalSubmissionNotificationAnswer(change.before, field),
      EXTERNAL_EDIT_MAX_VALUE_CODE_UNITS,
    );
    const after = truncateExternalEditText(
      formatInternalSubmissionNotificationAnswer(change.after, field),
      EXTERNAL_EDIT_MAX_VALUE_CODE_UNITS,
    );
    return `・${label}:「${before}」→「${after}」`;
  });
  if (eligibleChanges.length > displayed.length) {
    lines.push(`・ほか${eligibleChanges.length - displayed.length}件の変更`);
  }
  return [
    'ご回答の編集を受け付けました。',
    ...lines,
    '以上の内容で更新済みです。',
  ].join('\n');
}

export async function notifyInternalFormExternalEdit(
  env: InternalSubmissionNotificationEnv,
  input: {
    formId: string;
    submissionId: string;
    externalEditedAt: string;
    expectedEditVersion: number;
  },
): Promise<InternalFormExternalEditNotificationResult> {
  const [form, submission, settings] = await Promise.all([
    getFormalooForm(env.DB, input.formId),
    getInternalFormSubmission(env.DB, input.formId, input.submissionId),
    getInternalFormNotificationSettings(env.DB, input.formId),
  ]);
  if (
    !form
    || !submission
    || submission.form_id !== form.id
    || form.deleted === 1
    || form.render_backend !== 'internal'
    || form.builder_status !== 'published'
    || submission.external_edit_source !== 'edit_link'
    || submission.external_edited_at !== input.externalEditedAt
    || submission.edit_version !== input.expectedEditVersion
  ) {
    return { status: 'skipped', reason: 'ineligible_edit' };
  }

  const changes = parseExternalEditChanges(submission.external_edit_changes_json);
  if (changes.length === 0) return { status: 'skipped', reason: 'no_changes' };
  const definition = parseInternalFormDefinition(form.definition_json);
  if (!definition.ok) return { status: 'skipped', reason: 'invalid_definition' };

  const lineTarget = await resolveLineTarget(env, form, submission);
  const text = renderExternalEditSummary(changes, definition);
  if (!text) return { status: 'skipped', reason: 'no_changes' };
  if (lineTarget.ok) {
    const token = await resolveLineAccessToken(env, lineTarget.friend);
    if (!token.ok) return { status: 'skipped', reason: token.reason };
    const claimed = await claimInternalFormExternalEditNotification(env.DB, {
      ...input,
    });
    if (!claimed) return { status: 'skipped', reason: 'duplicate' };

    try {
      await new LineClient(token.accessToken).pushTextMessage(
        lineTarget.friend.line_user_id,
        text,
      );
      return { status: 'sent', channel: 'line' };
    } catch {
      console.error('internal form edit LINE notification failed');
      return { status: 'failed', channel: 'line', reason: 'line_push_failed' };
    }
  }

  if (!settings?.recipientEmailFieldId) {
    return { status: 'skipped', reason: 'no_email_field' };
  }
  const recipientField = getInternalSubmissionNotificationAnswerFields(
    definition.definition.fields,
  ).find((field) => field.id === settings.recipientEmailFieldId && field.type === 'email');
  if (!recipientField) return { status: 'skipped', reason: 'invalid_recipient_field' };
  const answers = parseAnswers(submission.answers_json);
  if (!answers) return { status: 'skipped', reason: 'invalid_answers' };
  const recipient = respondentEmail(answers[recipientField.id]);
  if (!recipient) return { status: 'skipped', reason: 'invalid_recipient' };

  const claimed = await claimInternalFormExternalEditNotification(env.DB, {
    ...input,
  });
  if (!claimed) return { status: 'skipped', reason: 'duplicate' };
  let result: Awaited<ReturnType<typeof sendEditMail>>;
  try {
    result = await sendEditMail(env, {
      to: recipient,
      subject: `【${form.title}】回答の編集を受け付けました`,
      text,
      idempotencyKey:
        `internal-form-external-edit/${submission.id}/${input.externalEditedAt}/${input.expectedEditVersion}`,
      lineAccountId: form.line_account_id,
    });
  } catch {
    console.error('internal form edit email notification failed');
    return { status: 'failed', channel: 'email', reason: 'email_send_failed' };
  }
  if (result.status === 'sent') return { status: 'sent', channel: 'email' };
  if (result.status === 'failed') {
    console.error('internal form edit email notification failed');
    return { status: 'failed', channel: 'email', reason: result.error };
  }
  return { status: 'skipped', reason: result.reason };
}
