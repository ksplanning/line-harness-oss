import { Hono } from 'hono';
import {
  listCampaigns,
  createCampaign,
  getCampaignById,
  renameCampaign,
  deleteCampaign,
  linkBroadcastToCampaign,
  getCampaignAggregate,
  type Campaign,
} from '@line-crm/db';
import type { Env } from '../index.js';

const campaigns = new Hono<Env>();

/**
 * campaigns は account-scoped (account_id NOT NULL)。所有 account と request の accountId が
 * 厳密一致でなければ拒否する (別 account の campaign / 集計成果を見せない = cross-account 漏洩ゼロ)。
 * accountId 欠落も拒否 (fail-closed)。一致すれば null。
 */
function accountScopeReject(existing: Campaign, accountId: string | null): Response | null {
  if (existing.account_id !== accountId) {
    return Response.json({ success: false, error: 'campaign account mismatch' }, { status: 403 });
  }
  return null;
}

function serialize(c: Campaign) {
  return { id: c.id, accountId: c.account_id, name: c.name, createdAt: c.created_at, updatedAt: c.updated_at };
}

// GET /api/campaigns?accountId= — 自 account のキャンペーン一覧。
campaigns.get('/api/campaigns', async (c) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  const items = await listCampaigns(c.env.DB, accountId);
  return c.json({ success: true, data: items.map(serialize) });
});

// POST /api/campaigns?accountId= — { name }
campaigns.post('/api/campaigns', async (c) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId query param required' }, 400);
  const body = await c.req.json<{ name?: string }>();
  const name = (body.name ?? '').trim();
  if (!name) return c.json({ success: false, error: 'name is required' }, 400);
  const created = await createCampaign(c.env.DB, { accountId, name });
  return c.json({ success: true, data: serialize(created) }, 201);
});

// GET /api/campaigns/:id?accountId= — 詳細 + 紐付き配信のまとめ集計。
campaigns.get('/api/campaigns/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await getCampaignById(c.env.DB, id);
  if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
  const rejected = accountScopeReject(existing, c.req.query('accountId') ?? null);
  if (rejected) return rejected;
  const aggregate = await getCampaignAggregate(c.env.DB, id);
  return c.json({ success: true, data: { ...serialize(existing), aggregate } });
});

// PATCH /api/campaigns/:id?accountId= — { name }
campaigns.patch('/api/campaigns/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await getCampaignById(c.env.DB, id);
  if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
  const rejected = accountScopeReject(existing, c.req.query('accountId') ?? null);
  if (rejected) return rejected;
  const body = await c.req.json<{ name?: string }>();
  const name = (body.name ?? '').trim();
  if (!name) return c.json({ success: false, error: 'name is required' }, 400);
  const updated = await renameCampaign(c.env.DB, id, name);
  return c.json({ success: true, data: updated ? serialize(updated) : null });
});

// DELETE /api/campaigns/:id?accountId=
campaigns.delete('/api/campaigns/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await getCampaignById(c.env.DB, id);
  if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
  const rejected = accountScopeReject(existing, c.req.query('accountId') ?? null);
  if (rejected) return rejected;
  await deleteCampaign(c.env.DB, id);
  return c.json({ success: true, data: null });
});

// POST /api/campaigns/:id/broadcasts?accountId= — { broadcastId, linked }
// 配信をキャンペーンに紐付け/解除する (集計のグルーピング)。送信はしない。
// linked=false で解除。同 account の campaign かつ同 account の配信のみ更新する。
campaigns.post('/api/campaigns/:id/broadcasts', async (c) => {
  const id = c.req.param('id');
  const accountId = c.req.query('accountId') ?? null;
  const existing = await getCampaignById(c.env.DB, id);
  if (!existing) return c.json({ success: false, error: 'Not found' }, 404);
  const rejected = accountScopeReject(existing, accountId);
  if (rejected) return rejected;

  const body = await c.req.json<{ broadcastId?: string; linked?: boolean }>();
  if (!body.broadcastId) return c.json({ success: false, error: 'broadcastId is required' }, 400);
  const linked = body.linked !== false; // 既定 true = 紐付け
  const ok = await linkBroadcastToCampaign(
    c.env.DB,
    body.broadcastId,
    linked ? id : null,
    accountId!,
  );
  if (!ok) {
    // 更新 0 件 = 存在しない or 別 account の配信 (同 account の配信のみ紐付け可)。
    return c.json({ success: false, error: 'broadcast not found for this account' }, 404);
  }
  return c.json({ success: true, data: null });
});

export { campaigns };
