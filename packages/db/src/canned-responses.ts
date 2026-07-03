import { jstNow } from './utils.js';
// =============================================================================
// Canned Responses (G23 チャット定型文) — 個別 1:1 チャットの返信に差し込む定型文。
// message_templates (配信テンプレ) とは別責務。挿入 UI は本文を入力欄に貼るだけで
// 送信経路 (POST /api/chats/:id/send) には一切触れない。
// account+global 可視性 (line_account_id IS NULL = 全アカ共通) を saved_searches と同流儀で持つ。
// =============================================================================

export interface CannedResponse {
  id: string;
  lineAccountId: string | null;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

interface CannedResponseRow {
  id: string;
  line_account_id: string | null;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
}

function serialize(row: CannedResponseRow): CannedResponse {
  return {
    id: row.id,
    lineAccountId: row.line_account_id,
    title: row.title,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * List canned responses visible to an account: the account's own rows plus the
 * global (line_account_id IS NULL) rows, oldest first. ASC keeps the picker
 * order stable so the operator's hand learns positions (saved_searches uses
 * DESC, but here stability beats recency).
 */
export async function listCannedResponses(
  db: D1Database,
  lineAccountId: string | null,
): Promise<CannedResponse[]> {
  if (lineAccountId) {
    const result = await db
      .prepare(
        `SELECT * FROM canned_responses WHERE (line_account_id IS NULL OR line_account_id = ?) ORDER BY created_at ASC`,
      )
      .bind(lineAccountId)
      .all<CannedResponseRow>();
    return result.results.map(serialize);
  }
  const result = await db
    .prepare(`SELECT * FROM canned_responses WHERE line_account_id IS NULL ORDER BY created_at ASC`)
    .all<CannedResponseRow>();
  return result.results.map(serialize);
}

export async function getCannedResponseById(db: D1Database, id: string): Promise<CannedResponse | null> {
  const row = await db.prepare(`SELECT * FROM canned_responses WHERE id = ?`).bind(id).first<CannedResponseRow>();
  return row ? serialize(row) : null;
}

export interface CreateCannedResponseInput {
  lineAccountId: string | null;
  title: string;
  content: string;
}

export async function createCannedResponse(
  db: D1Database,
  input: CreateCannedResponseInput,
): Promise<CannedResponse> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO canned_responses (id, line_account_id, title, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.lineAccountId ?? null, input.title, input.content, now, now)
    .run();
  return (await getCannedResponseById(db, id))!;
}

export interface UpdateCannedResponseInput {
  title?: string;
  content?: string;
}

/**
 * Update only the columns actually provided. Column names are matched 1:1 with
 * the CREATE TABLE (batch2/3 SET-clause drift lesson). A no-op update (empty
 * input) leaves the row untouched. Returns null if the id does not exist.
 */
export async function updateCannedResponse(
  db: D1Database,
  id: string,
  input: UpdateCannedResponseInput,
): Promise<CannedResponse | null> {
  const existing = await getCannedResponseById(db, id);
  if (!existing) return null;

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (input.title !== undefined) {
    sets.push('title = ?');
    binds.push(input.title);
  }
  if (input.content !== undefined) {
    sets.push('content = ?');
    binds.push(input.content);
  }
  if (sets.length === 0) return existing;

  sets.push('updated_at = ?');
  binds.push(jstNow());
  binds.push(id);
  await db
    .prepare(`UPDATE canned_responses SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();
  return getCannedResponseById(db, id);
}

export async function deleteCannedResponse(db: D1Database, id: string): Promise<void> {
  await db.prepare(`DELETE FROM canned_responses WHERE id = ?`).bind(id).run();
}
