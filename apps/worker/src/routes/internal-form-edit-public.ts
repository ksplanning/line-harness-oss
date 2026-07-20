import { Hono } from 'hono';
import {
  getFormalooForm,
  getInternalFormNotificationSettings,
  getInternalFormSubmission,
  updateInternalFormSubmissionAnswers,
  type FormalooForm,
  type InternalFormNotificationSettings,
  type InternalFormSubmission,
} from '@line-crm/db';
import { isDecorationType } from '@line-crm/shared';
import { verifyEditToken, type EditTokenPayload } from '../services/formaloo-edit-token.js';
import {
  JAPAN_PREFECTURES,
  parseInternalFormDefinition,
  validateInternalFormAnswers,
  type InternalAnswerInput,
  type InternalFormDefinition,
  type InternalFormField,
} from '../services/internal-form-runtime.js';
import type { Env } from '../index.js';

export const internalFormEditPublic = new Hono<Env>();

const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
};

const READ_ONLY_TYPES = new Set(['file', 'matrix', 'repeating_section', 'signature']);

type ResolvedEdit = {
  form: FormalooForm;
  settings: InternalFormNotificationSettings;
  submission: InternalFormSubmission;
  definition: InternalFormDefinition;
  payload: EditTokenPayload;
};

type ResolveResult =
  | { ok: true; value: ResolvedEdit }
  | { ok: false; status: 403 | 404 | 422 };

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseAnswers(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.assign(Object.create(null) as Record<string, unknown>, parsed)
      : Object.create(null) as Record<string, unknown>;
  } catch {
    return Object.create(null) as Record<string, unknown>;
  }
}

function repeatingTemplateIds(fields: InternalFormField[]): Set<string> {
  return new Set(fields
    .filter((field) => field.type === 'repeating_section')
    .flatMap((field) => (field.config.repeatingColumns ?? []).map((column) => column.columnField)));
}

function isEditableField(field: InternalFormField, repeatingTemplates: ReadonlySet<string>): boolean {
  return !isDecorationType(field.type)
    && field.type !== 'variable'
    && !READ_ONLY_TYPES.has(field.type)
    && !repeatingTemplates.has(field.id);
}

function currentInputValue(field: InternalFormField, value: unknown): string {
  if (field.type === 'yes_no') {
    if (value === true) return 'yes';
    if (value === false) return 'no';
  }
  return value == null ? '' : String(value);
}

function options(field: InternalFormField): Array<{ value: string; label: string }> {
  if (field.type === 'yes_no') return [{ value: 'yes', label: 'はい' }, { value: 'no', label: 'いいえ' }];
  if (field.type === 'prefecture') return JAPAN_PREFECTURES.map((value) => ({ value, label: value }));
  if (field.type === 'rating' && field.config.ratingSubType === 'like_dislike') {
    return [{ value: 'like', label: '良い' }, { value: 'dislike', label: '良くない' }];
  }
  return (field.config.choices ?? []).map((value) => ({ value, label: value }));
}

function renderEditableField(field: InternalFormField, index: number, current: unknown): string {
  const id = `answer-${index}`;
  const name = `a_${index}`;
  const required = field.required ? ' required' : '';
  const requiredCopy = field.required ? '<span class="required">必須</span>' : '';
  const label = `<span class="label">${escapeHtml(field.label)}${requiredCopy}</span>`;

  if (field.type === 'textarea') {
    return `<label class="field" for="${id}">${label}<textarea id="${id}" name="${name}"${required}>${escapeHtml(currentInputValue(field, current))}</textarea></label>`;
  }

  if (field.type === 'multiple_select') {
    const selected = new Set(Array.isArray(current) ? current.map(String) : []);
    const checkboxes = options(field).map((option, optionIndex) => {
      const checked = selected.has(option.value) ? ' checked' : '';
      const optionId = `${id}-${optionIndex}`;
      return `<label class="choice" for="${optionId}"><input id="${optionId}" type="checkbox" name="${name}" value="${escapeHtml(option.value)}"${checked}> <span>${escapeHtml(option.label)}</span></label>`;
    }).join('');
    return `<fieldset class="field"><legend>${escapeHtml(field.label)}${requiredCopy}</legend>${checkboxes}</fieldset>`;
  }

  if (
    field.type === 'choice'
    || field.type === 'dropdown'
    || field.type === 'yes_no'
    || field.type === 'prefecture'
    || (field.type === 'rating' && field.config.ratingSubType === 'like_dislike')
  ) {
    const currentValue = currentInputValue(field, current);
    const choices = options(field).map((option) => (
      `<option value="${escapeHtml(option.value)}"${option.value === currentValue ? ' selected' : ''}>${escapeHtml(option.label)}</option>`
    )).join('');
    return `<label class="field" for="${id}">${label}<select id="${id}" name="${name}"${required}><option value="">選択してください</option>${choices}</select></label>`;
  }

  const type = field.type === 'email'
    ? 'email'
    : field.type === 'phone'
      ? 'tel'
      : field.type === 'number' || field.type === 'rating'
        ? 'number'
        : field.type === 'date'
          ? 'date'
          : field.type === 'time'
            ? 'time'
            : field.type === 'datetime'
              ? 'datetime-local'
              : field.type === 'website'
                ? 'url'
                : 'text';
  return `<label class="field" for="${id}">${label}<input id="${id}" type="${type}" name="${name}" value="${escapeHtml(currentInputValue(field, current))}"${required}></label>`;
}

