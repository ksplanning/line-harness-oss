import { jstNow } from './utils.js';

/** A single option returned by a Formaloo choice_fetch endpoint. */
export interface FormalooChoiceListItem {
  label: string;
  value: string;
}

export interface FormalooChoiceList {
  id: string;
  form_id: string;
  name: string;
  items_json: string;
  created_at: string;
  updated_at: string;
}

export interface ParsedFormalooChoiceList extends Omit<FormalooChoiceList, 'items_json'> {
  items: FormalooChoiceListItem[];
}

export class ChoiceListError extends Error {
  constructor(public readonly status: 400 | 404, message: string) {
    super(message);
    this.name = 'ChoiceListError';
  }
}

const MAX_LIST_NAME_LENGTH = 100;

function validateName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) throw new ChoiceListError(400, 'リスト名を入力してください');
  if (name.length > MAX_LIST_NAME_LENGTH) {
    throw new ChoiceListError(400, 'リスト名は100文字以内で入力してください');
  }
  return name;
}

function validateItems(value: unknown): FormalooChoiceListItem[] {
  if (!Array.isArray(value)) {
    throw new ChoiceListError(400, '選択肢は配列で指定してください');
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ChoiceListError(400, '選択肢の形式が正しくありません');
    }
    const candidate = item as Record<string, unknown>;
    const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
    const itemValue = typeof candidate.value === 'string' ? candidate.value.trim() : '';
    if (!label || !itemValue) {
      throw new ChoiceListError(400, '各選択肢には label と value が必要です');
    }
    return { label, value: itemValue };
  });
}

function parseRow(row: FormalooChoiceList): ParsedFormalooChoiceList {
  let items: FormalooChoiceListItem[] = [];
  try {
    items = validateItems(JSON.parse(row.items_json));
  } catch {
    // Corrupt local data must not leak an invalid response to Formaloo.
    items = [];
  }
  const { items_json: _itemsJson, ...rest } = row;
  return { ...rest, items };
}

export async function listFormalooChoiceLists(
  db: D1Database,
  formId: string,
): Promise<ParsedFormalooChoiceList[]> {
  const result = await db
    .prepare('SELECT * FROM formaloo_choice_lists WHERE form_id = ? ORDER BY updated_at DESC, id ASC')
    .bind(formId)
    .all<FormalooChoiceList>();
  return result.results.map(parseRow);
}

export async function getFormalooChoiceList(
  db: D1Database,
  formId: string,
  listId: string,
): Promise<ParsedFormalooChoiceList | null> {
  const row = await db
    .prepare('SELECT * FROM formaloo_choice_lists WHERE id = ? AND form_id = ?')
    .bind(listId, formId)
    .first<FormalooChoiceList>();
  return row ? parseRow(row) : null;
}

export async function createFormalooChoiceList(
  db: D1Database,
  formId: string,
  input: { name: unknown; items: unknown },
): Promise<ParsedFormalooChoiceList> {
  const id = `fcl_${crypto.randomUUID()}`;
  const name = validateName(input.name);
  const items = validateItems(input.items);
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO formaloo_choice_lists
         (id, form_id, name, items_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, formId, name, JSON.stringify(items), now, now)
    .run();
  return (await getFormalooChoiceList(db, formId, id))!;
}

export async function updateFormalooChoiceList(
  db: D1Database,
  formId: string,
  listId: string,
  patch: { name?: unknown; items?: unknown },
): Promise<ParsedFormalooChoiceList> {
  const current = await getFormalooChoiceList(db, formId, listId);
  if (!current) throw new ChoiceListError(404, '選択肢リストが見つかりません');
  if (!Object.prototype.hasOwnProperty.call(patch, 'name') && !Object.prototype.hasOwnProperty.call(patch, 'items')) {
    throw new ChoiceListError(400, '更新する項目を指定してください');
  }
  const name = Object.prototype.hasOwnProperty.call(patch, 'name') ? validateName(patch.name) : current.name;
  const items = Object.prototype.hasOwnProperty.call(patch, 'items') ? validateItems(patch.items) : current.items;
  await db
    .prepare('UPDATE formaloo_choice_lists SET name = ?, items_json = ?, updated_at = ? WHERE id = ? AND form_id = ?')
    .bind(name, JSON.stringify(items), jstNow(), listId, formId)
    .run();
  return (await getFormalooChoiceList(db, formId, listId))!;
}

export async function deleteFormalooChoiceList(
  db: D1Database,
  formId: string,
  listId: string,
): Promise<void> {
  const result = await db
    .prepare('DELETE FROM formaloo_choice_lists WHERE id = ? AND form_id = ?')
    .bind(listId, formId)
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new ChoiceListError(404, '選択肢リストが見つかりません');
  }
}
