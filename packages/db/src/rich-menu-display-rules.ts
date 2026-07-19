export const RICH_MENU_DISPLAY_CONDITION_TYPES = [
  'tag_exists',
  'tag_not_exists',
  'metadata_equals',
  'metadata_not_equals',
  'metadata_contains',
  'metadata_not_contains',
  'tag_name_contains',
  'tag_name_not_contains',
] as const;

export type RichMenuDisplayConditionType = (typeof RICH_MENU_DISPLAY_CONDITION_TYPES)[number];

export interface RichMenuDisplayRule {
  id: string;
  accountId: string;
  name: string;
  conditionType: RichMenuDisplayConditionType;
  conditionValue: string;
  richMenuId: string;
  priority: number;
  isActive: boolean;
  activeFrom: string | null;
  activeUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRichMenuDisplayRuleInput {
  accountId: string;
  name: string;
  conditionType: RichMenuDisplayConditionType;
  conditionValue: string;
  richMenuId: string;
  priority: number;
  isActive: boolean;
  activeFrom?: string | null;
  activeUntil?: string | null;
}

export type UpdateRichMenuDisplayRuleInput = Partial<Omit<CreateRichMenuDisplayRuleInput, 'accountId'>>;

interface RichMenuDisplayRuleRow {
  id: string;
  account_id: string;
  name: string;
  condition_type: RichMenuDisplayConditionType;
  condition_value: string;
  rich_menu_id: string;
  priority: number;
  is_active: number;
  active_from: string | null;
  active_until: string | null;
  created_at: string;
  updated_at: string;
}

function serializeRule(row: RichMenuDisplayRuleRow): RichMenuDisplayRule {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    conditionType: row.condition_type,
    conditionValue: row.condition_value,
    richMenuId: row.rich_menu_id,
    priority: row.priority,
    isActive: row.is_active === 1,
    activeFrom: row.active_from,
    activeUntil: row.active_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getRichMenuDisplayRule(
  db: D1Database,
  id: string,
  accountId: string,
): Promise<RichMenuDisplayRule | null> {
  const row = await db
    .prepare('SELECT * FROM rich_menu_display_rules WHERE id = ? AND account_id = ?')
    .bind(id, accountId)
    .first<RichMenuDisplayRuleRow>();
  return row ? serializeRule(row) : null;
}

/** Highest priority first. Equal priority is older rule first, then id ASC. */
export async function listRichMenuDisplayRules(
  db: D1Database,
  accountId: string,
  options: { activeOnly?: boolean } = {},
): Promise<RichMenuDisplayRule[]> {
  const activeClause = options.activeOnly ? ' AND is_active = 1' : '';
  const result = await db
    .prepare(
      `SELECT * FROM rich_menu_display_rules
       WHERE account_id = ?${activeClause}
       ORDER BY priority DESC, created_at ASC, id ASC`,
    )
    .bind(accountId)
    .all<RichMenuDisplayRuleRow>();
  return result.results.map(serializeRule);
}

export async function createRichMenuDisplayRule(
  db: D1Database,
  input: CreateRichMenuDisplayRuleInput,
): Promise<RichMenuDisplayRule> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO rich_menu_display_rules
       (id, account_id, name, condition_type, condition_value, rich_menu_id, priority, is_active, active_from, active_until)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.accountId,
      input.name,
      input.conditionType,
      input.conditionValue,
      input.richMenuId,
      input.priority,
      input.isActive ? 1 : 0,
      input.activeFrom ?? null,
      input.activeUntil ?? null,
    )
    .run();
  return (await getRichMenuDisplayRule(db, id, input.accountId))!;
}

export async function updateRichMenuDisplayRule(
  db: D1Database,
  id: string,
  accountId: string,
  patch: UpdateRichMenuDisplayRuleInput,
): Promise<RichMenuDisplayRule | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) { fields.push('name = ?'); values.push(patch.name); }
  if (patch.conditionType !== undefined) { fields.push('condition_type = ?'); values.push(patch.conditionType); }
  if (patch.conditionValue !== undefined) { fields.push('condition_value = ?'); values.push(patch.conditionValue); }
  if (patch.richMenuId !== undefined) { fields.push('rich_menu_id = ?'); values.push(patch.richMenuId); }
  if (patch.priority !== undefined) { fields.push('priority = ?'); values.push(patch.priority); }
  if (patch.isActive !== undefined) { fields.push('is_active = ?'); values.push(patch.isActive ? 1 : 0); }
  if (patch.activeFrom !== undefined) { fields.push('active_from = ?'); values.push(patch.activeFrom); }
  if (patch.activeUntil !== undefined) { fields.push('active_until = ?'); values.push(patch.activeUntil); }

  if (fields.length > 0) {
    fields.push("updated_at = strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')");
    await db
      .prepare(`UPDATE rich_menu_display_rules SET ${fields.join(', ')} WHERE id = ? AND account_id = ?`)
      .bind(...values, id, accountId)
      .run();
  }
  return getRichMenuDisplayRule(db, id, accountId);
}

export async function deleteRichMenuDisplayRule(
  db: D1Database,
  id: string,
  accountId: string,
): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM rich_menu_display_rules WHERE id = ? AND account_id = ?')
    .bind(id, accountId)
    .run();
  return (result.meta?.changes ?? 0) === 1;
}
