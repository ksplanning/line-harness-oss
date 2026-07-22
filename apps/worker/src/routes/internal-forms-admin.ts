import { Hono, type Context, type Next } from 'hono';
import {
  countInternalFormSubmissionsForForm,
  getFormalooFieldMap,
  getFormalooForm,
  getInternalFormSubmission,
  hasBlockingFormalooRecurringSubmissions,
  jstNow,
  listInternalFormSubmissions,
  publishInternalFormDefinition,
  saveFormalooDefinition,
  saveInternalFormDefinition,
  softDeleteInternalFormSubmission,
  switchFormRenderBackendToDraft,
  unpublishInternalFormDefinition,
  updateInternalFormSubmissionAnswers,
  type FormalooForm,
  type InternalFormSubmission,
} from '@line-crm/db';
import {
  evaluateInternalFormLogic,
  isInternalOnlyFieldType,
  mergeFormOperationsSettings,
  normalizeFormCopy,
  normalizeFormDesign,
  normalizeFormRedirect,
  normalizeSuccessPages,
  validateFormOperationsSettingsPatch,
  validateHarnessField,
  type FormDesign,
  type FormOperationsSettingsPatch,
  type HarnessField,
} from '@line-crm/shared';
import { uploadImageDataUrlToR2, resolveInBodyImageUploads } from '../services/form-image-upload.js';
import { syncSheetsAfterFormMutation } from '../services/sheets-sync-jobs.js';
import { parseAllowedOrigins } from '../middleware/admin-auth-config.js';
import {
  evaluateInternalFormAvailability,
  parseInternalFormDefinition,
  validateInternalFormAnswers,
  type InternalAnswerInput,
  type InternalFormDefinition,
  type InternalFormField,
} from '../services/internal-form-runtime.js';
import { validateFormRedirectInput } from '../services/formaloo-redirect.js';
import { isEditableField, repeatingTemplateIds } from './internal-form-edit-public.js';
import type { Env } from '../index.js';

export const internalFormsAdmin = new Hono<Env>();

function queueSheetsSyncAfterAdminEdit(
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
      actor: c.get('staff').id,
      credentialsJson: c.env.GOOGLE_SERVICE_ACCOUNT_JSON,
      adminOrigin: parseAllowedOrigins(c.env)[0] ?? null,
    }).catch(() => {
      console.error('Immediate Google Sheets sync after admin answer edit failed');
    });
    c.executionCtx.waitUntil(work);
  } catch {
    console.error('Immediate Google Sheets sync after admin answer edit failed');
  }
}

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

type DefinitionField = {
  id: string;
  label: string;
  type: string;
  required: boolean;
};

