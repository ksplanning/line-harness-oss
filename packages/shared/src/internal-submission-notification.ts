import { isDecorationType, type HarnessField } from './formaloo-forms';

export type InternalSubmissionNotificationField = Pick<
  HarnessField,
  'id' | 'type' | 'label' | 'config'
>;

export type InternalSubmissionNotificationTemplateIssueCode =
  | 'unknown_answer_label'
  | 'duplicate_answer_label';

export interface InternalSubmissionNotificationTemplateIssue {
  code: InternalSubmissionNotificationTemplateIssueCode;
  label: string;
  message: string;
}

export type InternalSubmissionNotificationTemplateValidationResult =
  | { ok: true }
  | { ok: false; error: string; issues: InternalSubmissionNotificationTemplateIssue[] };

export interface RenderInternalSubmissionNotificationInput {
  template: string | null | undefined;
  formTitle: string;
  displayName: string | null;
  fields: readonly InternalSubmissionNotificationField[];
  answers: Readonly<Record<string, unknown>>;
  editUrl: string;
}

export type RenderInternalSubmissionNotificationResult =
  | { ok: true; text: string }
  | {
      ok: false;
      validation: Extract<InternalSubmissionNotificationTemplateValidationResult, { ok: false }>;
    };

export interface PreviewInternalSubmissionNotificationInput {
  template: string | null | undefined;
  formTitle: string;
  fields: readonly InternalSubmissionNotificationField[];
  answers?: Readonly<Record<string, unknown>>;
  displayName?: string | null;
  editUrl?: string;
}

const UNANSWERED = '（未回答）';
const SAMPLE_DISPLAY_NAME = '山田 花子';
const SAMPLE_EDIT_URL = 'https://example.test/edit/sample';

function visitTemplateTokens(
  template: string,
  visitor: (token: string, literal: string) => string,
): string {
  let cursor = 0;
  let rendered = '';

  while (cursor < template.length) {
    const start = template.indexOf('{{', cursor);
    if (start < 0) return rendered + template.slice(cursor);
    const end = template.indexOf('}}', start + 2);
    if (end < 0) return rendered + template.slice(cursor);

    rendered += template.slice(cursor, start);
    const literal = template.slice(start, end + 2);
    rendered += visitor(template.slice(start + 2, end), literal);
    cursor = end + 2;
  }

  return rendered;
}

function answerFields(
  fields: readonly InternalSubmissionNotificationField[],
): InternalSubmissionNotificationField[] {
  const repeatingColumnFieldIds = new Set(
    fields.flatMap((field) => field.type === 'repeating_section'
      ? (field.config.repeatingColumns ?? []).map((column) => column.columnField)
      : []),
  );
  return fields.filter((field) => (
    !isDecorationType(field.type) && !repeatingColumnFieldIds.has(field.id)
  ));
}

function fieldsByLabel(
  fields: readonly InternalSubmissionNotificationField[],
): Map<string, InternalSubmissionNotificationField[]> {
  const result = new Map<string, InternalSubmissionNotificationField[]>();
  for (const field of answerFields(fields)) {
    const matches = result.get(field.label) ?? [];
    matches.push(field);
    result.set(field.label, matches);
  }
  return result;
}

export function validateInternalSubmissionNotificationTemplate(
  template: string | null | undefined,
  fields: readonly InternalSubmissionNotificationField[],
): InternalSubmissionNotificationTemplateValidationResult {
  if (!template?.trim()) return { ok: true };

  const labels = fieldsByLabel(fields);
  const issues: InternalSubmissionNotificationTemplateIssue[] = [];
  const seen = new Set<string>();

  visitTemplateTokens(template, (token, literal) => {
    if (!token.startsWith('回答:')) return literal;
    const label = token.slice('回答:'.length);
    const matches = labels.get(label) ?? [];
    const code: InternalSubmissionNotificationTemplateIssueCode | null = matches.length === 0
      ? 'unknown_answer_label'
      : matches.length > 1
        ? 'duplicate_answer_label'
        : null;
    if (!code || seen.has(`${code}\u0000${label}`)) return literal;

    seen.add(`${code}\u0000${label}`);
    issues.push({
      code,
      label,
      message: code === 'unknown_answer_label'
        ? `回答項目「${label}」が見つかりません`
        : `回答項目「${label}」が${matches.length}件あるため特定できません`,
    });
    return literal;
  });

  return issues.length
    ? { ok: false, error: issues.map((issue) => issue.message).join('\n'), issues }
    : { ok: true };
}

