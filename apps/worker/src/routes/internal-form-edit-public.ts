import { Hono, type Context } from 'hono';
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
  MAX_FILES_PER_FORM_FIELD,
  isDecorationType,
  type InternalFormLogicAnswers,
} from '@line-crm/shared';
import { verifyEditToken, type EditTokenPayload } from '../services/formaloo-edit-token.js';
import { syncSheetsAfterFormMutation } from '../services/sheets-sync-jobs.js';
import { parseAllowedOrigins } from '../middleware/admin-auth-config.js';
import {
  JAPAN_PREFECTURES,
  parseInternalFormDefinition,
  validateInternalFormAnswers,
  type InternalAnswerInput,
  type InternalFormDefinition,
  type InternalFormField,
} from '../services/internal-form-runtime.js';
import {
  mergeInternalFormAttachments,
  parseInternalFormAttachmentDescriptor,
  retainInternalFormAttachments,
  rollbackInternalFormUploads,
  storeInternalFormUploads,
  type StoredInternalFormUploads,
} from '../services/internal-form-attachments.js';
import type { Env } from '../index.js';

export const internalFormEditPublic = new Hono<Env>();

function queueSheetsSyncAfterRespondentEdit(
  c: Context<Env>,
  form: FormalooForm,
  submissionId: string,
): void {
  if (!c.env.GOOGLE_SERVICE_ACCOUNT_JSON || !form.line_account_id) return;
  try {
    const work = syncSheetsAfterFormMutation({
      db: c.env.DB,
      lineAccountId: form.line_account_id,
      formId: form.id,
      submissionId,
      actor: 'system_internal_form_edit',
      credentialsJson: c.env.GOOGLE_SERVICE_ACCOUNT_JSON,
      adminOrigin: parseAllowedOrigins(c.env)[0] ?? null,
    }).catch(() => {
      console.error('Immediate Google Sheets sync after respondent edit failed');
    });
    c.executionCtx.waitUntil(work);
  } catch {
    console.error('Immediate Google Sheets sync after respondent edit failed');
  }
}

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

export function repeatingTemplateIds(fields: InternalFormField[]): Set<string> {
  return new Set(fields
    .filter((field) => field.type === 'repeating_section')
    .flatMap((field) => (field.config.repeatingColumns ?? []).map((column) => column.columnField)));
}