function parseIntSafe(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function queryInternalSubmissions(
  db: D1Database,
  formId: string,
  params: {
    q?: string | null;
    from?: string | null;
    to?: string | null;
    sortDir: 'asc' | 'desc';
    limit: number;
    offset: number;
  },
): Promise<{ rows: InternalFormSubmission[]; total: number }> {
  const where = ['form_id = ?', 'deleted_at IS NULL'];
  const binds: unknown[] = [formId];
  if (params.q) {
    where.push("(answers_json LIKE ? OR IFNULL(friend_id, '') LIKE ?)");
    const like = `%${params.q}%`;
    binds.push(like, like);
  }
  if (params.from) {
    where.push('julianday(submitted_at) >= julianday(?)');
    binds.push(params.from);
  }
  if (params.to) {
    where.push('julianday(submitted_at) <= julianday(?)');
    binds.push(params.to);
  }

  const whereSql = where.join(' AND ');
  const direction = params.sortDir === 'asc' ? 'ASC' : 'DESC';
  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM internal_form_submissions WHERE ${whereSql}`)
    .bind(...binds)
    .first<{ n: number }>();
  const rows = await db
    .prepare(
      `SELECT * FROM internal_form_submissions
       WHERE ${whereSql}
       ORDER BY julianday(submitted_at) ${direction}, rowid ${direction}
       LIMIT ? OFFSET ?`,
    )
    .bind(...binds, params.limit, params.offset)
    .all<InternalFormSubmission>();
  return { rows: rows.results, total: totalRow?.n ?? 0 };
}

function definitionFields(definitionJson: string): DefinitionField[] {
  try {
    const definition = JSON.parse(definitionJson) as { fields?: unknown };
    if (!Array.isArray(definition.fields)) return [];
    return definition.fields.flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
      const field = candidate as Record<string, unknown>;
      if (typeof field.id !== 'string' || !field.id) return [];
      return [{
        id: field.id,
        label: typeof field.label === 'string' && field.label ? field.label : field.id,
        type: typeof field.type === 'string' ? field.type : 'text',
        required: field.required === true,
      }];
    });
  } catch {
    return [];
  }
}

function parseAnswers(answersJson: string): unknown {
  try {
    return JSON.parse(answersJson) as unknown;
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function answerRecord(answersJson: string): Record<string, unknown> {
  const parsed = parseAnswers(answersJson);
  return isRecord(parsed)
    ? Object.assign(Object.create(null) as Record<string, unknown>, parsed)
    : Object.create(null) as Record<string, unknown>;
}

function visibleInternalFieldIds(
  definition: InternalFormDefinition,
  row: InternalFormSubmission,
  answers: Record<string, unknown>,
): Set<string> {
  return new Set(evaluateInternalFormLogic(
    definition.fields,
    definition.logic,
    answers,
    row.origin_channel === 'line' ? 'line' : 'web',
  ).visibleFieldIds);
}

function normalizeAdminAnswerValue(
  field: InternalFormField,
  value: unknown,
): { ok: true; value?: InternalAnswerInput[string] } | { ok: false } {
  if (value === undefined) return { ok: true };
  if (value === null) return { ok: true, value: '' };
  if (typeof value === 'string') return { ok: true, value };
  if (typeof value === 'number' && Number.isFinite(value)) {
    return { ok: true, value: String(value) };
  }
  if (typeof value === 'boolean') {
    return { ok: true, value: field.type === 'yes_no' ? (value ? 'yes' : 'no') : String(value) };
  }
  if (Array.isArray(value) && value.every((item) => (
    typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
  ))) {
    return { ok: true, value: value.map(String) };
  }
  return { ok: false };
}

function buildAdminValidationInput(
  definition: InternalFormDefinition,
  candidateAnswers: Record<string, unknown>,
  visibleFieldIds: ReadonlySet<string>,
):
  | { ok: true; fields: InternalFormField[]; input: InternalAnswerInput; editableIds: string[] }
  | { ok: false; error: string } {
  const templates = repeatingTemplateIds(definition.fields);
  const fields: InternalFormField[] = [];
  const input = Object.create(null) as InternalAnswerInput;
  const editableIds: string[] = [];

  for (const field of definition.fields) {
    const editable = isEditableField(field, templates);
    if (editable) editableIds.push(field.id);
    if (!visibleFieldIds.has(field.id)) continue;
    const formula = field.type === 'variable' && field.config.variableSubType === 'formula';
    if (!editable && !formula) continue;
    const validationIndex = fields.length;
    fields.push(field);
    if (!editable) continue;
    const normalized = normalizeAdminAnswerValue(field, candidateAnswers[field.id]);
    if (!normalized.ok) return { ok: false, error: `${field.label}の値が不正です` };
    if (normalized.value !== undefined) input[`a_${validationIndex}`] = normalized.value;
  }
  return { ok: true, fields, input, editableIds };
}

function parseAdminEditVersion(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseAnswerRevision(value: unknown): string | null {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

async function internalAnswerRevision(answersJson: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(answersJson),
  ));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function internalEditMetadata(
  form: FormalooForm,
  definition: InternalFormDefinition,
  row: InternalFormSubmission,
) {
  const visibleFieldIds = visibleInternalFieldIds(definition, row, answerRecord(row.answers_json));
  const templates = repeatingTemplateIds(definition.fields);
  const allowPostEdit = form.allow_post_edit === 1 ? 1 : 0;
  return {
    allowPostEdit,
    fields: definition.fields.map((field) => {
      const visible = visibleFieldIds.has(field.id);
      const editableWhenVisible = allowPostEdit === 1 && isEditableField(field, templates);
      return {
        slug: field.id,
        label: field.label,
        type: field.type,
        required: field.required,
        ...(field.type === 'multiple_select'
          ? { choices: [...(field.config.choices ?? [])] }
          : {}),
        editable: editableWhenVisible && visible,
        editableWhenVisible,
        visible,
      };
    }),
  };
}

function serializeRow(row: InternalFormSubmission) {
  return {
    id: row.id,
    friendId: row.friend_id,
    answers: parseAnswers(row.answers_json),
    submittedAt: row.submitted_at,
    // A friend id is persisted only after the signed fr_id is verified and the
    // friend exists, so this is the internal equivalent of Formaloo `verified`.
    verified: row.friend_id !== null,
  };
}

async function getInternalForm(db: D1Database, formId: string): Promise<FormalooForm | null> {
  const form = await getFormalooForm(db, formId);
  if (!form || form.deleted || form.render_backend !== 'internal') return null;
  return form;
}

function jsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function internalPublishRevision(form: FormalooForm): Promise<string> {
  const snapshot = JSON.stringify([
    form.id,
    form.definition_json,
    form.title,
    form.description,
  ]);
  const digest = new Uint8Array(await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(snapshot),
  ));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function publicBase(c: Context<Env>): string {
  return (c.env.WORKER_URL || new URL(c.req.url).origin).replace(/\/+$/, '');
}

async function serializeInternalForm(c: Context<Env>, form: FormalooForm) {
  const parsed = parseInternalFormDefinition(form.definition_json);
  if (!parsed.ok) throw new Error(parsed.error);
  const raw = jsonObject(form.definition_json);
  const submitCount = await countInternalFormSubmissionsForForm(c.env.DB, form.id);
  const published = form.builder_status === 'published';
  const base = publicBase(c);
  return {
    id: form.id,
    title: form.title,
    description: form.description,
    formalooSlug: form.formaloo_slug,
    renderBackend: 'internal' as const,
    builderStatus: form.builder_status,
    publishedAt: form.published_at,
    submitCount,
    onSubmitTagId: form.on_submit_tag_id,
    onSubmitScenarioId: form.on_submit_scenario_id,
    submitMessage: form.submit_message,
    allowPostEdit: form.allow_post_edit,
    allowEditMail: form.allow_edit_mail,
    editMailFieldId: null,
    fields: parsed.definition.fields,
    logic: parsed.definition.logic,
    logicFingerprint: null,
    design: parsed.definition.design,
    formType: parsed.definition.formType,
    formCopy: {
      buttonText: parsed.definition.buttonText ?? '送信する',
      successMessage: parsed.definition.successMessage ?? form.submit_message ?? '送信ありがとうございました',
      errorMessage: parsed.definition.errorMessage ?? '送信に失敗しました',
    },
    localizationJa: raw.localizationJa === true,
    formRedirect: parsed.definition.formRedirect,
    successPages: parsed.definition.successPages,
    operationsSettings: parsed.definition.operationsSettings,
    friendMetadataMappings: [],
    publicUrl: published ? `${base}/f/${encodeURIComponent(form.id)}` : null,
    embedCode: null,
    syncStatus: 'idle',
    syncError: null,
    driftStatus: 'none',
    driftDetectedAt: null,
    driftHasWarnings: false,
    lineAccountId: form.line_account_id,
    ...(c.get('staff')?.role === 'owner' ? { workspaceId: form.workspace_id } : {}),
    folderId: form.folder_id,
    updatedAt: form.updated_at,
    publishRevision: await internalPublishRevision(form),
    internalAvailability: evaluateInternalFormAvailability(parsed.definition, submitCount),
  };
}

async function loadInternalOrNext(c: Context<Env>, next: Next) {
  const expectedBackend = c.req.header('X-Form-Render-Backend');
  const form = await getInternalForm(c.env.DB, c.req.param('id')!);
  if ((!form && expectedBackend === 'internal') || (form && expectedBackend === 'formaloo')) {
    return {
      form: null,
      response: c.json({
        success: false,
        error: '配信方式が更新されました。再読み込みしてください',
      }, 409),
    } as const;
  }
  if (!form) return { form: null, response: await next() } as const;
  return { form, response: null } as const;
}

function notFound(c: Context<Env>) {
  return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
}

function definitionObject(definitionJson: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(definitionJson) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function formalooSwitchError(definitionJson: string): string | null {
  const definition = definitionObject(definitionJson);
  if (!definition || !Array.isArray(definition.fields)) return '保存済みフォーム定義を読み込めません';
  for (const candidate of definition.fields) {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const field = candidate as { type?: unknown; config?: unknown };
    if (isInternalOnlyFieldType(field.type)) return '自前フォーム専用の入力項目が含まれています';
    if (field.config === null || typeof field.config !== 'object' || Array.isArray(field.config)) continue;
    const config = field.config as Record<string, unknown>;
    const internalConfig = ['placeholder', 'defaultValue', 'defaultValues', 'minLength'].some((key) => hasOwn(config, key))
      || (field.type === 'textarea' && hasOwn(config, 'maxLength'));
    if (internalConfig) return '自前フォーム専用の入力設定が含まれています';
  }
  return null;
}

async function rejectInternalFormalooMutation(c: Context<Env>, next: Next) {
  try {
    const form = await getInternalForm(c.env.DB, c.req.param('id')!);
    if (!form) return next();
    return c.json({
      success: false,
      error: '自前配信では Formaloo 専用操作を利用できません',
    }, 409);
  } catch (error) {
    console.error('internal form provider guard error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
}

internalFormsAdmin.get('/api/forms-advanced/:id/render-backend', async (c) => {
  try {
    const form = await getFormalooForm(c.env.DB, c.req.param('id'));
    if (!form || form.deleted) return notFound(c);
    return c.json({ success: true, data: { renderBackend: form.render_backend } });
  } catch (error) {
    console.error('GET /api/forms-advanced/:id/render-backend error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

internalFormsAdmin.patch('/api/forms-advanced/:id/render-backend', async (c) => {
  try {
    const id = c.req.param('id');
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return notFound(c);

    const body = await c.req.json<{ renderBackend?: unknown }>().catch(() => null);
    const renderBackend = body?.renderBackend;
    if (renderBackend !== 'formaloo' && renderBackend !== 'internal') {
      return c.json({ success: false, error: 'renderBackend は formaloo または internal を指定してください' }, 400);
    }
    if (renderBackend === form.render_backend) {
      return c.json({ success: true, data: { renderBackend } });
    }

    const incompatibility = renderBackend === 'internal'
      ? (() => {
          const parsed = parseInternalFormDefinition(form.definition_json);
          return parsed.ok ? null : parsed.error;
        })()
      : formalooSwitchError(form.definition_json);
    if (incompatibility) {
      return c.json({
        success: false,
        error: `現在のフォーム定義では配信先を切り替えられません: ${incompatibility}`,
      }, 409);
    }

    if (renderBackend !== form.render_backend) {
      if (renderBackend === 'internal') {
        if (await hasBlockingFormalooRecurringSubmissions(c.env.DB, id)) {
          return c.json({
            success: false,
            error: '定期自動回答をすべて取消してから自前配信へ切り替えてください',
          }, 409);
        }
        const parsed = parseInternalFormDefinition(form.definition_json);
        if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 409);
      } else {
        return c.json({
          success: false,
          error: '自前配信で編集した内容を失わないため、Formaloo 配信には戻せません',
        }, 409);
      }

      // Switching provider and returning to draft must be one visible state
      // transition: content confirmed for one renderer is never exposed live by
      // the other renderer without a fresh publish confirmation.
      const switched = await switchFormRenderBackendToDraft(c.env.DB, {
        formId: id,
        expectedBackend: form.render_backend,
        nextBackend: renderBackend,
        expectedDefinitionJson: form.definition_json,
        expectedUpdatedAt: form.updated_at,
      });
      if (!switched) {
        return c.json({
          success: false,
          error: '保存処理中のため、完了後にもう一度切り替えてください',
        }, 409);
      }
      return c.json({
        success: true,
        data: { renderBackend, builderStatus: 'draft' },
      });
    }

    return c.json({ success: true, data: { renderBackend } });
  } catch (error) {
    console.error('PATCH /api/forms-advanced/:id/render-backend error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

internalFormsAdmin.put('/api/forms-advanced/:id/internal-definition', async (c, next) => {
  try {
    const id = c.req.param('id');
    const form = await getInternalForm(c.env.DB, id);
    if (!form) return next();

    const body = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!body) return c.json({ success: false, error: 'JSON body が必要です' }, 400);
    if (!Array.isArray(body.fields)) {
      return c.json({ success: false, error: 'fields は配列で指定してください' }, 400);
    }
    if (body.logic !== undefined && (!Array.isArray(body.logic) || body.logic.length > 0)) {
      return c.json({ success: false, error: '自前配信の分岐設定はまだ利用できません' }, 400);
    }
    if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim())) {
      return c.json({ success: false, error: 'フォーム名を入力してください' }, 400);
    }
    if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
      return c.json({ success: false, error: 'フォーム説明は文字列で指定してください' }, 400);
    }
    if (hasOwn(body, 'formType') && body.formType !== 'simple' && body.formType !== 'multi_step') {
      return c.json({ success: false, error: 'formType は simple または multi_step を指定してください' }, 400);
    }

    const fields: HarnessField[] = [];
    for (let index = 0; index < body.fields.length; index++) {
      const raw = body.fields[index];
      const position = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as { position?: unknown }).position
        : undefined;
      const validation = validateHarnessField({
        ...(raw && typeof raw === 'object' ? raw : {}),
        position: typeof position === 'number' ? position : index,
      }, { allowInternalOnly: true });
      if (!validation.ok) {
        return c.json({ success: false, error: `フィールド ${index + 1}: ${validation.error}` }, 400);
      }
      fields.push(validation.field);
    }

    const currentDefinition = definitionObject(form.definition_json);
    if (!currentDefinition) {
      return c.json({ success: false, error: '保存済みフォーム定義を読み込めません' }, 422);
    }
    const nextDefinition: Record<string, unknown> = {
      ...currentDefinition,
      fields,
      logic: [],
    };
    const designProvided = hasOwn(body, 'design');
    const designImagesProvided = hasOwn(body, 'designImages');
    let designToResolve: FormDesign | undefined;
    if (designProvided || designImagesProvided) {
      const currentDesign = currentDefinition.design
        && typeof currentDefinition.design === 'object'
        && !Array.isArray(currentDefinition.design)
        ? currentDefinition.design as FormDesign
        : {};
      designToResolve = designProvided
        ? { ...currentDesign, ...normalizeFormDesign(body.design) }
        : { ...currentDesign };
    }
    if (hasOwn(body, 'formCopy')) {
      const formCopy = normalizeFormCopy(body.formCopy);
      if (Object.keys(formCopy).length > 0) nextDefinition.formCopy = formCopy;
      else delete nextDefinition.formCopy;
    }
    if (hasOwn(body, 'formType')) nextDefinition.formType = body.formType;

    const runtimeValidation = parseInternalFormDefinition(JSON.stringify(nextDefinition));
    if (!runtimeValidation.ok) {
      return c.json({ success: false, error: runtimeValidation.error }, 400);
    }

    const uploadOrigin = new URL(c.req.url).origin;
    const imageResult = await resolveInBodyImageUploads(
      fields,
      (dataUrl) => uploadImageDataUrlToR2(c.env, dataUrl, id, uploadOrigin),
      designProvided || designImagesProvided
        ? {
            design: designToResolve,
            designImages: designImagesProvided ? body.designImages : undefined,
          }
        : undefined,
    );
    if (!imageResult.ok) {
      return c.json({ success: false, error: '画像の保存に失敗しました (サイズ/形式)' }, 400);
    }
    nextDefinition.fields = fields;
    if (designProvided || designImagesProvided) {
      if (imageResult.design && Object.keys(imageResult.design).length > 0) {
        nextDefinition.design = imageResult.design;
      } else {
        delete nextDefinition.design;
      }
    }

    const definitionJson = JSON.stringify(nextDefinition);
    if (definitionJson.includes('data:image')) {
      return c.json({ success: false, error: '画像の保存に失敗しました (サイズ/形式)' }, 400);
    }

    const existingMap = await getFormalooFieldMap(c.env.DB, id);
    const existingSlugs = new Map(existingMap.map((row) => [row.id, row.formaloo_field_slug]));
    await saveFormalooDefinition(c.env.DB, id, {
      definitionJson,
      fields: fields.map((field) => ({
        id: field.id,
        formalooFieldSlug: existingSlugs.get(field.id) ?? null,
        fieldType: field.type,
        label: field.label,
        position: field.position,
        configJson: JSON.stringify(field.config),
      })),
      title: typeof body.title === 'string' ? body.title.trim() : undefined,
      description: body.description === undefined
        ? undefined
        : typeof body.description === 'string' && body.description.trim()
          ? body.description.trim()
          : null,
    });

    return c.json({ success: true, data: null });
  } catch (error) {
    console.error('PUT internal /api/forms-advanced/:id/internal-definition error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// Internal definitions are authoritative in D1. These exact-path handlers sit
// before formsAdvanced so no Formaloo sync state or network request is touched.
internalFormsAdmin.get('/api/forms-advanced/:id', async (c, next) => {
  try {
    const loaded = await loadInternalOrNext(c, next);
    if (!loaded.form) return loaded.response;
    return c.json({ success: true, data: await serializeInternalForm(c, loaded.form) });
  } catch (error) {
    console.error('GET internal /api/forms-advanced/:id error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

internalFormsAdmin.put('/api/forms-advanced/:id', async (c, next) => {
  try {
    const loaded = await loadInternalOrNext(c, next);
    if (!loaded.form) return loaded.response;
    const form = loaded.form;
    const body = await c.req.json<Record<string, unknown>>()
      .catch(() => ({} as Record<string, unknown>));
    if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim())) {
      return c.json({ success: false, error: 'フォーム名を入力してください' }, 400);
    }
    if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
      return c.json({ success: false, error: '説明の形式が不正です' }, 400);
    }
    if (body.formType !== undefined && body.formType !== 'simple' && body.formType !== 'multi_step') {
      return c.json({ success: false, error: '表示形式が不正です' }, 400);
    }
    const redirectCheck = validateFormRedirectInput(body.formRedirect);
    if (!redirectCheck.ok) return c.json({ success: false, error: redirectCheck.error }, 400);

    const previous = jsonObject(form.definition_json);
    let operationsPatch: FormOperationsSettingsPatch = {};
    if (body.operationsSettings !== undefined) {
      const validation = validateFormOperationsSettingsPatch(body.operationsSettings);
      if (!validation.ok) return c.json({ success: false, error: validation.error }, 400);
      operationsPatch = validation.patch;
    }
    const operationsSettings = body.operationsSettings === undefined
      ? previous.operationsSettings
      : mergeFormOperationsSettings(previous.operationsSettings, operationsPatch);
    const rawFields = body.fields === undefined ? previous.fields : body.fields;
    const fieldsWithPositions = Array.isArray(rawFields)
      ? rawFields.map((field, index) => (
        field && typeof field === 'object' && !Array.isArray(field)
          ? { ...field, position: typeof (field as { position?: unknown }).position === 'number'
            ? (field as { position: number }).position
            : index }
          : field
      ))
      : rawFields;
    const candidate: Record<string, unknown> = {
      ...previous,
      fields: fieldsWithPositions,
      logic: body.logic === undefined ? previous.logic : body.logic,
      design: body.design === undefined
        ? previous.design
        : { ...normalizeFormDesign(previous.design), ...normalizeFormDesign(body.design) },
      formType: body.formType === undefined ? previous.formType : body.formType,
      formCopy: body.formCopy === undefined ? previous.formCopy : normalizeFormCopy(body.formCopy),
      formRedirect: body.formRedirect === undefined ? previous.formRedirect : normalizeFormRedirect(body.formRedirect),
      successPages: body.successPages === undefined ? previous.successPages : normalizeSuccessPages(body.successPages),
      operationsSettings,
    };
    if (operationsSettings && typeof operationsSettings === 'object'
      && Object.keys(operationsSettings as object).length === 0) delete candidate.operationsSettings;

    const parsed = parseInternalFormDefinition(JSON.stringify(candidate));
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const designProvided = hasOwn(body, 'design');
    const designImagesProvided = hasOwn(body, 'designImages');
    const uploadOrigin = new URL(c.req.url).origin;
    const imageResult = await resolveInBodyImageUploads(
      parsed.definition.fields,
      (dataUrl) => uploadImageDataUrlToR2(c.env, dataUrl, form.id, uploadOrigin),
      designProvided || designImagesProvided
        ? {
            design: parsed.definition.design,
            designImages: designImagesProvided ? body.designImages : undefined,
          }
        : undefined,
    );
    if (!imageResult.ok) {
      return c.json({ success: false, error: '画像の保存に失敗しました (サイズ/形式)' }, 400);
    }

    candidate.fields = parsed.definition.fields;
    candidate.logic = parsed.definition.logic;
    candidate.design = imageResult.design ?? parsed.definition.design;
    candidate.formType = parsed.definition.formType;
    candidate.formRedirect = parsed.definition.formRedirect;
    candidate.successPages = parsed.definition.successPages;
    candidate.formCopy = normalizeFormCopy(candidate.formCopy);
    const definitionJson = JSON.stringify(candidate);
    if (definitionJson.includes('data:image')) {
      return c.json({ success: false, error: '画像の保存に失敗しました (サイズ/形式)' }, 400);
    }

    const title = typeof body.title === 'string' ? body.title.trim() : form.title;
    const description = body.description === undefined
      ? form.description
      : (typeof body.description === 'string' && body.description.trim() ? body.description : null);
    const updatedAt = jstNow();
    // Build the exact response before committing. A later editor may win after this
    // save, but must never make this request return a revision the caller did not save.
    const responseData = await serializeInternalForm(c, {
      ...form,
      definition_json: definitionJson,
      title,
      description,
      builder_status: 'draft',
      updated_at: updatedAt,
    });
    const saved = await saveInternalFormDefinition(c.env.DB, {
      formId: form.id,
      definitionJson,
      title,
      description,
      updatedAt,
    });
    if (!saved) {
      return c.json({
        success: false,
        error: '配信方式が変更されたため、再読み込みしてください',
      }, 409);
    }
    return c.json({ success: true, data: responseData });
  } catch (error) {
    console.error('PUT internal /api/forms-advanced/:id error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

internalFormsAdmin.post('/api/forms-advanced/:id/submit-for-review', async (c, next) => {
  try {
    const loaded = await loadInternalOrNext(c, next);
    if (!loaded.form) return loaded.response;
    return c.json({
      success: false,
      error: '自前配信は公開確認画面から直接公開してください',
    }, 409);
  } catch (error) {
    console.error('POST internal submit-for-review error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

internalFormsAdmin.post('/api/forms-advanced/:id/publish', async (c, next) => {
  try {
    const loaded = await loadInternalOrNext(c, next);
    if (!loaded.form) return loaded.response;
    const parsed = parseInternalFormDefinition(loaded.form.definition_json);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 409);
    if (!['draft', 'in_review', 'published'].includes(loaded.form.builder_status)) {
      return c.json({ success: false, error: 'この状態から公開できません' }, 409);
    }
    const body = await c.req.json<{ publishRevision?: unknown }>().catch(() => null);
    const revision = await internalPublishRevision(loaded.form);
    if (typeof body?.publishRevision !== 'string' || body.publishRevision !== revision) {
      return c.json({
        success: false,
        error: 'フォーム内容が更新されたため、もう一度確認して公開してください',
      }, 409);
    }
    // Build the complete success payload before the state transition. After the
    // compare-and-set commits, no fallible D1 read may turn a live form into a
    // client-visible failure response.
    const committedAt = jstNow();
    const responseData = await serializeInternalForm(c, {
      ...loaded.form,
      builder_status: 'published',
      published_at: loaded.form.published_at ?? committedAt,
      updated_at: committedAt,
    });
    const published = await publishInternalFormDefinition(c.env.DB, {
      formId: loaded.form.id,
      definitionJson: loaded.form.definition_json,
      title: loaded.form.title,
      description: loaded.form.description,
      updatedAt: loaded.form.updated_at,
      publishedAt: committedAt,
    });
    if (!published) {
      return c.json({
        success: false,
        error: 'フォーム内容が更新されたため、もう一度確認して公開してください',
      }, 409);
    }
    return c.json({ success: true, data: responseData });
  } catch (error) {
    console.error('POST internal publish error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

internalFormsAdmin.post('/api/forms-advanced/:id/unpublish', async (c, next) => {
  try {
    const loaded = await loadInternalOrNext(c, next);
    if (!loaded.form) return loaded.response;
    if (loaded.form.builder_status !== 'published') {
      return c.json({ success: false, error: 'この状態から下書きに戻せません' }, 409);
    }
    const body = await c.req.json<{ expectedUpdatedAt?: unknown }>().catch(() => null);
    if (typeof body?.expectedUpdatedAt !== 'string' || !body.expectedUpdatedAt) {
      return c.json({ success: false, error: '画面を再読み込みしてから非公開にしてください' }, 400);
    }
    if (body.expectedUpdatedAt !== loaded.form.updated_at) {
      return c.json({
        success: false,
        error: 'フォーム内容が更新されたため、再読み込みしてから非公開にしてください',
      }, 409);
    }
    const committedAt = jstNow();
    const responseData = await serializeInternalForm(c, {
      ...loaded.form,
      builder_status: 'draft',
      updated_at: committedAt,
    });
    const unpublished = await unpublishInternalFormDefinition(c.env.DB, {
      formId: loaded.form.id,
      definitionJson: loaded.form.definition_json,
      title: loaded.form.title,
      description: loaded.form.description,
      updatedAt: loaded.form.updated_at,
      unpublishedAt: committedAt,
    });
    if (!unpublished) {
      return c.json({
        success: false,
        error: 'フォーム内容が更新されたため、再読み込みしてから非公開にしてください',
      }, 409);
    }
    return c.json({ success: true, data: responseData });
  } catch (error) {
    console.error('POST internal unpublish error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// These routes depend on Formaloo or its D1 mirror. Internal forms must never fall
// through to them, while Formaloo forms continue to the existing handlers byte-for-byte.
internalFormsAdmin.get('/api/forms-advanced/:id/export.csv', rejectInternalFormalooMutation);
internalFormsAdmin.delete('/api/forms-advanced/:id', rejectInternalFormalooMutation);
internalFormsAdmin.get('/api/forms-advanced/:id/pull', rejectInternalFormalooMutation);
internalFormsAdmin.get('/api/forms-advanced/:id/embed', rejectInternalFormalooMutation);
internalFormsAdmin.post('/api/forms-advanced/:id/reapply-hosted', rejectInternalFormalooMutation);
internalFormsAdmin.delete('/api/forms-advanced/:id/rows/:rowId', async (c, next) => {
  try {
    const id = c.req.param('id');
    const form = await getInternalForm(c.env.DB, id);
    if (!form) return next();
    const deleted = await softDeleteInternalFormSubmission(
      c.env.DB,
      id,
      c.req.param('rowId'),
    );
    if (!deleted) return c.json({ success: false, error: '回答が見つかりません' }, 404);
    return c.json({ success: true, data: null });
  } catch (error) {
    console.error('DELETE internal /api/forms-advanced/:id/rows/:rowId error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});
internalFormsAdmin.patch('/api/forms-advanced/:id/rows/:rowId', async (c, next) => {
  try {
    const id = c.req.param('id');
    const form = await getInternalForm(c.env.DB, id);
    if (!form) return next();
    if (form.allow_post_edit !== 1) {
      return c.json({ success: false, error: 'このフォームは回答編集を許可していません' }, 403);
    }

    const body = await c.req.json<unknown>().catch(() => null);
    if (!isRecord(body) || !isRecord(body.answers)) {
      return c.json({ success: false, error: '編集内容が不正です' }, 400);
    }
    const expectedEditVersion = parseAdminEditVersion(body.editVersion);
    const expectedAnswerRevision = parseAnswerRevision(body.answerRevision);
    if (expectedEditVersion === null || expectedAnswerRevision === null) {
      return c.json({ success: false, error: '回答を再読み込みしてから保存してください' }, 400);
    }

    const row = await getInternalFormSubmission(c.env.DB, id, c.req.param('rowId'));
    if (!row) return c.json({ success: false, error: '回答が見つかりません' }, 404);
    if (await internalAnswerRevision(row.answers_json) !== expectedAnswerRevision) {
      return c.json({
        success: false,
        error: '回答が先に更新されています。再読み込みしてから保存してください',
      }, 409);
    }
    const parsed = parseInternalFormDefinition(form.definition_json);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 409);

    const storedAnswers = answerRecord(row.answers_json);
    const templates = repeatingTemplateIds(parsed.definition.fields);
    const editableFieldIds = new Set(parsed.definition.fields
      .filter((field) => isEditableField(field, templates))
      .map((field) => field.id));
    const rejectedField = Object.keys(body.answers).find((fieldId) => !editableFieldIds.has(fieldId));
    if (rejectedField) {
      return c.json({ success: false, error: '編集できない項目が含まれています' }, 400);
    }

    const candidateAnswers = Object.assign(
      Object.create(null) as Record<string, unknown>,
      storedAnswers,
      body.answers,
    );
    const originalVisibleFieldIds = visibleInternalFieldIds(parsed.definition, row, storedAnswers);
    const visibleFieldIds = visibleInternalFieldIds(parsed.definition, row, candidateAnswers);
    const alwaysHiddenField = Object.keys(body.answers).find((fieldId) => (
      !originalVisibleFieldIds.has(fieldId) && !visibleFieldIds.has(fieldId)
    ));
    if (alwaysHiddenField) {
      return c.json({ success: false, error: '編集できない項目が含まれています' }, 400);
    }
    const validationInput = buildAdminValidationInput(
      parsed.definition,
      candidateAnswers,
      visibleFieldIds,
    );
    if (!validationInput.ok) {
      return c.json({ success: false, error: validationInput.error }, 400);
    }
    const validation = validateInternalFormAnswers(validationInput.fields, validationInput.input);
    if (!validation.ok) return c.json({ success: false, error: validation.error }, 400);

    const merged = Object.assign(Object.create(null) as Record<string, unknown>, storedAnswers);
    for (const fieldId of validationInput.editableIds) delete merged[fieldId];
    Object.assign(merged, validation.answers);
    const updated = await updateInternalFormSubmissionAnswers(c.env.DB, {
      authorization: 'admin',
      formId: id,
      submissionId: row.id,
      expectedEditVersion,
      expectedAnswersJson: row.answers_json,
      expectedDefinitionJson: form.definition_json,
      answers: merged,
    });
    if (updated.status !== 'updated') {
      return c.json({
        success: false,
        error: '回答が先に更新されています。再読み込みしてから保存してください',
      }, 409);
    }
    queueSheetsSyncAfterAdminEdit(c, form, updated.submission.id);
    const metadata = internalEditMetadata(form, parsed.definition, updated.submission);
    return c.json({
      success: true,
      data: {
        ...serializeRow(updated.submission),
        source: 'internal',
        ...metadata,
        editVersion: updated.submission.edit_version,
        answerRevision: await internalAnswerRevision(updated.submission.answers_json),
        lastEdit: null,
      },
    });
  } catch (error) {
    console.error('PATCH internal /api/forms-advanced/:id/rows/:rowId error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});
internalFormsAdmin.post('/api/forms-advanced/:id/import', rejectInternalFormalooMutation);
internalFormsAdmin.post('/api/forms-advanced/:id/rows/bulk-delete', rejectInternalFormalooMutation);
internalFormsAdmin.post('/api/forms-advanced/:id/gsheet/connect', rejectInternalFormalooMutation);
internalFormsAdmin.get('/api/forms-advanced/:id/recurring-submissions', rejectInternalFormalooMutation);
internalFormsAdmin.post('/api/forms-advanced/:id/recurring-submissions', rejectInternalFormalooMutation);
internalFormsAdmin.put('/api/forms-advanced/:id/recurring-submissions/:slug', rejectInternalFormalooMutation);
internalFormsAdmin.patch('/api/forms-advanced/:id/recurring-submissions/:slug', rejectInternalFormalooMutation);
internalFormsAdmin.delete('/api/forms-advanced/:id/recurring-submissions/:slug', rejectInternalFormalooMutation);
internalFormsAdmin.get('/api/forms-advanced/:id/instant-webhook', rejectInternalFormalooMutation);
internalFormsAdmin.put('/api/forms-advanced/:id/instant-webhook', rejectInternalFormalooMutation);
internalFormsAdmin.get('/api/forms-advanced/:id/drift-events', rejectInternalFormalooMutation);

internalFormsAdmin.get('/api/forms-advanced/:id/share', async (c, next) => {
  try {
    const id = c.req.param('id');
    const form = await getInternalForm(c.env.DB, id);
    if (!form) return next();

    const published = form.builder_status === 'published';
    const base = publicBase(c);
    const parsed = parseInternalFormDefinition(form.definition_json);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 409);
    const submitCount = await countInternalFormSubmissionsForForm(c.env.DB, id);
    return c.json({
      success: true,
      data: {
        published,
        publicUrl: published ? `${base}/f/${encodeURIComponent(id)}` : null,
        lineDistUrl: published ? `${base}/fo/${encodeURIComponent(id)}` : null,
        iframeCode: null,
        scriptCode: null,
        gsheetConnected: false,
        gsheetUrl: null,
        internalAvailability: evaluateInternalFormAvailability(parsed.definition, submitCount),
      },
    });
  } catch (error) {
    console.error('GET internal /api/forms-advanced/:id/share error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

internalFormsAdmin.get('/api/forms-advanced/:id/rows', async (c, next) => {
  try {
    const id = c.req.param('id');
    const form = await getInternalForm(c.env.DB, id);
    if (!form) return next();

    const page = Math.max(1, parseIntSafe(c.req.query('page'), 1));
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseIntSafe(c.req.query('pageSize'), DEFAULT_PAGE_SIZE)),
    );
    const { rows, total } = await queryInternalSubmissions(c.env.DB, id, {
      q: c.req.query('q') ?? null,
      from: c.req.query('from') ?? null,
      to: c.req.query('to') ?? null,
      sortDir: c.req.query('sort') === 'asc' ? 'asc' : 'desc',
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    const fields = definitionFields(form.definition_json)
      .map((field) => ({ slug: field.id, label: field.label }));

    return c.json({
      success: true,
      data: { rows: rows.map(serializeRow), total, page, pageSize, fields },
    });
  } catch (error) {
    console.error('GET internal /api/forms-advanced/:id/rows error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

internalFormsAdmin.get('/api/forms-advanced/:id/rows/:rowId', async (c, next) => {
  try {
    const id = c.req.param('id');
    const form = await getInternalForm(c.env.DB, id);
    if (!form) return next();

    const row = await getInternalFormSubmission(c.env.DB, id, c.req.param('rowId'));
    if (!row) return c.json({ success: false, error: '回答が見つかりません' }, 404);
    const parsed = parseInternalFormDefinition(form.definition_json);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 409);
    const metadata = internalEditMetadata(form, parsed.definition, row);

    return c.json({
      success: true,
      data: {
        ...serializeRow(row),
        source: 'internal',
        ...metadata,
        editVersion: row.edit_version,
        answerRevision: await internalAnswerRevision(row.answers_json),
        lastEdit: null,
      },
    });
  } catch (error) {
    console.error('GET internal /api/forms-advanced/:id/rows/:rowId error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

/** ファイル名に使えない文字を全角/削除で無害化 (Content-Disposition 事故防止 / exports.ts と同型)。 */
function sanitizeFilename(name: string): string {
  const sanitized = name.replace(/[\\/:*?"<>|\r\n]/g, '_');
  const truncated: string[] = [];
  for (const character of sanitized) {
    if (truncated.length >= 80) break;
    const codePoint = character.codePointAt(0);
    // Lone surrogate は encodeURIComponent が例外にするため、保存値に含まれても安全に置換する。
    truncated.push(codePoint !== undefined && codePoint >= 0xd800 && codePoint <= 0xdfff ? '_' : character);
  }
  return truncated.join('');
}

/** RFC 5987 attr-char に含まれない encodeURIComponent の未変換文字も percent encode する。 */
function encodeRfc5987Filename(name: string): string {
  return encodeURIComponent(sanitizeFilename(name)).replace(/['()*]/g, (character) => (
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

/**
 * 保存 entry.type は利用者入力由来 (アップロード時のクライアント申告 MIME)。
 * 厳格な `type/subtype` 形式のみヘッダーへ通し、それ以外 (制御文字入り等) は
 * application/octet-stream へ落とす。
 */
const MIME_TYPE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]{0,126}$/;

// 認証付き添付ファイルダウンロード。公開 (無認証) 配信は作らない。
// auth/permission は /api/* の共通 middleware を継承する。
internalFormsAdmin.get('/api/forms-advanced/:id/rows/:rowId/files/:fieldId/:index', async (c, next) => {
  try {
    const id = c.req.param('id');
    const form = await getInternalForm(c.env.DB, id);
    if (!form) return next();

    // getInternalFormSubmission は SQL で form_id を強制する (他フォームの rowId 横断不可)。
    const row = await getInternalFormSubmission(c.env.DB, id, c.req.param('rowId'));
    if (!row) return c.json({ success: false, error: '回答が見つかりません' }, 404);

    const answers = parseAnswers(row.answers_json);
    const value = answers !== null && typeof answers === 'object' && !Array.isArray(answers)
      ? (answers as Record<string, unknown>)[c.req.param('fieldId')]
      : undefined;
    if (!Array.isArray(value)) return c.json({ success: false, error: 'ファイルが見つかりません' }, 404);

    const rawIndex = c.req.param('index');
    const index = /^\d+$/.test(rawIndex) ? Number.parseInt(rawIndex, 10) : -1;
    if (index < 0 || index >= value.length) {
      return c.json({ success: false, error: 'ファイルが見つかりません' }, 404);
    }

    const entry = value[index] as { key?: unknown; name?: unknown; type?: unknown } | null;
    const key = typeof entry?.key === 'string' ? entry.key : '';
    // Defense in depth: 提供する R2 キーは必ず本フォーム配下に限定する。
    if (!key.startsWith(`internal-form-submissions/${id}/`)) {
      return c.json({ success: false, error: 'ファイルが見つかりません' }, 404);
    }

    const object = await c.env.IMAGES.get(key);
    if (!object) return c.json({ success: false, error: 'ファイルが見つかりません' }, 404);

    const name = typeof entry?.name === 'string' && entry.name !== '' ? entry.name : 'attachment';
    const contentType = typeof entry?.type === 'string' && MIME_TYPE_PATTERN.test(entry.type)
      ? entry.type
      : 'application/octet-stream';
    return c.body(object.body, 200, {
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeRfc5987Filename(name)}`,
    });
  } catch (error) {
    console.error('GET internal /api/forms-advanced/:id/rows/:rowId/files error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

internalFormsAdmin.get('/api/forms-advanced/:id/stats', async (c, next) => {
  try {
    const id = c.req.param('id');
    const form = await getInternalForm(c.env.DB, id);
    if (!form) return next();

    const verifiedRow = await c.env.DB
      .prepare(
        `SELECT COUNT(*) AS n FROM internal_form_submissions
         WHERE form_id = ? AND friend_id IS NOT NULL AND deleted_at IS NULL`,
      )
      .bind(id)
      .first<{ n: number }>();
    const dailyRows = await c.env.DB
      .prepare(
        `SELECT substr(submitted_at, 1, 10) AS day, COUNT(*) AS count
         FROM internal_form_submissions
         WHERE form_id = ? AND deleted_at IS NULL
         GROUP BY substr(submitted_at, 1, 10)
         ORDER BY day ASC`,
      )
      .bind(id)
      .all<{ day: string; count: number }>();
    const { total } = await listInternalFormSubmissions(c.env.DB, id, { limit: 1, offset: 0 });

    return c.json({
      success: true,
      data: {
        total,
        verified: verifiedRow?.n ?? 0,
        daily: dailyRows.results,
        formaloo: null,
      },
    });
  } catch (error) {
    console.error('GET internal /api/forms-advanced/:id/stats error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});
