import { Hono, type Context } from 'hono';
import {
  createFormalooFolder,
  renameFormalooFolder,
  moveFormalooFolder,
  deleteFormalooFolder,
  listFormalooFolders,
  FolderError,
  type FormalooFolder,
} from '@line-crm/db';
import type { Env } from '../index.js';

// =============================================================================
// /api/formaloo-folders — ハーネス側フォルダ分類 (SoT) の CRUD (F6-3 / 本柱③)
// -----------------------------------------------------------------------------
// フォームを「フォルダ」で仕分ける管理 API。フォルダはハーネス側だけの整理軸 (SoT) であり、
// Formaloo 側フォルダとは **自動連動しない** (v3.0 API が form↔folder 紐づけを非露出 / N-19)。
//
// gating (§3.4): permission-map が forms_advanced feature で gate する。**ownerGate は付けない** —
//   フォルダ分類は staff も使う機能ゆえ、非 owner staff (forms_advanced 権限あり) でも作成/整理できる
//   (F6-1 formaloo-workspaces / F6-2 account-bindings の owner-only とは異なる)。forms_advanced を持たない
//   custom role は permission-middleware が 403 で締める (gate enforcement / Codex M#6)。
//
// cross-account / 循環 / 削除 cascade はすべて db 層 (formaloo-folders.ts) がアプリ層で検証する (M-5 / D1 FK off)。
// FolderError(status, message) を投げるので route は status を透過する。
// =============================================================================

export const formalooFolders = new Hono<Env>();

function serializeFolder(f: FormalooFolder) {
  return {
    id: f.id,
    lineAccountId: f.line_account_id,
    name: f.name,
    parentId: f.parent_id,
    position: f.position,
  };
}

/** FolderError は status を透過・それ以外は 500 (詳細を漏らさない)。 */
function fail(c: Context<Env>, err: unknown, label: string) {
  if (err instanceof FolderError) {
    return c.json({ success: false, error: err.message }, err.status as 400 | 404);
  }
  console.error(`${label} error`);
  return c.json({ success: false, error: 'Internal server error' }, 500);
}

// GET /api/formaloo-folders?lineAccountId= — 一覧 (account スコープ)
formalooFolders.get('/api/formaloo-folders', async (c) => {
  const lineAccountId = c.req.query('lineAccountId');
  if (!lineAccountId) return c.json({ success: false, error: 'lineAccountId が必要です' }, 400);
  try {
    const list = await listFormalooFolders(c.env.DB, lineAccountId);
    return c.json({ success: true, data: list.map(serializeFolder) });
  } catch (err) {
    return fail(c, err, 'GET /api/formaloo-folders');
  }
});

// POST /api/formaloo-folders — 作成 (lineAccountId 必須・実在 account のみ・parent 同一 account)
formalooFolders.post('/api/formaloo-folders', async (c) => {
  const body = await c.req
    .json<{ lineAccountId?: unknown; name?: unknown; parentId?: unknown }>()
    .catch(() => ({}) as Record<string, never>);
  try {
    const folder = await createFormalooFolder(c.env.DB, {
      lineAccountId: typeof body.lineAccountId === 'string' ? body.lineAccountId : '',
      name: typeof body.name === 'string' ? body.name : '',
      parentId: typeof body.parentId === 'string' ? body.parentId : null,
    });
    return c.json({ success: true, data: serializeFolder(folder) }, 201);
  } catch (err) {
    return fail(c, err, 'POST /api/formaloo-folders');
  }
});

// PATCH /api/formaloo-folders/:folderId — リネーム (+親付け替え)
formalooFolders.patch('/api/formaloo-folders/:folderId', async (c) => {
  const id = c.req.param('folderId')!;
  const body = await c.req
    .json<{ name?: unknown; parentId?: unknown }>()
    .catch(() => ({}) as Record<string, never>);
  try {
    if (typeof body.name === 'string') {
      await renameFormalooFolder(c.env.DB, id, body.name);
    }
    // parentId は body に含まれる時だけ付け替え (null=トップレベル化 / string=指定親)。
    if ('parentId' in body) {
      const newParentId = typeof body.parentId === 'string' ? body.parentId : null;
      await moveFormalooFolder(c.env.DB, id, newParentId);
    }
    return c.json({ success: true, data: null });
  } catch (err) {
    return fail(c, err, 'PATCH /api/formaloo-folders/:folderId');
  }
});

// DELETE /api/formaloo-folders/:folderId — 削除 (所属 form を未分類へ + 子を再接続 / form は消さない)
formalooFolders.delete('/api/formaloo-folders/:folderId', async (c) => {
  const id = c.req.param('folderId')!;
  try {
    await deleteFormalooFolder(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    return fail(c, err, 'DELETE /api/formaloo-folders/:folderId');
  }
});
