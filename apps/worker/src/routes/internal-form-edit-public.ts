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
import {
  evaluateInternalFormLogic,
  INTERNAL_FORM_CHANNEL_SOURCE_ID,
  isDecorationType,
  type InternalFormLogicAnswers,
} from '@line-crm/shared';
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

function branchSourceFieldIds(definition: InternalFormDefinition): Set<string> {
  const known = new Set(definition.fields.map((field) => field.id));
  const sources = new Set<string>();
  for (const rule of definition.logic) {
    if (rule.sourceFieldId !== INTERNAL_FORM_CHANNEL_SOURCE_ID && known.has(rule.sourceFieldId)) {
      sources.add(rule.sourceFieldId);
    }
    for (const condition of rule.conditions ?? []) {
      if (condition.sourceFieldId !== INTERNAL_FORM_CHANNEL_SOURCE_ID && known.has(condition.sourceFieldId)) {
        sources.add(condition.sourceFieldId);
      }
    }
  }
  return sources;
}

function isEditableForBranchPolicy(
  field: InternalFormField,
  repeatingTemplates: ReadonlySet<string>,
  branchSources: ReadonlySet<string>,
  allowBranchEdit: boolean,
): boolean {
  return isEditableField(field, repeatingTemplates)
    && (allowBranchEdit || !branchSources.has(field.id));
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

function renderEditableField(
  field: InternalFormField,
  index: number,
  current: unknown,
  initiallyVisible: boolean,
): string {
  const id = `answer-${index}`;
  const name = `a_${index}`;
  const required = field.required && initiallyVisible ? ' required' : '';
  const requiredData = field.required ? ' data-required="true"' : '';
  const disabled = initiallyVisible ? '' : ' disabled';
  const requiredCopy = field.required ? '<span class="required">必須</span>' : '';
  const label = `<span class="label">${escapeHtml(field.label)}${requiredCopy}</span>`;

  if (field.type === 'textarea') {
    return `<label class="field" for="${id}">${label}<textarea id="${id}" name="${name}"${requiredData}${required}${disabled}>${escapeHtml(currentInputValue(field, current))}</textarea></label>`;
  }

  if (field.type === 'multiple_select') {
    const selected = new Set(Array.isArray(current) ? current.map(String) : []);
    const checkboxes = options(field).map((option, optionIndex) => {
      const checked = selected.has(option.value) ? ' checked' : '';
      const optionId = `${id}-${optionIndex}`;
      return `<label class="choice" for="${optionId}"><input id="${optionId}" type="checkbox" name="${name}" value="${escapeHtml(option.value)}"${checked}${disabled}> <span>${escapeHtml(option.label)}</span></label>`;
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
    return `<label class="field" for="${id}">${label}<select id="${id}" name="${name}"${requiredData}${required}${disabled}><option value="">選択してください</option>${choices}</select></label>`;
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
  return `<label class="field" for="${id}">${label}<input id="${id}" type="${type}" name="${name}" value="${escapeHtml(currentInputValue(field, current))}"${requiredData}${required}${disabled}></label>`;
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

function safeJsonForHtml(value: unknown): string {
  return JSON.stringify(value)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function renderEditPage(
  value: ResolvedEdit,
  error?: string,
  currentAnswers: Record<string, unknown> = parseAnswers(value.submission.answers_json),
): string {
  const visible = new Set(evaluateInternalFormLogic(
    value.definition.fields,
    value.definition.logic,
    currentAnswers,
    value.submission.origin_channel === 'line' ? 'line' : 'web',
  ).visibleFieldIds);
  const templates = repeatingTemplateIds(value.definition.fields);
  const branchSources = branchSourceFieldIds(value.definition);
  const allowBranchEdit = value.form.allow_branch_edit === 1;
  const rows = value.definition.fields.map((field, index) => {
    if (isDecorationType(field.type) || templates.has(field.id)) return '';
    const initiallyVisible = visible.has(field.id);
    if (!allowBranchEdit && !initiallyVisible) return '';
    const editable = isEditableForBranchPolicy(field, templates, branchSources, allowBranchEdit);
    const rendered = editable
      ? renderEditableField(field, index, initiallyVisible ? currentAnswers[field.id] : undefined, initiallyVisible)
      : renderReadOnlyField(field, initiallyVisible ? currentAnswers[field.id] : undefined);
    const hidden = initiallyVisible ? '' : ' hidden';
    const requiredGroup = editable && field.type === 'multiple_select' && field.required
      ? ' data-required-group="true"'
      : '';
    return `<div data-field-id="${escapeHtml(field.id)}"${requiredGroup}${hidden}>${rendered}</div>`;
  }).join('');
  const errorHtml = error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : '';
  const channel = value.submission.origin_channel === 'line' ? 'line' : 'web';
  const dynamicAttributes = allowBranchEdit
    ? ` data-internal-form data-channel="${channel}" data-form-type="simple"`
    : '';
  const submitAttribute = allowBranchEdit ? ' data-submit' : '';
  const fixedAnswers = Object.fromEntries(value.definition.fields
    .filter((field) => branchSources.has(field.id) && !isEditableField(field, templates))
    .filter((field) => Object.prototype.hasOwnProperty.call(currentAnswers, field.id))
    .map((field) => [field.id, currentAnswers[field.id]]));
  const client = allowBranchEdit
    ? `<script type="application/json" data-internal-form-logic-config>${safeJsonForHtml({
        fields: value.definition.fields.map(({ id, position, type }) => ({ id, position, type })),
        logic: value.definition.logic,
        ...(Object.keys(fixedAnswers).length ? { fixedAnswers } : {}),
      })}</script><script type="module" src="/assets/internal-form-logic.js" data-internal-form-logic-client></script>`
    : '';
  return renderDocument('回答の編集', `<h1>回答の編集</h1><p class="intro">${escapeHtml(value.form.title)}</p>${errorHtml}<form method="post"${dynamicAttributes}><input type="hidden" name="editVersion" value="${value.submission.edit_version}">${rows}<button type="submit"${submitAttribute}>保存する</button></form>${client}`);
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
  visibleFieldIds: ReadonlySet<string>,
  branchSources: ReadonlySet<string>,
  allowBranchEdit: boolean,
): { fields: InternalFormField[]; input: InternalAnswerInput; editableIds: string[] } {
  const templates = repeatingTemplateIds(definition.fields);
  const fields: InternalFormField[] = [];
  const input = Object.create(null) as InternalAnswerInput;
  const editableIds: string[] = [];

  for (const [originalIndex, field] of definition.fields.entries()) {
    const editable = isEditableForBranchPolicy(field, templates, branchSources, allowBranchEdit);
    if (!visibleFieldIds.has(field.id)) continue;
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

function buildCandidateLogicAnswers(
  definition: InternalFormDefinition,
  body: Record<string, string | File | (string | File)[]>,
  storedAnswers: Record<string, unknown>,
  branchSources: ReadonlySet<string>,
  allowBranchEdit: boolean,
): InternalFormLogicAnswers {
  const candidate: InternalFormLogicAnswers = { ...storedAnswers };
  const templates = repeatingTemplateIds(definition.fields);
  for (const [originalIndex, field] of definition.fields.entries()) {
    if (!isEditableForBranchPolicy(field, templates, branchSources, allowBranchEdit)) continue;
    const value = normalizeBodyValue(body[`a_${originalIndex}`]);
    if (value === undefined) delete candidate[field.id];
    else candidate[field.id] = value;
  }
  return candidate;
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

    const storedAnswers = parseAnswers(resolved.value.submission.answers_json);
    const branchSources = branchSourceFieldIds(resolved.value.definition);
    const allowBranchEdit = resolved.value.form.allow_branch_edit === 1;
    if (!allowBranchEdit && resolved.value.definition.fields.some((field, index) => (
      branchSources.has(field.id) && Object.prototype.hasOwnProperty.call(body, `a_${index}`)
    ))) {
      return c.html(renderEditPage(resolved.value, '分岐項目は変更できません。'), 403, PRIVATE_HEADERS);
    }
    const candidateAnswers = buildCandidateLogicAnswers(
      resolved.value.definition,
      body,
      storedAnswers,
      branchSources,
      allowBranchEdit,
    );
    const visibleFieldIds = new Set(evaluateInternalFormLogic(
      resolved.value.definition.fields,
      resolved.value.definition.logic,
      candidateAnswers,
      resolved.value.submission.origin_channel === 'line' ? 'line' : 'web',
    ).visibleFieldIds);
    const validationInput = buildValidationInput(
      resolved.value.definition,
      body,
      visibleFieldIds,
      branchSources,
      allowBranchEdit,
    );
    const validation = validateInternalFormAnswers(validationInput.fields, validationInput.input);
    if (!validation.ok) {
      return c.html(renderEditPage(resolved.value, validation.error, candidateAnswers), 400, PRIVATE_HEADERS);
    }

    const merged = storedAnswers;
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