function formatReadOnlyValue(value: unknown): string {
  if (value == null || value === '') return '（回答なし）';
  if (Array.isArray(value)) return value.map(formatReadOnlyValue).join('\n');
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.name === 'string') return record.name;
    return Object.entries(record).map(([key, nested]) => `${key}: ${formatReadOnlyValue(nested)}`).join('\n');
  }
  return String(value);
}

function renderReadOnlyField(field: InternalFormField, current: unknown): string {
  const shown = field.type === 'signature' && current
    ? '保存済みの署名（変更できません）'
    : formatReadOnlyValue(current);
  return `<section class="field readonly" aria-label="${escapeHtml(field.label)}"><span class="label">${escapeHtml(field.label)}</span><pre>${escapeHtml(shown)}</pre></section>`;
}

function renderDocument(title: string, content: string): string {
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${escapeHtml(title)}</title>
  <style>
    :root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17202a;background:#f4f6f8}
    *{box-sizing:border-box}body{margin:0;padding:24px 16px}main{max-width:620px;margin:auto;background:#fff;padding:28px 22px;border-radius:14px;box-shadow:0 8px 28px rgba(18,38,63,.08)}
    h1{font-size:1.55rem;margin:0 0 8px}.intro{color:#52606d;margin:0 0 24px}.error{padding:12px 14px;background:#fef3f2;color:#b42318;border-radius:9px}
    .field{display:block;margin:0 0 20px;border:0;padding:0}.label,legend{display:block;font-weight:700;margin:0 0 7px}.required{font-size:.78rem;color:#b42318;margin-left:7px}
    input,textarea,select,button{width:100%;font:inherit}input,textarea,select{min-height:46px;padding:10px 12px;border:1px solid #cbd5e1;border-radius:9px;background:#fff}textarea{min-height:120px;resize:vertical}
    .choice{display:flex;align-items:center;gap:8px;margin:8px 0}.choice input{width:20px;min-height:20px}.readonly pre{margin:0;padding:10px 12px;white-space:pre-wrap;overflow-wrap:anywhere;background:#f2f4f7;border-radius:9px;font:inherit;color:#52606d}
    button{min-height:50px;border:0;border-radius:10px;background:#06c755;color:#fff;font-weight:800;cursor:pointer}.result{text-align:center;padding:36px 0}.result p{color:#52606d}
  </style>
</head>
<body><main>${content}</main></body>
</html>`;
}

function renderInvalidPage(): string {
  return renderDocument('リンクが無効です', '<section class="result"><h1>このリンクは使用できません</h1><p>有効期限が切れているか、リンクが無効になっています。</p></section>');
}

function renderEditPage(value: ResolvedEdit, error?: string): string {
  const answers = parseAnswers(value.submission.answers_json);
  const templates = repeatingTemplateIds(value.definition.fields);
  const rows = value.definition.fields.map((field, index) => {
    if (isDecorationType(field.type) || templates.has(field.id)) return '';
    return isEditableField(field, templates)
      ? renderEditableField(field, index, answers[field.id])
      : renderReadOnlyField(field, answers[field.id]);
  }).join('');
  const errorHtml = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '';
  return renderDocument('回答の編集', `<h1>回答の編集</h1><p class="intro">${escapeHtml(value.form.title)}</p>${errorHtml}<form method="post"><input type="hidden" name="editVersion" value="${value.submission.edit_version}">${rows}<button type="submit">保存する</button></form>`);
}

function renderSuccessPage(): string {
  return renderDocument('保存しました', '<section class="result" role="status"><h1>保存しました</h1><p>回答内容を更新しました。</p></section>');
}

async function resolveEdit(env: Env['Bindings'], token: string): Promise<ResolveResult> {
  const payload = await verifyEditToken(
    token,
    env.FORMALOO_EDIT_TOKEN_SECRET,
    Math.floor(Date.now() / 1000),
  );
  if (!payload) return { ok: false, status: 403 };

  const form = await getFormalooForm(env.DB, payload.formId);
  if (!form || form.deleted) return { ok: false, status: 404 };
  if (form.render_backend !== 'internal' || form.builder_status !== 'published') {
    return { ok: false, status: 404 };
  }

  const settings = await getInternalFormNotificationSettings(env.DB, payload.formId);
  if (!settings || settings.editLinkEpoch !== payload.epoch) return { ok: false, status: 403 };

  const submission = await getInternalFormSubmission(env.DB, payload.formId, payload.rowRef);
  if (!submission) return { ok: false, status: 404 };

  const parsed = parseInternalFormDefinition(form.definition_json);
  if (!parsed.ok) return { ok: false, status: 422 };
  return {
    ok: true,
    value: { form, settings, submission, definition: parsed.definition, payload },
  };
}

function normalizeBodyValue(value: string | File | (string | File)[] | undefined): InternalAnswerInput[string] {
  if (typeof value === 'string' || value instanceof File) return value;
  if (Array.isArray(value)) {
    return value.filter((item): item is string | File => typeof item === 'string' || item instanceof File);
  }
  return undefined;
}

function buildValidationInput(
  definition: InternalFormDefinition,
  body: Record<string, string | File | (string | File)[]>,
): { fields: InternalFormField[]; input: InternalAnswerInput; editableIds: string[] } {
  const templates = repeatingTemplateIds(definition.fields);
  const fields: InternalFormField[] = [];
  const input = Object.create(null) as InternalAnswerInput;
  const editableIds: string[] = [];

  for (const [originalIndex, field] of definition.fields.entries()) {
    const editable = isEditableField(field, templates);
    const formula = field.type === 'variable' && field.config.variableSubType === 'formula';
    if (!editable && !formula) continue;
    const validationIndex = fields.length;
    fields.push(field);
    if (!editable) continue;
    editableIds.push(field.id);
    const value = normalizeBodyValue(body[`a_${originalIndex}`]);
    if (value !== undefined) input[`a_${validationIndex}`] = value;
  }
  return { fields, input, editableIds };
}

function parseEditVersion(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function jsonEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

internalFormEditPublic.get('/ife/:token', async (c) => {
  try {
    const resolved = await resolveEdit(c.env, c.req.param('token'));
    if (!resolved.ok) return c.html(renderInvalidPage(), resolved.status, PRIVATE_HEADERS);
    return c.html(renderEditPage(resolved.value), 200, PRIVATE_HEADERS);
  } catch (error) {
    // Capability token は bearer credential。path/token 自体を log に含めない。
    console.error('internal form edit GET failed:', error);
    return c.html(renderInvalidPage(), 500, PRIVATE_HEADERS);
  }
});

internalFormEditPublic.post('/ife/:token', async (c) => {
  try {
    const resolved = await resolveEdit(c.env, c.req.param('token'));
    if (!resolved.ok) return c.html(renderInvalidPage(), resolved.status, PRIVATE_HEADERS);

    const body = await c.req.parseBody({ all: true }).catch(() => null);
    if (!body) return c.html(renderEditPage(resolved.value, '編集内容を読み込めませんでした。'), 400, PRIVATE_HEADERS);
    const expectedEditVersion = parseEditVersion(body.editVersion);
    if (expectedEditVersion === null) {
      return c.html(renderEditPage(resolved.value, 'ページを再読み込みしてから、もう一度保存してください。'), 400, PRIVATE_HEADERS);
    }

    const validationInput = buildValidationInput(resolved.value.definition, body);
    const validation = validateInternalFormAnswers(validationInput.fields, validationInput.input);
    if (!validation.ok) {
      return c.html(renderEditPage(resolved.value, validation.error), 400, PRIVATE_HEADERS);
    }

    const merged = parseAnswers(resolved.value.submission.answers_json);
    for (const fieldId of validationInput.editableIds) delete merged[fieldId];
    Object.assign(merged, validation.answers);
    const result = await updateInternalFormSubmissionAnswers(c.env.DB, {
      formId: resolved.value.payload.formId,
      submissionId: resolved.value.payload.rowRef,
      expectedEditVersion,
      expectedEditLinkEpoch: resolved.value.payload.epoch,
      answers: merged,
    });
    if (result.status === 'revoked') {
      return c.html(renderInvalidPage(), 403, PRIVATE_HEADERS);
    }
    if (result.status === 'conflict') {
      return c.html(renderDocument('更新できませんでした', '<section class="result"><h1>回答が先に更新されています</h1><p>ページを再読み込みして、最新の回答を確認してください。</p></section>'), 409, PRIVATE_HEADERS);
    }

    const readback = await getInternalFormSubmission(
      c.env.DB,
      resolved.value.payload.formId,
      resolved.value.payload.rowRef,
    );
    if (
      !readback
      || readback.edit_version !== result.submission.edit_version
      || !jsonEqual(parseAnswers(readback.answers_json), merged)
    ) {
      throw new Error('internal form edit read-back mismatch');
    }
    return c.html(renderSuccessPage(), 200, PRIVATE_HEADERS);
  } catch (error) {
    // Capability token は bearer credential。path/token 自体を log に含めない。
    console.error('internal form edit POST failed:', error);
    return c.html(renderDocument('保存できませんでした', '<section class="result"><h1>保存できませんでした</h1><p>時間をおいて、もう一度お試しください。</p></section>'), 500, PRIVATE_HEADERS);
  }
});
