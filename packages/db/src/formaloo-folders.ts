import { jstNow } from './utils.js';

// =============================================================================
// ハーネス側フォルダ分類 (SoT) の D1 CRUD helper (F6-3 / migration 096 / 本柱③)。
// -----------------------------------------------------------------------------
// フォルダはハーネス側だけの整理軸 (SoT)。Formaloo 側フォルダとは自動連動しない (v3.0 API が form↔folder
// 紐づけを read/write とも非露出 / N-19)。フォルダは必ず account に属す (line_account_id NOT NULL) ため、
// F6-2 の line_account_id 表示スコープと直交に効く (account スコープ内での分類)。
// D1 は FK off (M-5) ゆえ cross-account・循環・削除 cascade をアプリ層で原子的に解決する。
// =============================================================================

/** フォルダ操作の入力エラー (HTTP status を保持し route が echo する)。 */
export class FolderError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'FolderError';
  }
}

export interface FormalooFolder {
  id: string;
  line_account_id: string;
  name: string;
  parent_id: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface CreateFolderInput {
  lineAccountId: string;
  name: string;
  parentId?: string | null;
}

const MAX_FOLDER_NAME = 100;

/** name を whitelist 検証 (trim 後の空 / 過長を弾く / M-21)。返り値は trim 済み。 */
function validateName(name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) throw new FolderError(400, 'フォルダ名を入力してください');
  if (n.length > MAX_FOLDER_NAME) throw new FolderError(400, 'フォルダ名が長すぎます');
  return n;
}

/** account が line_accounts に実在するか (架空 account フォルダ禁止 / Codex M#3)。 */
async function accountExists(db: D1Database, lineAccountId: string): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS ok FROM line_accounts WHERE id = ?').bind(lineAccountId).first<{ ok: number }>();
  return row != null;
}

export async function getFormalooFolder(db: D1Database, id: string): Promise<FormalooFolder | null> {
  return db.prepare('SELECT * FROM formaloo_folders WHERE id = ?').bind(id).first<FormalooFolder>();
}

/** account スコープのフォルダ一覧 (別 account のフォルダは返さない)。 */
export async function listFormalooFolders(db: D1Database, lineAccountId: string): Promise<FormalooFolder[]> {
  const r = await db
    .prepare('SELECT * FROM formaloo_folders WHERE line_account_id = ? ORDER BY position ASC, created_at ASC')
    .bind(lineAccountId)
    .all<FormalooFolder>();
  return r.results;
}

/**
 * フォルダ作成。lineAccountId 必須・実在 account のみ (架空 account 400 / Codex M#3)。
 * parentId 指定時は「実在 かつ 同一 account」のフォルダのみ許可 (別 account 親 400 / cross-account 防止)。
 */