function hasOwn(object: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let amount = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024;
    unit = units[index];
  }
  return `${Number(amount.toFixed(1))} ${unit}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function formatFileMetadata(value: unknown): string | null {
  const metadata = asRecord(value);
  if (!metadata) return null;
  const name = typeof metadata.name === 'string' && metadata.name.trim()
    ? metadata.name.trim()
    : null;
  if (!name) return null;

  const details: string[] = [];
  if (typeof metadata.size === 'number') {
    const size = formatBytes(metadata.size);
    if (size) details.push(size);
  }
  if (typeof metadata.type === 'string' && metadata.type.trim()) details.push(metadata.type.trim());
  return details.length ? `${name} (${details.join(', ')})` : name;
}

function formatScalar(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return value ? 'はい' : 'いいえ';
  if (typeof value === 'bigint') return String(value);
  return null;
}

function formatObjectEntries(value: Record<string, unknown>): string {
  const lines = Object.entries(value).flatMap(([label, answer]) => {
    const formatted = formatAnswer(answer);
    return formatted === UNANSWERED ? [] : [`${label}: ${formatted}`];
  });
  return lines.length ? lines.join('\n') : UNANSWERED;
}

function formatRepeatingRows(
  rows: unknown[],
  field: InternalSubmissionNotificationField,
): string {
  const columns = field.config.repeatingColumns ?? [];
  const rendered = rows.flatMap((row, index) => {
    const record = asRecord(row);
    if (!record) return [];
    const values = columns.length
      ? columns.flatMap((column) => {
          if (!hasOwn(record, column.columnField)) return [];
          const value = formatAnswer(record[column.columnField]);
          return value === UNANSWERED ? [] : [`${column.title}: ${value}`];
        })
      : Object.entries(record).flatMap(([key, answer]) => {
          const value = formatAnswer(answer);
          return value === UNANSWERED ? [] : [`${key}: ${value}`];
        });
    return values.length ? [`${index + 1}. ${values.join(' / ')}`] : [];
  });
  return rendered.length ? rendered.join('\n') : UNANSWERED;
}

function formatAnswer(
  value: unknown,
  field?: InternalSubmissionNotificationField,
): string {
  if (field?.type === 'signature') return formatScalar(value) ? '署名済み' : UNANSWERED;

  const scalar = formatScalar(value);
  if (scalar !== null) return scalar;
  if (value === null || value === undefined) return UNANSWERED;

  if (Array.isArray(value)) {
    if (!value.length) return UNANSWERED;
    if (field?.type === 'repeating_section') return formatRepeatingRows(value, field);

    const files = value.map(formatFileMetadata);
    if (field?.type === 'file' || files.every((item) => item !== null)) {
      const printable = files.filter((item): item is string => item !== null);
      return printable.length ? printable.join('\n') : UNANSWERED;
    }

    const values = value.flatMap((item) => {
      const formatted = formatAnswer(item);
      return formatted === UNANSWERED ? [] : [formatted];
    });
    return values.length ? values.join('、') : UNANSWERED;
  }

  const record = asRecord(value);
  if (!record) return UNANSWERED;
  const file = formatFileMetadata(record);
  if (field?.type === 'file' && file) return file;
  return formatObjectEntries(record);
}

function defaultNotificationText(input: RenderInternalSubmissionNotificationInput): string {
  const displayName = input.displayName?.trim() ?? '';
  const formTitle = input.formTitle.trim();
  const salutation = displayName ? `${displayName}さん、` : '';
  const form = formTitle ? `「${formTitle}」への` : '';
  const lines = answerFields(input.fields).map((field) => {
    const value = hasOwn(input.answers, field.id) ? input.answers[field.id] : undefined;
    return `${field.label.trim() || field.id}: ${formatAnswer(value, field)}`;
  });

  return [
    `${salutation}${form}ご回答ありがとうございます。`,
    '',
    '回答内容',
    ...(lines.length ? lines : ['（回答項目なし）']),
    '',
    '編集リンク',
    input.editUrl,
  ].join('\n');
}

export function renderInternalSubmissionNotification(
  input: RenderInternalSubmissionNotificationInput,
): RenderInternalSubmissionNotificationResult {
  if (!input.template?.trim()) return { ok: true, text: defaultNotificationText(input) };

  const validation = validateInternalSubmissionNotificationTemplate(input.template, input.fields);
  if (!validation.ok) return { ok: false, validation };

  const labels = fieldsByLabel(input.fields);
  const text = visitTemplateTokens(input.template, (token, literal) => {
    if (token === 'display_name') return input.displayName ?? '';
    if (token === '編集リンク') return input.editUrl;
    if (!token.startsWith('回答:')) return literal;

    const field = labels.get(token.slice('回答:'.length))?.[0];
    if (!field) return literal;
    const value = hasOwn(input.answers, field.id) ? input.answers[field.id] : undefined;
    return formatAnswer(value, field);
  });
  return { ok: true, text };
}

function firstMatrixChoice(field: InternalSubmissionNotificationField): string {
  for (const item of Object.values(field.config.matrixChoiceItems ?? {})) {
    const record = asRecord(item);
    if (typeof record?.title === 'string' && record.title.trim()) return record.title.trim();
  }
  return 'サンプル回答';
}

function sampleAnswer(
  field: InternalSubmissionNotificationField,
  fields: readonly InternalSubmissionNotificationField[],
  visited: ReadonlySet<string> = new Set(),
): unknown {
  if (visited.has(field.id)) return 'サンプル回答';
  const nextVisited = new Set(visited).add(field.id);

  switch (field.type) {
    case 'textarea': return 'サンプル回答です。';
    case 'choice':
    case 'dropdown': return field.config.choices?.[0] ?? '選択肢1';
    case 'multiple_select': return field.config.choices?.slice(0, 2) ?? ['選択肢1', '選択肢2'];
    case 'choice_fetch': return field.config.choiceFetchItems?.[0]?.label ?? '選択肢1';
    case 'number': return 123;
    case 'email': return 'sample@example.com';
    case 'phone': return '090-1234-5678';
    case 'date': return '2026-07-21';
    case 'time': return '10:00';
    case 'datetime': return '2026-07-21T10:00';
    case 'website': return 'https://example.com/';
    case 'yes_no': return true;
    case 'rating': return field.config.ratingSubType === 'like_dislike' ? 'like' : 5;
    case 'signature': return 'data:image/png;base64,c2FtcGxl';
    case 'file': return [{ name: 'sample.pdf', size: 1536, type: 'application/pdf' }];
    case 'country': return '日本';
    case 'postal_code': return '1000001';
    case 'prefecture': return '東京都';
    case 'address_city': return '千代田区';
    case 'address_street': return '千代田1-1';
    case 'address_building': return 'サンプルビル';
    case 'matrix': return Object.fromEntries(
      (field.config.matrixChoiceGroups ?? [{ title: '項目' }])
        .map((row) => [row.title, firstMatrixChoice(field)]),
    );
    case 'repeating_section': return [Object.fromEntries(
      (field.config.repeatingColumns ?? []).map((column) => {
        const referenced = fields.find((candidate) => candidate.id === column.columnField);
        return [column.columnField, referenced
          ? sampleAnswer(referenced, fields, nextVisited)
          : 'サンプル回答'];
      }),
    )];
    case 'variable': return field.config.variableSubType === 'string' ? 'サンプル回答' : 123;
    case 'section':
    case 'page_break':
    case 'video':
    case 'image': return undefined;
    default: return 'サンプル回答';
  }
}

function sampleAnswers(
  fields: readonly InternalSubmissionNotificationField[],
): Readonly<Record<string, unknown>> {
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of answerFields(fields)) result[field.id] = sampleAnswer(field, fields);
  return result;
}

export function previewInternalSubmissionNotification(
  input: PreviewInternalSubmissionNotificationInput,
): RenderInternalSubmissionNotificationResult {
  return renderInternalSubmissionNotification({
    template: input.template,
    formTitle: input.formTitle,
    fields: input.fields,
    answers: input.answers ?? sampleAnswers(input.fields),
    displayName: input.displayName === undefined ? SAMPLE_DISPLAY_NAME : input.displayName,
    editUrl: input.editUrl ?? SAMPLE_EDIT_URL,
  });
}
