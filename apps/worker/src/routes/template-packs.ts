import { Hono } from 'hono';
import {
  listTemplatePacks,
  createTemplatePack,
  getTemplatePackById,
  getTemplatePackWithItems,
  updateTemplatePack,
  deleteTemplatePack,
  type TemplatePack,
  type PackItemInput,
} from '@line-crm/db';
import type { Env } from '../index.js';
import { buildOutboundMessage, OUTBOUND_MESSAGE_TYPES } from '../services/outbound-message.js';

const templatePacks = new Hono<Env>();

/**
 * template_packs は account-scoped (account_id NOT NULL)。所有 account と request の accountId が
 * 一致しなければ拒否 (別 account のパック文面を list/選択に出さない = 文面漏洩+誤挿入の防止)。
 * accountId 欠落も拒否 (fail-closed)。
 */
function accountScopeReject(existing: TemplatePack, accountId: string | null): Response | null {
  if (existing.account_id !== accountId) {
    return Response.json({ success: false, error: 'template pack account mismatch' }, { status: 403 });
  }
  return null;
}

/**
 * items 配列を検証して PackItemInput[] に正規化する。送信 engine が扱える全 type を共通
 * outbound renderer で検証し、不正 content や未知 type は保存前に fail-closed にする。
 */
function validateItems(raw: unknown): PackItemInput[] {
  if (!Array.isArray(raw)) throw new Error('items must be an array');
  const allowedTypes = new Set<string>(OUTBOUND_MESSAGE_TYPES);
  const items: PackItemInput[] = [];
  for (const it of raw) {
    if (!it || typeof it !== 'object') throw new Error('each item must be an object');
    const r = it as Record<string, unknown>;
    const type = r.messageType;
    const content = r.messageContent;
    if (typeof type !== 'string' || !allowedTypes.has(type)) throw new Error('messageType is not supported');
    if (typeof content !== 'string' || content.length === 0) throw new Error('messageContent is required');
    try {
      buildOutboundMessage(type, content);
    } catch {
      throw new Error(`messageContent is invalid for ${type} type`);
    }
    items.push({ messageType: type, messageContent: content } as PackItemInput);
  }
  return items;
}

// GET /api/template-packs?accountId= — 自 account のパック一覧 (itemCount 付き)。
templatePacks.get('/api/template-packs', async (c) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  const items = await listTemplatePacks(c.env.DB, accountId);
  return c.json({ success: true, data: items });
});

// POST /api/template-packs?accountId= — { name, items[] }
templatePacks.post('/api/template-packs', async (c) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  const body = await c.req.json<{ name?: string; items?: unknown }>();
  const name = (body.name ?? '').trim();
  if (!name) return c.json({ success: false, error: 'name is required' }, 400);
  let items: PackItemInput[];
  try {
    items = validateItems(body.items ?? []);
  } catch (err) {
    return c.json({ success: false, error: err instanceof Error ? err.message : 'invalid items' }, 400);
  }
  const created = await createTemplatePack(c.env.DB, { accountId, name, items });
  return c.json({ success: true, data: created }, 201);
});

// GET /api/template-packs/:id?accountId= — パック + 順序付き items。
templatePacks.get('/api/template-packs/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await getTemplatePackById(c.env.DB, id);
  if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
  const rejected = accountScopeReject(existing, c.req.query('accountId') ?? null);
  if (rejected) return rejected;
  const withItems = await getTemplatePackWithItems(c.env.DB, id);
  return c.json({ success: true, data: withItems });
});

// PATCH /api/template-packs/:id?accountId= — { name?, items? }
templatePacks.patch('/api/template-packs/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await getTemplatePackById(c.env.DB, id);
  if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
  const rejected = accountScopeReject(existing, c.req.query('accountId') ?? null);
  if (rejected) return rejected;

  const body = await c.req.json<{ name?: string; items?: unknown }>();
  const patch: { name?: string; items?: PackItemInput[] } = {};
  if (body.name !== undefined) {
    const name = body.name.trim();
    if (!name) return c.json({ success: false, error: 'name is required' }, 400);
    patch.name = name;
  }
  if (body.items !== undefined) {
    try {
      patch.items = validateItems(body.items);
    } catch (err) {
      return c.json({ success: false, error: err instanceof Error ? err.message : 'invalid items' }, 400);
    }
  }
  const updated = await updateTemplatePack(c.env.DB, id, patch);
  return c.json({ success: true, data: updated });
});

// DELETE /api/template-packs/:id?accountId= — pack 削除 (items は CASCADE)。
templatePacks.delete('/api/template-packs/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await getTemplatePackById(c.env.DB, id);
  if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
  const rejected = accountScopeReject(existing, c.req.query('accountId') ?? null);
  if (rejected) return rejected;
  await deleteTemplatePack(c.env.DB, id);
  return c.json({ success: true, data: null });
});

export { templatePacks };
