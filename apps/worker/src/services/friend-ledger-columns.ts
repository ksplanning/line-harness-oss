import type { SheetCellValue } from './google-sheets.js';
import { normalizeSingleLineAddress } from '@line-crm/shared';

export const FRIEND_LEDGER_IDENTITY_HEADERS = ['表示名', 'userId', '登録日'] as const;
const MAX_FORM_ANSWER_SHEET_CELL_LENGTH = 49_000;

export interface FriendFieldMapping {
  fieldId: string;
  header: string;
}

export interface FriendLedgerColumn {
  key: string;
  header: string;
  kind: 'identity' | 'custom' | 'answer';
  readOnly: boolean;
}

export interface FormAnswerField {
  fieldId: string;
  header: string;
  type?: string;
  readOnly?: boolean;
}

export type FormAnswerSheetValueParseResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      reason:
        | 'read_only'
        | 'invalid_number'
        | 'invalid_boolean'
        | 'invalid_json'
        | 'container_type_mismatch';
    };

export interface FriendLedgerHeaderWarning {
  code: 'missing_header' | 'duplicate_header' | 'configured_header_collision';
  header: string;
}

export interface ResolvedFriendLedgerHeaders {
  indexByKey: Record<string, number>;
  warnings: FriendLedgerHeaderWarning[];
}

export interface FriendLedgerProjectionSource {
  id: string;
  lineUserId: string;
  displayName: string | null;
  registeredAt: string;
  metadata: Record<string, unknown>;
}

const IDENTITY_COLUMNS: FriendLedgerColumn[] = [
  { key: 'identity:displayName', header: '表示名', kind: 'identity', readOnly: true },
  { key: 'identity:lineUserId', header: 'userId', kind: 'identity', readOnly: true },
  { key: 'identity:registeredAt', header: '登録日', kind: 'identity', readOnly: true },
];

export function buildFriendLedgerColumns(mappings: FriendFieldMapping[]): FriendLedgerColumn[] {
  return [
    ...IDENTITY_COLUMNS.map((column) => ({ ...column })),
    ...mappings.map((mapping) => ({
      key: `field:${mapping.fieldId}`,
      header: mapping.header,
      kind: 'custom' as const,
      readOnly: false,
    })),
  ];
}

export function buildFormAnswerColumns(
  formId: string,
  fields: FormAnswerField[],
): FriendLedgerColumn[] {
  return fields.map((field) => ({
    key: `answer:${formId}:${field.fieldId}`,
    header: field.header,
    kind: 'answer' as const,
    readOnly: field.readOnly === true,
  }));
}

export function resolveFriendLedgerHeaders(
  headers: SheetCellValue[],
  columns: FriendLedgerColumn[],
): ResolvedFriendLedgerHeaders {
  const actualPositions = new Map<string, number[]>();
  headers.forEach((value, index) => {
    const header = normalizeSheetCell(value);
    if (!actualPositions.has(header)) actualPositions.set(header, []);
    actualPositions.get(header)!.push(index);
  });

  const configuredCounts = new Map<string, number>();
  for (const column of columns) {
    configuredCounts.set(column.header, (configuredCounts.get(column.header) ?? 0) + 1);
  }

  const warnings: FriendLedgerHeaderWarning[] = [];
  const warningKeys = new Set<string>();
  const addWarning = (warning: FriendLedgerHeaderWarning) => {
    const key = `${warning.code}:${warning.header}`;
    if (!warningKeys.has(key)) {
      warningKeys.add(key);
      warnings.push(warning);
    }
  };

  for (const [header, count] of configuredCounts) {
    if (count > 1) addWarning({ code: 'configured_header_collision', header });
  }
  for (const [header, positions] of actualPositions) {
    if (header && positions.length > 1) addWarning({ code: 'duplicate_header', header });
  }

  const indexByKey: Record<string, number> = {};
  for (const column of columns) {
    if ((configuredCounts.get(column.header) ?? 0) > 1) continue;
    const positions = actualPositions.get(column.header) ?? [];
    if (positions.length === 0) {
      addWarning({ code: 'missing_header', header: column.header });
    } else if (positions.length === 1) {
      indexByKey[column.key] = positions[0];
    }
  }
  return { indexByKey, warnings };
}

