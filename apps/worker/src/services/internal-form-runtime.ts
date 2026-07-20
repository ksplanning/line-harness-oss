import { validateHarnessField, type HarnessField } from '@line-crm/shared';

const BASIC_TYPES = new Set([
  'text',
  'textarea',
  'number',
  'email',
  'phone',
  'date',
  'choice',
  'dropdown',
  'multiple_select',
] as const);

export type InternalFormField = HarnessField & {
  type: 'text' | 'textarea' | 'number' | 'email' | 'phone' | 'date' | 'choice' | 'dropdown' | 'multiple_select';
};

export interface InternalFormDefinition {
  fields: InternalFormField[];
  buttonText: string | null;
  successMessage: string | null;
}

export type InternalAnswerInput = Record<string, string | string[] | undefined>;

export function parseInternalFormDefinition(
  definitionJson: string,
): { ok: true; definition: InternalFormDefinition } | { ok: false; error: string } {
  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(definitionJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid definition');
    raw = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, error: 'フォーム定義を読み込めません' };
  }

  if (!Array.isArray(raw.fields)) return { ok: false, error: 'フォーム項目を読み込めません' };
  if (Array.isArray(raw.logic) && raw.logic.length > 0) {
    return { ok: false, error: 'このフォームの分岐設定は自前配信ではまだ利用できません' };
  }

  const ids = new Set<string>();
  const fields: InternalFormField[] = [];
  for (const item of raw.fields) {
    const result = validateHarnessField(item);
    if (!result.ok || !BASIC_TYPES.has(result.field.type as InternalFormField['type'])) {
      return { ok: false, error: '未対応の項目を含むため自前配信できません' };
    }
    if (ids.has(result.field.id)) return { ok: false, error: '項目IDが重複しています' };
    ids.add(result.field.id);

    const field = result.field as InternalFormField;
    if (field.config.maxLength !== undefined && (
      !Number.isInteger(field.config.maxLength) || field.config.maxLength < 1
    )) {
      return { ok: false, error: '文字数上限が正しくありません' };
    }
    if (field.type === 'choice' || field.type === 'dropdown' || field.type === 'multiple_select') {
      const choices = field.config.choices;
      if (!choices?.length || new Set(choices).size !== choices.length || choices.some((choice) => !choice)) {
        return { ok: false, error: '選択肢が正しくありません' };
      }
    }
    fields.push(field);
  }

  fields.sort((a, b) => a.position - b.position);
  const formCopy = raw.formCopy && typeof raw.formCopy === 'object' && !Array.isArray(raw.formCopy)
    ? raw.formCopy as Record<string, unknown>
    : {};
  return {
    ok: true,
    definition: {
      fields,
      buttonText: typeof formCopy.buttonText === 'string' && formCopy.buttonText.trim()
        ? formCopy.buttonText.trim()
        : null,
      successMessage: typeof formCopy.successMessage === 'string' && formCopy.successMessage.trim()
        ? formCopy.successMessage.trim()
        : null,
    },
  };
}

function scalar(values: string | string[] | undefined): string[] {
  if (typeof values === 'string') return [values];
  return Array.isArray(values) ? values : [];
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function invalidFormat(label: string) {
  return { ok: false as const, error: `${label} の形式が正しくありません` };
}

export function validateInternalFormAnswers(
  fields: InternalFormField[],
  input: InternalAnswerInput,
): { ok: true; answers: Record<string, unknown> } | { ok: false; error: string } {
  const answers: Record<string, unknown> = Object.create(null) as Record<string, unknown>;

  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    const values = scalar(input[`a_${index}`]);

    if (field.type === 'multiple_select') {
      const selected = [...new Set(values.filter((value) => value !== ''))];
      if (field.required && selected.length === 0) {
        return { ok: false, error: `${field.label} は必須項目です` };
      }
      const choices = field.config.choices ?? [];
      if (selected.some((value) => !choices.includes(value))) {
        return { ok: false, error: `${field.label} の選択肢が正しくありません` };
      }
      answers[field.id] = selected;
      continue;
    }

    if (values.length > 1) return invalidFormat(field.label);
    const value = values[0] ?? '';
    if (field.required && value.trim() === '') {
      return { ok: false, error: `${field.label} は必須項目です` };
    }

    if ((field.type === 'text' || field.type === 'textarea') && field.config.maxLength !== undefined) {
      if (Array.from(value).length > field.config.maxLength) {
        return { ok: false, error: `${field.label} は${field.config.maxLength}文字以内で入力してください` };
      }
    }

    if (value === '') {
      answers[field.id] = '';
      continue;
    }

    if (field.type === 'number') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return invalidFormat(field.label);
      answers[field.id] = parsed;
      continue;
    }
    if (field.type === 'email') {
      const normalized = value.trim();
      if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
        return invalidFormat(field.label);
      }
      answers[field.id] = normalized;
      continue;
    }
    if (field.type === 'phone') {
      const normalized = value.trim();
      const digitCount = normalized.replace(/\D/g, '').length;
      if (!/^[+\d][\d\s()+-]*$/.test(normalized) || digitCount < 6 || digitCount > 15) {
        return invalidFormat(field.label);
      }
      answers[field.id] = normalized;
      continue;
    }
    if (field.type === 'date') {
      if (!validDate(value)) return invalidFormat(field.label);
      answers[field.id] = value;
      continue;
    }
    if (field.type === 'choice' || field.type === 'dropdown') {
      if (!(field.config.choices ?? []).includes(value)) {
        return { ok: false, error: `${field.label} の選択肢が正しくありません` };
      }
      answers[field.id] = value;
      continue;
    }
    answers[field.id] = value;
  }

  return { ok: true, answers };
}
