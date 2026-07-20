import { Hono } from 'hono';
import {
  addTagToFriend,
  createInternalFormSubmission,
  enrollFriendInScenario,
  getFormalooForm,
  getFriendById,
  type FormalooForm,
} from '@line-crm/db';
import { verifyFriendToken } from '../services/formaloo-friend-token.js';
import {
  parseInternalFormDefinition,
  validateInternalFormAnswers,
  type InternalAnswerInput,
  type InternalFormDefinition,
  type InternalFormField,
} from '../services/internal-form-runtime.js';
import type { Env } from '../index.js';

export const internalFormsPublic = new Hono<Env>();

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shell(title: string, content: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="referrer" content="no-referrer">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17202a; background: #f4f6f8; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: max(20px, env(safe-area-inset-top)) 16px max(28px, env(safe-area-inset-bottom)); }
    main { width: min(100%, 640px); margin: 0 auto; background: #fff; border-radius: 16px; padding: 24px 18px; box-shadow: 0 8px 28px rgba(18, 38, 63, .08); }
    h1 { margin: 0 0 8px; font-size: clamp(1.45rem, 5vw, 2rem); line-height: 1.3; }
    .description { margin: 0 0 24px; color: #52606d; white-space: pre-wrap; }
    .field { margin: 0 0 22px; padding: 0; border: 0; }
    .label, legend { display: block; width: 100%; margin: 0 0 8px; font-weight: 700; }
    .required { color: #b42318; font-size: .8rem; margin-left: 6px; }
    .help { margin: -2px 0 8px; color: #667085; font-size: .9rem; white-space: pre-wrap; }
    input, textarea, select, button { width: 100%; font: inherit; }
    input, textarea, select { min-height: 48px; border: 1px solid #cbd5e1; border-radius: 10px; padding: 11px 12px; background: #fff; color: inherit; }
    textarea { min-height: 120px; resize: vertical; }
    .option { display: flex; align-items: flex-start; gap: 10px; margin: 10px 0; font-weight: 400; }
    .option input { width: 22px; min-height: 22px; margin: 0; flex: 0 0 22px; }
    button { min-height: 52px; border: 0; border-radius: 12px; background: #06c755; color: #fff; font-weight: 800; cursor: pointer; }
    .errors { margin: 0 0 20px; padding: 12px 14px; border-radius: 10px; background: #fef3f2; color: #b42318; }
    .complete { text-align: center; padding-block: 42px; }
    @media (min-width: 600px) { main { padding: 36px; } }
  </style>
</head>
<body><main>${content}</main></body>
</html>`;
}

function requiredMark(field: InternalFormField): string {
  return field.required ? '<span class="required">必須</span>' : '';
}

function helpText(field: InternalFormField): string {
  return field.config.description
    ? `<p class="help">${escapeHtml(field.config.description)}</p>`
    : '';
}

function renderField(field: InternalFormField, index: number): string {
  const name = `a_${index}`;
  const id = `field-${index}`;
  const required = field.required ? ' required' : '';
  const maxLength = field.config.maxLength !== undefined ? ` maxlength="${field.config.maxLength}"` : '';

  if (field.type === 'textarea') {
    return `<div class="field"><label class="label" for="${id}">${escapeHtml(field.label)}${requiredMark(field)}</label>${helpText(field)}<textarea id="${id}" name="${name}"${required}${maxLength}></textarea></div>`;
  }
  if (field.type === 'choice' || field.type === 'multiple_select') {
    const inputType = field.type === 'choice' ? 'radio' : 'checkbox';
    // `required` on every checkbox means every option is mandatory. The server validates
    // multiple_select as one group, while radio can safely use the native group constraint.
    const optionRequired = field.type === 'choice' ? required : '';
    const options = (field.config.choices ?? []).map((choice) =>
      `<label class="option"><input type="${inputType}" name="${name}" value="${escapeHtml(choice)}"${optionRequired}><span>${escapeHtml(choice)}</span></label>`,
    ).join('');
    return `<fieldset class="field"><legend>${escapeHtml(field.label)}${requiredMark(field)}</legend>${helpText(field)}${options}</fieldset>`;
  }
  if (field.type === 'dropdown') {
    const options = (field.config.choices ?? []).map((choice) =>
      `<option value="${escapeHtml(choice)}">${escapeHtml(choice)}</option>`,
    ).join('');
    return `<div class="field"><label class="label" for="${id}">${escapeHtml(field.label)}${requiredMark(field)}</label>${helpText(field)}<select id="${id}" name="${name}"${required}><option value="">選択してください</option>${options}</select></div>`;
  }

  const inputType = field.type === 'phone' ? 'tel' : field.type;
  const inputMode = field.type === 'number' ? ' inputmode="decimal"' : field.type === 'phone' ? ' inputmode="tel"' : '';
  return `<div class="field"><label class="label" for="${id}">${escapeHtml(field.label)}${requiredMark(field)}</label>${helpText(field)}<input type="${inputType}" id="${id}" name="${name}"${required}${maxLength}${inputMode}></div>`;
}

function renderFormPage(
  form: FormalooForm,
  definition: InternalFormDefinition,
  friendToken: string | null,
  error?: string,
): string {
  const hidden = friendToken
    ? `<input type="hidden" name="fr_id" value="${escapeHtml(friendToken)}">`
    : '';
  const fields = definition.fields.map(renderField).join('');
  const errorHtml = error ? `<div class="errors" role="alert">${escapeHtml(error)}</div>` : '';
  return shell(form.title, `
    <h1>${escapeHtml(form.title)}</h1>
    ${form.description ? `<p class="description">${escapeHtml(form.description)}</p>` : ''}
    ${errorHtml}
    <form method="post" action="/f/${encodeURIComponent(form.id)}">
      ${hidden}${fields}
      <button type="submit">${escapeHtml(definition.buttonText ?? '送信する')}</button>
    </form>`);
}

function renderCompletion(form: FormalooForm, definition: InternalFormDefinition): string {
  const message = definition.successMessage ?? form.submit_message ?? '送信ありがとうございました';
  return shell(form.title, `<section class="complete"><h1>${escapeHtml(message)}</h1></section>`);
}

function renderUnavailable(status: 404 | 422 | 500, message: string): Response {
  return new Response(shell('フォーム', `<section class="complete"><h1>${escapeHtml(message)}</h1></section>`), {
    status,
    headers: { 'Content-Type': 'text/html; charset=UTF-8' },
  });
}

async function loadRuntimeForm(db: D1Database, formId: string): Promise<
  | { ok: true; form: FormalooForm; definition: InternalFormDefinition }
  | { ok: false; status: 404 | 422; message: string }
> {
  const form = await getFormalooForm(db, formId);
  if (!form || form.deleted || form.render_backend !== 'internal' || form.builder_status !== 'published') {
    return { ok: false, status: 404, message: 'このフォームは現在ご利用いただけません' };
  }
  const parsed = parseInternalFormDefinition(form.definition_json);
  if (!parsed.ok) return { ok: false, status: 422, message: parsed.error };
  return { ok: true, form, definition: parsed.definition };
}

function stringInputs(body: Record<string, string | File | (string | File)[]>): InternalAnswerInput {
  const result: InternalAnswerInput = Object.create(null) as InternalAnswerInput;
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string') result[key] = value;
    else if (Array.isArray(value)) result[key] = value.filter((item): item is string => typeof item === 'string');
  }
  return result;
}

internalFormsPublic.get('/f/:formId', async (c) => {
  try {
    const runtime = await loadRuntimeForm(c.env.DB, c.req.param('formId'));
    if (!runtime.ok) return renderUnavailable(runtime.status, runtime.message);
    const rawToken = c.req.query('fr_id') ?? null;
    const verified = await verifyFriendToken(rawToken, c.env.FORMALOO_FRIEND_TOKEN_SECRET);
    return c.html(renderFormPage(runtime.form, runtime.definition, verified ? rawToken : null));
  } catch (error) {
    console.error('GET /f/:formId error:', error);
    return renderUnavailable(500, 'フォームの読み込みに失敗しました');
  }
});

internalFormsPublic.post('/f/:formId', async (c) => {
  try {
    const runtime = await loadRuntimeForm(c.env.DB, c.req.param('formId'));
    if (!runtime.ok) return renderUnavailable(runtime.status, runtime.message);
    const parsedBody = await c.req.parseBody({ all: true }).catch(() => ({}));
    const body = stringInputs(parsedBody);
    const validation = validateInternalFormAnswers(runtime.definition.fields, body);
    const rawToken = typeof body.fr_id === 'string' ? body.fr_id : null;
    const verifiedFriendId = await verifyFriendToken(rawToken, c.env.FORMALOO_FRIEND_TOKEN_SECRET);

    if (!validation.ok) {
      return c.html(
        renderFormPage(runtime.form, runtime.definition, verifiedFriendId ? rawToken : null, validation.error),
        400,
      );
    }

    const friend = verifiedFriendId ? await getFriendById(c.env.DB, verifiedFriendId) : null;
    const friendId = friend?.id ?? null;
    await createInternalFormSubmission(c.env.DB, {
      formId: runtime.form.id,
      friendId,
      answers: validation.answers,
    });

    if (friendId) {
      const effects: Promise<unknown>[] = [];
      if (runtime.form.on_submit_tag_id) {
        effects.push(addTagToFriend(c.env.DB, friendId, runtime.form.on_submit_tag_id));
      }
      if (runtime.form.on_submit_scenario_id) {
        effects.push(enrollFriendInScenario(c.env.DB, friendId, runtime.form.on_submit_scenario_id));
      }
      const settled = await Promise.allSettled(effects);
      for (const result of settled) {
        if (result.status === 'rejected') console.error('internal form post-processing failed:', result.reason);
      }
    }

    return c.html(renderCompletion(runtime.form, runtime.definition));
  } catch (error) {
    console.error('POST /f/:formId error:', error);
    return renderUnavailable(500, '送信に失敗しました');
  }
});