export function isEditableField(field: InternalFormField, repeatingTemplates: ReadonlySet<string>): boolean {
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
  const respondentEditable = isEditableField(field, repeatingTemplates)
    || (field.type === 'file' && !repeatingTemplates.has(field.id));
  return respondentEditable
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

function attachmentKeyPrefix(formId: string, fieldId: string): string {
  return `internal-form-submissions/${encodeURIComponent(formId)}/${encodeURIComponent(fieldId)}/`;
}

function attachmentIcon(name: string, type: string): string {
  const extension = name.match(/\.([^.]+)$/)?.[1];
  if (extension) return extension.toUpperCase().slice(0, 5);
  const subtype = type.split('/')[1];
  return subtype ? subtype.toUpperCase().slice(0, 5) : 'FILE';
}

function renderAttachmentField(
  value: ResolvedEdit,
  token: string,
  field: InternalFormField,
  index: number,
  current: unknown,
  initiallyVisible: boolean,
): string {
  const id = `answer-${index}`;
  const name = `a_${index}`;
  const entries = Array.isArray(current) ? current : [];
  const prefix = attachmentKeyPrefix(value.form.id, field.id);
  const saved = entries.map((entry, attachmentIndex) => {
    const descriptor = parseInternalFormAttachmentDescriptor(entry, prefix);
    const fallback = entry !== null && typeof entry === 'object' && !Array.isArray(entry)
      ? entry as Record<string, unknown>
      : null;
    const filename = descriptor?.name
      ?? (typeof fallback?.name === 'string' && fallback.name ? fallback.name : `添付ファイル ${attachmentIndex + 1}`);
    const contentType = descriptor?.type ?? 'application/octet-stream';
    const url = descriptor
      ? `/ife/${encodeURIComponent(token)}/attachment/${encodeURIComponent(field.id)}/${attachmentIndex}`
      : null;
    const preview = descriptor && INLINE_IMAGE_MIMES.has(contentType.toLowerCase()) && url
      ? `<a href="${escapeHtml(url)}" aria-label="${escapeHtml(filename)}を開く"><img class="attachment-thumbnail" src="${escapeHtml(url)}" alt="${escapeHtml(filename)} のプレビュー"></a>`
      : `<span class="attachment-icon" aria-hidden="true">${escapeHtml(attachmentIcon(filename, contentType))}</span>`;
    const displayedName = url
      ? `<a class="attachment-name" href="${escapeHtml(url)}">${escapeHtml(filename)}</a>`
      : `<span class="attachment-name">${escapeHtml(filename)}</span>`;
    const disabled = initiallyVisible ? '' : ' disabled';
    return `<li class="attachment-item" data-existing-file-item>${preview}<span class="attachment-details">${displayedName}</span><label class="attachment-delete"><input type="checkbox" name="remove_${name}" value="${attachmentIndex}" data-existing-file-remove data-logic-ignore${disabled}> 削除する</label></li>`;
  }).join('');
  const extensions = (field.config.allowedExtensions ?? [])
    .map((extension) => extension.replace(/^\./, '').toLowerCase())
    .filter((extension) => /^[a-z0-9]+$/.test(extension));
  const accept = extensions.length ? ` accept="${extensions.map((extension) => `.${extension}`).join(',')}"` : '';
  const multiple = field.config.allowMultipleFiles ? ' multiple' : '';
  const maxFiles = field.config.allowMultipleFiles ? MAX_FILES_PER_FORM_FIELD : 1;
  const maxSizeKb = field.config.maxSizeKb ?? 2048;
  const requiredData = field.required ? ' data-required="true"' : '';
  const required = field.required && entries.length === 0 && initiallyVisible ? ' required' : '';
  const disabled = initiallyVisible ? '' : ' disabled';
  const requiredCopy = field.required ? '<span class="required">必須</span>' : '';
  return `<div class="field attachment-field" data-file-attachment data-edit-file-capacity><span class="label">${escapeHtml(field.label)}${requiredCopy}</span><ul class="attachment-list existing-attachment-list" data-existing-file-list aria-label="保存済みファイル">${saved}</ul><label class="attachment-add-label" for="${id}">ファイルを追加</label><input type="file" id="${id}" name="${name}"${accept}${multiple}${requiredData}${required}${disabled} data-file-input data-logic-ignore data-max-files="${maxFiles}" data-max-size-kb="${maxSizeKb}" data-allowed-extensions="${extensions.join(',')}" aria-describedby="${id}-file-status"><p class="attachment-status" id="${id}-file-status" data-file-status role="alert" aria-live="polite" hidden></p><ul class="attachment-list" data-file-list aria-label="追加するファイル" aria-live="polite"></ul></div>`;
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
    .attachment-list{display:grid;gap:10px;margin:12px 0;padding:0;list-style:none}.attachment-list:empty{display:none}.attachment-item{display:flex;align-items:center;gap:10px;padding:10px;border:1px solid #cbd5e1;border-radius:10px}.attachment-thumbnail,.attachment-icon{width:56px;height:56px;flex:0 0 56px;border-radius:8px}.attachment-thumbnail{display:block;object-fit:cover;background:#eef2f6}.attachment-icon{display:grid;place-items:center;background:#eef2f6;color:#344054;font-size:.75rem;font-weight:800}.attachment-details{min-width:0;flex:1}.attachment-name,.attachment-size{display:block}.attachment-name{overflow-wrap:anywhere;color:inherit;font-weight:700}.attachment-size{margin-top:3px;color:#667085;font-size:.82rem}.attachment-remove{width:auto;min-height:38px;padding:7px 11px;border:1px solid #fda29b;background:#fff;color:#b42318;font-size:.85rem}.attachment-delete{display:flex;align-items:center;gap:6px;color:#b42318;font-size:.85rem;white-space:nowrap}.attachment-delete input{width:20px;min-height:20px}.attachment-add-label{display:block;margin-top:12px;font-weight:700}.attachment-status{margin:8px 0 0;color:#b42318;font-size:.9rem}
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

const EDIT_ATTACHMENT_CAPACITY_CLIENT = `(() => {
  for (const root of document.querySelectorAll('[data-edit-file-capacity]')) {
    const input = root.querySelector('[data-file-input]');
    if (!(input instanceof HTMLInputElement)) continue;
    const maxFiles = Number(input.dataset.maxFiles);
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) continue;
    const field = root.closest('[data-field-id]');
    const eventRoot = root.closest('form') ?? root;
    const syncCapacity = () => {
      const retainedCount = [...root.querySelectorAll('[data-existing-file-remove]')]
        .filter((control) => !control.checked).length;
      const additionCount = input.files?.length ?? 0;
      const hidden = field instanceof HTMLElement && field.hidden;
      input.disabled = hidden || (additionCount === 0 && retainedCount >= maxFiles);
    };
    eventRoot.addEventListener('change', syncCapacity);
    eventRoot.addEventListener('input', syncCapacity);
    syncCapacity();
  }
})();`;

function projectFixedLogicAnswer(value: unknown): unknown {
  const scalar = (entry: unknown): unknown => (
    entry !== null && typeof entry === 'object' ? String(entry) : entry
  );
  return Array.isArray(value) ? value.map(scalar) : scalar(value);
}

function renderEditPage(
  value: ResolvedEdit,
  token: string,
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
  let hasEditableAttachment = false;
  const rows = value.definition.fields.map((field, index) => {
    if (isDecorationType(field.type) || templates.has(field.id)) return '';
    const initiallyVisible = visible.has(field.id);
    if (!allowBranchEdit && !initiallyVisible) return '';
    const editable = isEditableForBranchPolicy(field, templates, branchSources, allowBranchEdit);
    const current = initiallyVisible ? currentAnswers[field.id] : undefined;
    if (editable && field.type === 'file') hasEditableAttachment = true;
    const rendered = editable && field.type === 'file'
      ? renderAttachmentField(value, token, field, index, current, initiallyVisible)
      : editable
        ? renderEditableField(field, index, current, initiallyVisible)
        : renderReadOnlyField(field, current);
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
    .filter((field) => field.type !== 'file' && branchSources.has(field.id) && !isEditableField(field, templates))
    // 初期状態で非表示の保存値は edit HTML へ出さない。表示中の readonly source だけを
    // client 再評価へ渡し、認可済み画面でも不要な回答値の露出を避ける。
    .filter((field) => visible.has(field.id))
    .filter((field) => Object.prototype.hasOwnProperty.call(currentAnswers, field.id))
    // The shared evaluator stringifies object values. Project them to those
    // exact strings before embedding JSON so stale attachment descriptors can
    // never expose private R2 keys after a field type change.
    .map((field) => [field.id, projectFixedLogicAnswer(currentAnswers[field.id])]));
  const logicConfig = allowBranchEdit
    ? `<script type="application/json" data-internal-form-logic-config>${safeJsonForHtml({
        fields: value.definition.fields.map(({ id, position, type }) => ({ id, position, type })),
        logic: value.definition.logic,
        ...(Object.keys(fixedAnswers).length ? { fixedAnswers } : {}),
      })}</script>`
    : '';
  const clientAsset = allowBranchEdit || hasEditableAttachment
    ? '<script type="module" src="/assets/internal-form-logic.js" data-internal-form-logic-client></script>'
    : '';
  const attachmentCapacityClient = hasEditableAttachment
    ? `<script type="module" data-edit-attachment-capacity-client>${EDIT_ATTACHMENT_CAPACITY_CLIENT}</script>`
    : '';
  const enctype = hasEditableAttachment ? ' enctype="multipart/form-data"' : '';
  return renderDocument('回答の編集', `<h1>回答の編集</h1><p class="intro">${escapeHtml(value.form.title)}</p>${errorHtml}<form method="post"${enctype}${dynamicAttributes}><input type="hidden" name="editVersion" value="${value.submission.edit_version}">${rows}<button type="submit"${submitAttribute}>保存する</button></form>${logicConfig}${clientAsset}${attachmentCapacityClient}`);
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

type EditBody = Record<string, string | File | (string | File)[]>;

function buildValidationInput(
  definition: InternalFormDefinition,
  body: EditBody,
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
  body: EditBody,
  storedAnswers: Record<string, unknown>,
  branchSources: ReadonlySet<string>,
  allowBranchEdit: boolean,
): InternalFormLogicAnswers {
  const candidate: InternalFormLogicAnswers = { ...storedAnswers };
  const templates = repeatingTemplateIds(definition.fields);
  for (const [originalIndex, field] of definition.fields.entries()) {
    if (!isEditableForBranchPolicy(field, templates, branchSources, allowBranchEdit)) continue;
    // File descriptors are server-owned values. Browser File objects and
    // deletion controls must not become branch-logic answers.
    if (field.type === 'file') continue;
    const value = normalizeBodyValue(body[`a_${originalIndex}`]);
    if (value === undefined) delete candidate[field.id];
    else candidate[field.id] = value;
  }
  return candidate;
}

type AttachmentEditState = {
  retainedByField: Record<string, unknown[]>;
  retainedFileCounts: Record<string, number>;
};

function bodyStrings(value: EditBody[string] | undefined): string[] | null {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.every((entry): entry is string => typeof entry === 'string') ? values : null;
}

function bodyFiles(value: EditBody[string] | undefined): File[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.filter((entry): entry is File => (
    typeof entry !== 'string' && (entry.name !== '' || entry.size > 0)
  ));
}

function applyAttachmentSourceLogicAnswers(
  definition: InternalFormDefinition,
  body: EditBody,
  storedAnswers: Record<string, unknown>,
  candidateAnswers: InternalFormLogicAnswers,
  initiallyVisibleFieldIds: ReadonlySet<string>,
  branchSources: ReadonlySet<string>,
  allowBranchEdit: boolean,
): boolean {
  const templates = repeatingTemplateIds(definition.fields);
  for (const [index, field] of definition.fields.entries()) {
    if (
      field.type !== 'file'
      || !branchSources.has(field.id)
      || !isEditableForBranchPolicy(field, templates, branchSources, allowBranchEdit)
    ) continue;
    const existing = initiallyVisibleFieldIds.has(field.id) ? storedAnswers[field.id] : [];
    const removals = bodyStrings(body[`remove_a_${index}`]);
    if (!removals) return false;
    const retained = retainInternalFormAttachments(existing, removals);
    if (!retained.ok) return false;
    const finalCount = retained.retained.length + bodyFiles(body[`a_${index}`]).length;
    if (finalCount > 0) candidateAnswers[field.id] = Array(finalCount).fill('attached');
    else delete candidateAnswers[field.id];
  }
  return true;
}

function buildAttachmentEditState(
  definition: InternalFormDefinition,
  body: EditBody,
  storedAnswers: Record<string, unknown>,
  visibleFieldIds: ReadonlySet<string>,
  initiallyVisibleFieldIds: ReadonlySet<string>,
  branchSources: ReadonlySet<string>,
  allowBranchEdit: boolean,
): { ok: true; state: AttachmentEditState } | { ok: false } {
  const retainedByField = Object.create(null) as Record<string, unknown[]>;
  const retainedFileCounts = Object.create(null) as Record<string, number>;
  const templates = repeatingTemplateIds(definition.fields);
  for (const [index, field] of definition.fields.entries()) {
    if (
      field.type !== 'file'
      || !visibleFieldIds.has(field.id)
      || !isEditableForBranchPolicy(field, templates, branchSources, allowBranchEdit)
    ) continue;
    const removals = bodyStrings(body[`remove_a_${index}`]);
    if (!removals) return { ok: false };
    const existing = initiallyVisibleFieldIds.has(field.id) ? storedAnswers[field.id] : [];
    const retained = retainInternalFormAttachments(existing, removals);
    if (!retained.ok) return { ok: false };
    retainedByField[field.id] = retained.retained;
    retainedFileCounts[field.id] = retained.retained.length;
  }
  return { ok: true, state: { retainedByField, retainedFileCounts } };
}

function parseEditVersion(value: EditBody[string] | undefined): number | null {
  const values = Array.isArray(value) ? value : [value];
  if (values.length !== 1 || typeof values[0] !== 'string' || !/^\d+$/.test(values[0])) return null;
  const parsed = Number(values[0]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function jsonEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const SAFE_ATTACHMENT_MIME = /^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}$/;
const INLINE_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

function attachmentFilename(name: string): string {
  const sanitized = name.replace(/[\\/:*?"<>|\r\n]/g, '_');
  const characters: string[] = [];
  for (const character of sanitized) {
    if (characters.length >= 80) break;
    const codePoint = character.codePointAt(0);
    characters.push(codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdfff ? '_' : character);
  }
  return characters.join('') || 'attachment';
}

function encodedAttachmentFilename(name: string): string {
  return encodeURIComponent(attachmentFilename(name)).replace(/['()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

internalFormEditPublic.get('/ife/:token', async (c) => {
  try {
    const token = c.req.param('token');
    const resolved = await resolveEdit(c.env, token);
    if (!resolved.ok) return c.html(renderInvalidPage(), resolved.status, PRIVATE_HEADERS);
    return c.html(renderEditPage(resolved.value, token), 200, PRIVATE_HEADERS);
  } catch (error) {
    // Capability token は bearer credential。path/token 自体を log に含めない。
    console.error('internal form edit GET failed:', error);
    return c.html(renderInvalidPage(), 500, PRIVATE_HEADERS);
  }
});

internalFormEditPublic.get('/ife/:token/attachment/:fieldId/:index', async (c) => {
  try {
    const resolved = await resolveEdit(c.env, c.req.param('token'));
    if (!resolved.ok) return c.body(null, resolved.status, PRIVATE_HEADERS);
    const fieldId = c.req.param('fieldId');
    const field = resolved.value.definition.fields.find((candidate) => candidate.id === fieldId);
    if (!field || field.type !== 'file') return c.body(null, 404, PRIVATE_HEADERS);
    const rawIndex = c.req.param('index');
    if (!/^(?:0|[1-9]\d*)$/.test(rawIndex)) return c.body(null, 404, PRIVATE_HEADERS);
    const index = Number(rawIndex);
    if (!Number.isSafeInteger(index)) return c.body(null, 404, PRIVATE_HEADERS);
    const answers = parseAnswers(resolved.value.submission.answers_json);
    const entries = answers[fieldId];
    if (!Array.isArray(entries) || index >= entries.length) return c.body(null, 404, PRIVATE_HEADERS);
    const descriptor = parseInternalFormAttachmentDescriptor(
      entries[index],
      attachmentKeyPrefix(resolved.value.form.id, fieldId),
    );
    if (!descriptor) return c.body(null, 404, PRIVATE_HEADERS);
    const object = await c.env.IMAGES.get(descriptor.key);
    if (!object) return c.body(null, 404, PRIVATE_HEADERS);
    const contentType = SAFE_ATTACHMENT_MIME.test(descriptor.type)
      ? descriptor.type.toLowerCase()
      : 'application/octet-stream';
    const disposition = INLINE_IMAGE_MIMES.has(contentType) ? 'inline' : 'attachment';
    return c.body(object.body, 200, {
      ...PRIVATE_HEADERS,
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${disposition}; filename*=UTF-8''${encodedAttachmentFilename(descriptor.name)}`,
    });
  } catch {
    // R2 errors can contain a private key. Keep logs fixed and credential-free.
    console.error('internal form edit attachment GET failed');
    return c.body(null, 500, PRIVATE_HEADERS);
  }
});

internalFormEditPublic.post('/ife/:token', async (c) => {
  let storedUploads: StoredInternalFormUploads | null = null;
  let mutationCommitted = false;
  try {
    const token = c.req.param('token');
    const resolved = await resolveEdit(c.env, token);
    if (!resolved.ok) return c.html(renderInvalidPage(), resolved.status, PRIVATE_HEADERS);

    const body = await c.req.parseBody({ all: true }).catch(() => null) as EditBody | null;
    if (!body) {
      return c.html(
        renderEditPage(resolved.value, token, '編集内容を読み込めませんでした。'),
        400,
        PRIVATE_HEADERS,
      );
    }
    const expectedEditVersion = parseEditVersion(body.editVersion);
    if (expectedEditVersion === null) {
      return c.html(
        renderEditPage(resolved.value, token, 'ページを再読み込みしてから、もう一度保存してください。'),
        400,
        PRIVATE_HEADERS,
      );
    }

    const storedAnswers = parseAnswers(resolved.value.submission.answers_json);
    const branchSources = branchSourceFieldIds(resolved.value.definition);
    const allowBranchEdit = resolved.value.form.allow_branch_edit === 1;
    if (!allowBranchEdit && resolved.value.definition.fields.some((field, index) => (
      branchSources.has(field.id)
      && (
        Object.prototype.hasOwnProperty.call(body, `a_${index}`)
        || Object.prototype.hasOwnProperty.call(body, `remove_a_${index}`)
      )
    ))) {
      return c.html(
        renderEditPage(resolved.value, token, '分岐項目は変更できません。'),
        403,
        PRIVATE_HEADERS,
      );
    }
    const initiallyVisibleFieldIds = new Set(evaluateInternalFormLogic(
      resolved.value.definition.fields,
      resolved.value.definition.logic,
      storedAnswers,
      resolved.value.submission.origin_channel === 'line' ? 'line' : 'web',
    ).visibleFieldIds);
    const candidateAnswers = buildCandidateLogicAnswers(
      resolved.value.definition,
      body,
      storedAnswers,
      branchSources,
      allowBranchEdit,
    );
    for (const field of resolved.value.definition.fields) {
      if (field.type === 'file' && !initiallyVisibleFieldIds.has(field.id)) delete candidateAnswers[field.id];
    }
    const logicCandidateAnswers = Object.assign(
      Object.create(null) as InternalFormLogicAnswers,
      candidateAnswers,
    );
    if (!applyAttachmentSourceLogicAnswers(
      resolved.value.definition,
      body,
      storedAnswers,
      logicCandidateAnswers,
      initiallyVisibleFieldIds,
      branchSources,
      allowBranchEdit,
    )) {
      return c.html(
        renderEditPage(resolved.value, token, '添付の削除指定が正しくありません', candidateAnswers),
        400,
        PRIVATE_HEADERS,
      );
    }
    const visibleFieldIds = new Set(evaluateInternalFormLogic(
      resolved.value.definition.fields,
      resolved.value.definition.logic,
      logicCandidateAnswers,
      resolved.value.submission.origin_channel === 'line' ? 'line' : 'web',
    ).visibleFieldIds);
    const attachmentEdits = buildAttachmentEditState(
      resolved.value.definition,
      body,
      storedAnswers,
      visibleFieldIds,
      initiallyVisibleFieldIds,
      branchSources,
      allowBranchEdit,
    );
    if (!attachmentEdits.ok) {
      return c.html(
        renderEditPage(resolved.value, token, '添付の削除指定が正しくありません', candidateAnswers),
        400,
        PRIVATE_HEADERS,
      );
    }
    const validationInput = buildValidationInput(
      resolved.value.definition,
      body,
      visibleFieldIds,
      branchSources,
      allowBranchEdit,
    );
    const validation = validateInternalFormAnswers(validationInput.fields, validationInput.input, {
      retainedFileCounts: attachmentEdits.state.retainedFileCounts,
    });
    if (!validation.ok) {
      return c.html(
        renderEditPage(resolved.value, token, validation.error, candidateAnswers),
        400,
        PRIVATE_HEADERS,
      );
    }

    storedUploads = await storeInternalFormUploads(
      c.env.IMAGES,
      resolved.value.form.id,
      validation.pendingUploads,
    );
    const merged = Object.assign(Object.create(null) as Record<string, unknown>, storedAnswers);
    for (const field of resolved.value.definition.fields) {
      if (!visibleFieldIds.has(field.id)) delete merged[field.id];
    }
    for (const fieldId of validationInput.editableIds) delete merged[fieldId];
    Object.assign(merged, validation.answers);
    for (const [fieldId, retained] of Object.entries(attachmentEdits.state.retainedByField)) {
      const finalAttachments = mergeInternalFormAttachments(
        retained,
        storedUploads.attachmentsByField[fieldId] ?? [],
      );
      if (finalAttachments.length > 0) merged[fieldId] = finalAttachments;
      else delete merged[fieldId];
    }
    const result = await updateInternalFormSubmissionAnswers(c.env.DB, {
      formId: resolved.value.payload.formId,
      submissionId: resolved.value.payload.rowRef,
      expectedEditVersion,
      expectedEditLinkEpoch: resolved.value.payload.epoch,
      answers: merged,
    });
    if (result.status === 'revoked') {
      await rollbackInternalFormUploads(c.env.IMAGES, storedUploads.uploadedKeys);
      storedUploads = null;
      return c.html(renderInvalidPage(), 403, PRIVATE_HEADERS);
    }
    if (result.status === 'conflict') {
      await rollbackInternalFormUploads(c.env.IMAGES, storedUploads.uploadedKeys);
      storedUploads = null;
      return c.html(renderDocument('更新できませんでした', '<section class="result"><h1>回答が先に更新されています</h1><p>ページを再読み込みして、最新の回答を確認してください。</p></section>'), 409, PRIVATE_HEADERS);
    }
    mutationCommitted = true;

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
    queueSheetsSyncAfterRespondentEdit(c, resolved.value.form, readback.id);
    return c.html(renderSuccessPage(), 200, PRIVATE_HEADERS);
  } catch {
    if (storedUploads && !mutationCommitted) {
      await rollbackInternalFormUploads(c.env.IMAGES, storedUploads.uploadedKeys);
    }
    // Capability token / R2 key は bearer/private data。固定文だけを log する。
    console.error('internal form edit POST failed');
    return c.html(renderDocument('保存できませんでした', '<section class="result"><h1>保存できませんでした</h1><p>時間をおいて、もう一度お試しください。</p></section>'), 500, PRIVATE_HEADERS);
  }
});