export function normalizeSheetCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

export function projectFriendLedgerRow(
  friend: FriendLedgerProjectionSource,
  mappings: FriendFieldMapping[],
): Record<string, string> {
  const projection: Record<string, string> = {
    'identity:displayName': friend.displayName ?? '',
    'identity:lineUserId': friend.lineUserId,
    'identity:registeredAt': friend.registeredAt,
  };
  for (const mapping of mappings) {
    projection[`field:${mapping.fieldId}`] = normalizeSheetCell(friend.metadata[mapping.header]);
  }
  return projection;
}

export function projectFormAnswerRow(
  formId: string,
  fields: FormAnswerField[],
  answers: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(fields.map((field) => [
    `answer:${formId}:${field.fieldId}`,
    projectFormAnswerValue(field, answers[field.fieldId]),
  ]));
}

function projectFormAnswerValue(field: FormAnswerField, value: unknown): string {
  if (field.type === 'signature') {
    return normalizeSheetCell(value) ? '[署名あり]' : '';
  }
  if (field.type === 'file') {
    if (Array.isArray(value)) {
      return value.length > 0 ? `[添付ファイル ${value.length}件]` : '';
    }
    return normalizeSheetCell(value) ? '[添付ファイルあり]' : '';
  }
  const normalized = field.type === 'address'
    ? normalizeSingleLineAddress(normalizeSheetCell(value)).trim()
    : normalizeSheetCell(value);
  return normalized.length > MAX_FORM_ANSWER_SHEET_CELL_LENGTH
    ? `[回答が長いため省略（${normalized.length}文字）]`
    : normalized;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseFormAnswerSheetValue(
  field: FormAnswerField,
  observed: string,
  current: unknown,
): FormAnswerSheetValueParseResult {
  if (field.readOnly === true) return { ok: false, reason: 'read_only' };
  if (normalizeSheetCell(current).length > MAX_FORM_ANSWER_SHEET_CELL_LENGTH) {
    return { ok: false, reason: 'read_only' };
  }

  const trimmed = observed.trim();
  if (field.type === 'number') {
    if (!trimmed) return { ok: false, reason: 'invalid_number' };
    const value = Number(trimmed);
    return Number.isFinite(value)
      ? { ok: true, value }
      : { ok: false, reason: 'invalid_number' };
  }
  if (field.type === 'yes_no') {
    const normalized = trimmed.toLowerCase();
    if (normalized === 'true') return { ok: true, value: true };
    if (normalized === 'false') return { ok: true, value: false };
    return { ok: false, reason: 'invalid_boolean' };
  }

  if (field.type === 'address') {
    return { ok: true, value: normalizeSingleLineAddress(observed).trim() };
  }

  const currentIsArray = Array.isArray(current) || field.type === 'multiple_select';
  const currentIsObject = isJsonObject(current);
  if (currentIsArray || currentIsObject) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(observed) as unknown;
    } catch {
      return { ok: false, reason: 'invalid_json' };
    }
    if (
      (currentIsArray && !Array.isArray(parsed))
      || (currentIsObject && !isJsonObject(parsed))
    ) {
      return { ok: false, reason: 'container_type_mismatch' };
    }
    return { ok: true, value: parsed };
  }

  return { ok: true, value: observed };
}

export function mergeFriendProjectionIntoRow(
  existing: SheetCellValue[],
  projection: Record<string, string>,
  columns: FriendLedgerColumn[],
  resolved: ResolvedFriendLedgerHeaders,
): SheetCellValue[] {
  const merged = [...existing];
  for (const column of columns) {
    const index = resolved.indexByKey[column.key];
    if (index !== undefined) merged[index] = projection[column.key] ?? '';
  }
  return merged;
}