export async function createFormalooFolder(db: D1Database, input: CreateFolderInput): Promise<FormalooFolder> {
  const lineAccountId = typeof input?.lineAccountId === 'string' ? input.lineAccountId.trim() : '';
  if (!lineAccountId) throw new FolderError(400, 'アカウントを指定してください');
  const name = validateName(input?.name);
  if (!(await accountExists(db, lineAccountId))) {
    throw new FolderError(400, 'アカウントが見つかりません');
  }
  const parentId = typeof input.parentId === 'string' && input.parentId.trim() ? input.parentId.trim() : null;
  if (parentId) {
    const parent = await getFormalooFolder(db, parentId);
    // 実在 かつ 同一 account の親のみ (別 account の folder を親にできない = cross-account 親禁止)。
    if (!parent || parent.line_account_id !== lineAccountId) {
      throw new FolderError(400, '指定した親フォルダが見つからないか、別アカウントのフォルダです');
    }
  }
  const id = `ff_${crypto.randomUUID()}`;
  const now = jstNow();
  await db
    .prepare(
      `INSERT INTO formaloo_folders (id, line_account_id, name, parent_id, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    )
    .bind(id, lineAccountId, name, parentId, now, now)
    .run();
  return (await getFormalooFolder(db, id))!;
}

/** リネーム (name のみ)。不明 id は 404・空/過長 name は 400。 */
export async function renameFormalooFolder(db: D1Database, id: string, name: string): Promise<void> {
  const folder = await getFormalooFolder(db, id);
  if (!folder) throw new FolderError(404, 'フォルダが見つかりません');
  const clean = validateName(name);
  await db
    .prepare(`UPDATE formaloo_folders SET name = ?, updated_at = ? WHERE id = ?`)
    .bind(clean, jstNow(), id)
    .run();
}

/**
 * 親フォルダの付け替え。newParentId=null でトップレベル化。
 * 拒否 (400): 自己親 (id===newParentId) / 別 account 親 / 循環 (newParentId の祖先チェーンに id が現れる)。
 * 不明 id は 404。
 */
export async function moveFormalooFolder(db: D1Database, id: string, newParentId: string | null): Promise<void> {
  const folder = await getFormalooFolder(db, id);
  if (!folder) throw new FolderError(404, 'フォルダが見つかりません');
  const parentId = typeof newParentId === 'string' && newParentId.trim() ? newParentId.trim() : null;

  if (parentId) {
    if (parentId === id) throw new FolderError(400, 'フォルダを自分自身の中には入れられません');
    const parent = await getFormalooFolder(db, parentId);
    if (!parent || parent.line_account_id !== folder.line_account_id) {
      throw new FolderError(400, '指定した親フォルダが見つからないか、別アカウントのフォルダです');
    }
    // 循環検出: newParent の祖先チェーンを辿り id が現れたら循環 (A→B→A)。
    let cursor: string | null = parent.parent_id;
    const seen = new Set<string>([parentId]);
    while (cursor) {
      if (cursor === id) throw new FolderError(400, 'フォルダの入れ子が循環します');
      if (seen.has(cursor)) break; // 既存データの循環に備えた安全弁 (無限ループ回避)
      seen.add(cursor);
      const up: FormalooFolder | null = await getFormalooFolder(db, cursor);
      cursor = up?.parent_id ?? null;
    }
  }

  await db
    .prepare(`UPDATE formaloo_folders SET parent_id = ?, updated_at = ? WHERE id = ?`)
    .bind(parentId, jstNow(), id)
    .run();
}

/**
 * フォルダ削除。所属 form を消さず未分類へ + 子フォルダを親フォルダへ再接続 + folder 本体削除 を
 * D1 batch で **原子的に** (孤児/循環なし・form は消えない / 途中失敗は all-or-nothing rollback / Codex M#7)。
 * 不明 id は 404。
 */
export async function deleteFormalooFolder(db: D1Database, id: string): Promise<void> {
  const folder = await getFormalooFolder(db, id);
  if (!folder) throw new FolderError(404, 'フォルダが見つかりません');
  const now = jstNow();
  await db.batch([
    // 所属 form → 未分類 (folder_id=NULL)。form は消さない。
    db.prepare(`UPDATE formaloo_forms SET folder_id = NULL, updated_at = ? WHERE folder_id = ?`).bind(now, id),
    // 子フォルダ → 削除対象の親へ再接続 (削除対象がトップレベルなら NULL = トップレベル化)。
    db.prepare(`UPDATE formaloo_folders SET parent_id = ?, updated_at = ? WHERE parent_id = ?`).bind(folder.parent_id, now, id),
    // folder 本体を削除。
    db.prepare(`DELETE FROM formaloo_folders WHERE id = ?`).bind(id),
  ]);
}

/**
 * フォーム→フォルダの割当/解除 (Formaloo push を伴わないローカル分類)。
 * folderId 非 null 時は folder.line_account_id === form.line_account_id を検証 (cross-account 混入防止 / spec §3.3)。
 * 不明 form は 404 / 不明 folder は 400 / cross-account は 400。
 */
export async function setFormalooFormFolder(db: D1Database, formId: string, folderId: string | null): Promise<void> {
  const form = await db
    .prepare('SELECT id, line_account_id FROM formaloo_forms WHERE id = ?')
    .bind(formId)
    .first<{ id: string; line_account_id: string | null }>();
  if (!form) throw new FolderError(404, 'フォームが見つかりません');

  const fid = typeof folderId === 'string' && folderId.trim() ? folderId.trim() : null;
  if (fid) {
    const folder = await getFormalooFolder(db, fid);
    if (!folder) throw new FolderError(400, 'フォルダが見つかりません');
    // folder は NOT NULL account。form.line_account_id が NULL(共通) の場合も不一致 = 400 (共通フォームは未分類のまま)。
    if (folder.line_account_id !== form.line_account_id) {
      throw new FolderError(400, 'フォームとフォルダのアカウントが一致しません');
    }
  }
  await db
    .prepare(`UPDATE formaloo_forms SET folder_id = ?, updated_at = ? WHERE id = ?`)
    .bind(fid, jstNow(), formId)
    .run();
}
