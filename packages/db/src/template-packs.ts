import { jstNow } from './utils.js';

/**
 * F2 G16 テンプレパック — 対応メッセージの順序付きセット。account-scoped。
 * 挿入 UI は broadcast-form の state に載せるだけで送信経路には触れない (挿入と送信の分離)。
 */

export interface TemplatePack {
  id: string;
  account_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

export type TemplatePackMessageType =
  | 'text'
  | 'flex'
  | 'image'
  | 'video'
  | 'audio'
  | 'sticker'
  | 'imagemap'
  | 'richvideo';

export interface TemplatePackItem {
  id: string;
  pack_id: string;
  order_index: number;
  message_type: TemplatePackMessageType;
  message_content: string;
  created_at: string;
  updated_at: string;
}

export interface TemplatePackWithItems extends TemplatePack {
  items: TemplatePackItem[];
}

export interface TemplatePackListEntry extends TemplatePack {
  itemCount: number;
}

export async function listTemplatePacks(
  db: D1Database,
  accountId: string,
): Promise<TemplatePackListEntry[]> {
  const result = await db
    .prepare(
      `SELECT p.*, (SELECT COUNT(*) FROM template_pack_items WHERE pack_id = p.id) AS item_count
         FROM template_packs p
        WHERE p.account_id = ?
        ORDER BY p.updated_at DESC`,
    )
    .bind(accountId)
    .all<TemplatePack & { item_count: number }>();
  return result.results.map((r) => ({
    id: r.id,
    account_id: r.account_id,
    name: r.name,
    created_at: r.created_at,
    updated_at: r.updated_at,
    itemCount: r.item_count,
  }));
}

export async function getTemplatePackById(
  db: D1Database,
  id: string,
): Promise<TemplatePack | null> {
  return db.prepare('SELECT * FROM template_packs WHERE id = ?').bind(id).first<TemplatePack>();
}

export async function getTemplatePackWithItems(
  db: D1Database,
  id: string,
): Promise<TemplatePackWithItems | null> {
  const pack = await getTemplatePackById(db, id);
  if (!pack) return null;
  const items = await db
    .prepare('SELECT * FROM template_pack_items WHERE pack_id = ? ORDER BY order_index ASC')
    .bind(id)
    .all<TemplatePackItem>();
  return { ...pack, items: items.results };
}

export interface PackItemInput {
  messageType: TemplatePackMessageType;
  messageContent: string;
}

export async function createTemplatePack(
  db: D1Database,
  input: { accountId: string; name: string; items: PackItemInput[] },
): Promise<TemplatePackWithItems> {
  const id = crypto.randomUUID();
  const now = jstNow();
  await db
    .prepare(
      'INSERT INTO template_packs (id, account_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(id, input.accountId, input.name, now, now)
    .run();
  await replacePackItems(db, id, input.items);
  return (await getTemplatePackWithItems(db, id))!;
}

/**
 * pack の name / items を丸ごと更新する。items は 0-origin の連番で振り直して保存
 * (並び替え/追加/削除を UI が渡した配列順で反映)。account guard は route 側。
 */
export async function updateTemplatePack(
  db: D1Database,
  id: string,
  input: { name?: string; items?: PackItemInput[] },
): Promise<TemplatePackWithItems | null> {
  const existing = await getTemplatePackById(db, id);
  if (!existing) return null;
  const now = jstNow();
  if (input.name !== undefined) {
    await db
      .prepare('UPDATE template_packs SET name = ?, updated_at = ? WHERE id = ?')
      .bind(input.name, now, id)
      .run();
  }
  if (input.items !== undefined) {
    await replacePackItems(db, id, input.items);
    await db.prepare('UPDATE template_packs SET updated_at = ? WHERE id = ?').bind(now, id).run();
  }
  return getTemplatePackWithItems(db, id);
}

async function replacePackItems(
  db: D1Database,
  packId: string,
  items: PackItemInput[],
): Promise<void> {
  await db.prepare('DELETE FROM template_pack_items WHERE pack_id = ?').bind(packId).run();
  const now = jstNow();
  for (let i = 0; i < items.length; i++) {
    await db
      .prepare(
        `INSERT INTO template_pack_items (id, pack_id, order_index, message_type, message_content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), packId, i, items[i].messageType, items[i].messageContent, now, now)
      .run();
  }
}

export async function deleteTemplatePack(db: D1Database, id: string): Promise<boolean> {
  // template_pack_items は FK ON DELETE CASCADE で自動削除される。
  const result = await db.prepare('DELETE FROM template_packs WHERE id = ?').bind(id).run();
  return result.meta.changes > 0;
}
