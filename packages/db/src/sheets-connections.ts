import { jstNow } from './utils.js';

export type SheetsSyncDirection = 'to_sheets' | 'from_sheets' | 'bidirectional';
export type SheetsConflictPolicy = 'last_write_wins';

export interface SheetsConnection {
  id: string;
  lineAccountId: string;
  formId: string;
  spreadsheetId: string;
  sheetName: string;
  syncDirection: SheetsSyncDirection;
  conflictPolicy: SheetsConflictPolicy;
  conflictClock: 'server_sequence';
  configVersion: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface SheetsConnectionRow {
  id: string;
  line_account_id: string;
  form_id: string;
  spreadsheet_id: string;
  sheet_name: string;
  sync_direction: SheetsSyncDirection;
  conflict_policy: SheetsConflictPolicy;
  conflict_clock: 'server_sequence';
  config_version: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export interface CreateSheetsConnectionInput {
  lineAccountId: string;
  formId: string;
  spreadsheetId: string;
  sheetName: string;
  syncDirection: SheetsSyncDirection;
}

export interface UpdateSheetsConnectionInput {
  spreadsheetId: string;
  sheetName: string;
  syncDirection: SheetsSyncDirection;
}

function serialize(row: SheetsConnectionRow): SheetsConnection {
  return {
    id: row.id,
    lineAccountId: row.line_account_id,
    formId: row.form_id,
    spreadsheetId: row.spreadsheet_id,
    sheetName: row.sheet_name,
    syncDirection: row.sync_direction,
    conflictPolicy: row.conflict_policy,
    conflictClock: row.conflict_clock,
    configVersion: row.config_version,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ACTIVE_SELECT = `
  SELECT id, line_account_id, form_id, spreadsheet_id, sheet_name,
         sync_direction, conflict_policy, conflict_clock, config_version,
         is_active, created_at, updated_at
  FROM sheets_connections
  WHERE is_active = 1 AND deleted_at IS NULL`;

export async function listSheetsConnections(
  db: D1Database,
  lineAccountId: string,
  formId?: string,
): Promise<SheetsConnection[]> {
  const query = formId
    ? `${ACTIVE_SELECT} AND line_account_id = ? AND form_id = ? ORDER BY updated_at DESC, id ASC`
    : `${ACTIVE_SELECT} AND line_account_id = ? ORDER BY updated_at DESC, id ASC`;
  const statement = db.prepare(query);
  const result = formId
    ? await statement.bind(lineAccountId, formId).all<SheetsConnectionRow>()
    : await statement.bind(lineAccountId).all<SheetsConnectionRow>();
  return result.results.map(serialize);
}

export async function getSheetsConnection(
  db: D1Database,
  lineAccountId: string,
  id: string,
): Promise<SheetsConnection | null> {
  const row = await db.prepare(`${ACTIVE_SELECT} AND line_account_id = ? AND id = ?`)
    .bind(lineAccountId, id)
    .first<SheetsConnectionRow>();
  return row ? serialize(row) : null;
}

export async function createSheetsConnection(
  db: D1Database,
  input: CreateSheetsConnectionInput,
): Promise<SheetsConnection> {
  const id = `gsc_${crypto.randomUUID()}`;
  const now = jstNow();
  await db.prepare(
    `INSERT INTO sheets_connections
       (id, line_account_id, form_id, spreadsheet_id, sheet_name, sync_direction,
        conflict_policy, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'last_write_wins', 1, ?, ?)`,
  ).bind(
    id,
    input.lineAccountId,
    input.formId,
    input.spreadsheetId,
    input.sheetName,
    input.syncDirection,
    now,
    now,
  ).run();
  const created = await getSheetsConnection(db, input.lineAccountId, id);
  if (!created) throw new Error('Sheets connection was not created');
  return created;
}

export async function updateSheetsConnection(
  db: D1Database,
  lineAccountId: string,
  id: string,
  input: UpdateSheetsConnectionInput,
): Promise<SheetsConnection | null> {
  const update = db.prepare(
    `UPDATE sheets_connections
     SET spreadsheet_id = ?, sheet_name = ?, sync_direction = ?,
         config_version = config_version + 1, updated_at = ?
     WHERE id = ? AND line_account_id = ? AND is_active = 1 AND deleted_at IS NULL`,
  ).bind(
    input.spreadsheetId,
    input.sheetName,
    input.syncDirection,
    jstNow(),
    id,
    lineAccountId,
  );
  // Every accepted settings write advances the generation. D1 serializes the
  // increments, so concurrent owner tabs remain last-write-wins without a false
  // not-found response. Old workers then fail the ledger version triggers.
  const result = (await db.batch([
    update,
    db.prepare(
      `DELETE FROM sheets_sync_ledger
       WHERE connection_id = ?
         AND EXISTS (
           SELECT 1 FROM sheets_connections
           WHERE id = ? AND line_account_id = ? AND is_active = 1 AND deleted_at IS NULL
         )`,
    ).bind(id, id, lineAccountId),
  ]))[0];
  if ((result.meta.changes ?? 0) !== 1) return null;
  return getSheetsConnection(db, lineAccountId, id);
}

export async function softDeleteSheetsConnection(
  db: D1Database,
  lineAccountId: string,
  id: string,
): Promise<boolean> {
  const now = jstNow();
  const result = (await db.batch([
    db.prepare(
      `UPDATE sheets_connections
       SET is_active = 0, deleted_at = ?, updated_at = ?
       WHERE id = ? AND line_account_id = ? AND is_active = 1 AND deleted_at IS NULL`,
    ).bind(now, now, id, lineAccountId),
    db.prepare(
      `DELETE FROM sheets_sync_ledger
       WHERE connection_id = ?
         AND EXISTS (SELECT 1 FROM sheets_connections WHERE id = ? AND line_account_id = ?)`,
    ).bind(id, id, lineAccountId),
  ]))[0];
  return (result.meta.changes ?? 0) === 1;
}

/**
 * Atomically allocates the ordering key used by last-write-wins.
 * A stale worker must present its captured config version and receives null
 * after any settings save, so it cannot publish a write under a new target.
 */
export async function reserveSheetsSyncSequence(
  db: D1Database,
  lineAccountId: string,
  id: string,
  configVersion: number,
): Promise<number | null> {
  const row = await db.prepare(
    `UPDATE sheets_connections
     SET next_sync_sequence = next_sync_sequence + 1
     WHERE id = ? AND line_account_id = ? AND config_version = ?
       AND is_active = 1 AND deleted_at IS NULL
     RETURNING next_sync_sequence - 1 AS sequence`,
  ).bind(id, lineAccountId, configVersion).first<{ sequence: number }>();
  return row?.sequence ?? null;
}
