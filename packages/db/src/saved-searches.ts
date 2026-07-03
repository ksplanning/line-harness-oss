import { jstNow } from './utils.js';
// =============================================================================
// Saved Searches (G10 保存済み検索 / セグメント) — 友だち絞込条件を名前付きで保存・再利用。
// conditions は broadcast が消費する SegmentCondition JSON ({operator, rules[]}) と同一形式。
// =============================================================================

export interface SavedSearch {
  id: string;
  lineAccountId: string | null;
  name: string;
  conditions: string; // SegmentCondition JSON 文字列
  createdAt: string;
  updatedAt: string;
}

interface SavedSearchRow {
  id: string;
  line_account_id: string | null;
  name: string;
  conditions: string;
  created_at: string;
  updated_at: string;
}

function serialize(row: SavedSearchRow): SavedSearch {
  return {
    id: row.id,
    lineAccountId: row.line_account_id,
    name: row.name,
    conditions: row.conditions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * List saved searches visible to an account: the account's own rows plus the
 * global (line_account_id IS NULL) rows, newest first. Mirrors the auto_replies
 * account+global visibility convention.
 */
export async function listSavedSearches(
  db: D1Database,
  lineAccountId: string | null,
): Promise<SavedSearch[]> {
  if (lineAccountId) {
    const result = await db
      .prepare(
        `SELECT * FROM saved_searches WHERE (line_account_id IS NULL OR line_account_id = ?) ORDER BY created_at DESC`,
      )
      .bind(lineAccountId)
      .all<SavedSearchRow>();
    return result.results.map(serialize);
  }
  const result = await db
    .prepare(`SELECT * FROM saved_searches WHERE line_account_id IS NULL ORDER BY created_at DESC`)
    .all<SavedSearchRow>();
  return result.results.map(serialize);
}

export async function getSavedSearchById(db: D1Database, id: string): Promise<SavedSearch | null> {
  const row = await db.prepare(`SELECT * FROM saved_searches WHERE id = ?`).bind(id).first<SavedSearchRow>();
  return row ? serialize(row) : null;
}

export interface CreateSavedSearchInput {
  lineAccountId: string | null;
  name: string;
  conditions: string; // 既に stringify 済の SegmentCondition JSON
}

export async function createSavedSearch(db: D1Database, input: CreateSavedSearchInput): Promise<SavedSearch> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO saved_searches (id, line_account_id, name, conditions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.lineAccountId ?? null, input.name, input.conditions, now, now)
    .run();
  return (await getSavedSearchById(db, id))!;
}

export async function renameSavedSearch(db: D1Database, id: string, name: string): Promise<SavedSearch | null> {
  const existing = await getSavedSearchById(db, id);
  if (!existing) return null;
  await db
    .prepare(`UPDATE saved_searches SET name = ?, updated_at = ? WHERE id = ?`)
    .bind(name, jstNow(), id)
    .run();
  return getSavedSearchById(db, id);
}

export async function updateSavedSearchConditions(
  db: D1Database,
  id: string,
  conditions: string,
): Promise<SavedSearch | null> {
  const existing = await getSavedSearchById(db, id);
  if (!existing) return null;
  await db
    .prepare(`UPDATE saved_searches SET conditions = ?, updated_at = ? WHERE id = ?`)
    .bind(conditions, jstNow(), id)
    .run();
  return getSavedSearchById(db, id);
}

export async function deleteSavedSearch(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM saved_searches WHERE id = ?`).bind(id).run();
}
