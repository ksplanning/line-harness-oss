import { jstNow } from './utils.js';

interface FriendFieldDefinitionRow {
  id: string;
  name: string;
  default_value: string;
  display_order: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface FriendFieldDefinition {
  id: string;
  name: string;
  defaultValue: string;
  displayOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateFriendFieldDefinitionInput {
  name: string;
  defaultValue: string;
  displayOrder: number;
  isActive: boolean;
}

export type UpdateFriendFieldDefinitionInput = Partial<
  Pick<CreateFriendFieldDefinitionInput, 'name' | 'defaultValue' | 'displayOrder' | 'isActive'>
>;

function serialize(row: FriendFieldDefinitionRow): FriendFieldDefinition {
  return {
    id: row.id,
    name: row.name,
    defaultValue: row.default_value,
    displayOrder: row.display_order,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listFriendFieldDefinitions(
  db: D1Database,
  options: { activeOnly?: boolean } = {},
): Promise<FriendFieldDefinition[]> {
  const activeClause = options.activeOnly ? 'WHERE is_active = 1' : '';
  const result = await db
    .prepare(
      `SELECT * FROM friend_field_definitions
       ${activeClause}
       ORDER BY display_order ASC, id ASC`,
    )
    .all<FriendFieldDefinitionRow>();
  return result.results.map(serialize);
}

export async function getFriendFieldDefinition(
  db: D1Database,
  id: string,
): Promise<FriendFieldDefinition | null> {
  const row = await db
    .prepare('SELECT * FROM friend_field_definitions WHERE id = ?')
    .bind(id)
    .first<FriendFieldDefinitionRow>();
  return row ? serialize(row) : null;
}

export async function createFriendFieldDefinition(
  db: D1Database,
  input: CreateFriendFieldDefinitionInput,
): Promise<FriendFieldDefinition> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO friend_field_definitions
         (id, name, default_value, display_order, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.name,
      input.defaultValue,
      input.displayOrder,
      input.isActive ? 1 : 0,
      now,
      now,
    )
    .run();
  return (await getFriendFieldDefinition(db, id))!;
}

export async function updateFriendFieldDefinition(
  db: D1Database,
  id: string,
  patch: UpdateFriendFieldDefinitionInput,
): Promise<FriendFieldDefinition | null> {
  const existing = await getFriendFieldDefinition(db, id);
  if (!existing) return null;

  await db
    .prepare(
      `UPDATE friend_field_definitions
       SET name = ?, default_value = ?, display_order = ?, is_active = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(
      patch.name ?? existing.name,
      patch.defaultValue ?? existing.defaultValue,
      patch.displayOrder ?? existing.displayOrder,
      (patch.isActive ?? existing.isActive) ? 1 : 0,
      jstNow(),
      id,
    )
    .run();
  return getFriendFieldDefinition(db, id);
}

export async function deleteFriendFieldDefinition(
  db: D1Database,
  id: string,
): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM friend_field_definitions WHERE id = ?')
    .bind(id)
    .run();
  return ((result as { meta?: { changes?: number } }).meta?.changes ?? 0) === 1;
}
