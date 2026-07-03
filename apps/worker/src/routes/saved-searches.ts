import { Hono } from 'hono';
import {
  listSavedSearches,
  createSavedSearch,
  getSavedSearchById,
  renameSavedSearch,
  updateSavedSearchConditions,
  deleteSavedSearch,
} from '@line-crm/db';
import { buildSegmentWhere } from '../services/segment-query.js';
import type { SegmentCondition } from '../services/segment-query.js';
import type { Env } from '../index.js';

const savedSearches = new Hono<Env>();

/**
 * server 側の conditions 検証 (client と二重)。operator は AND|OR 限定、rules は配列、
 * 各 rule は buildSegmentWhere が受理する形 (不正 rule type は throw)。正常なら
 * 正規化済 JSON 文字列を返す。
 */
function validateConditions(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) throw new Error('conditions must be an object');
  const cond = raw as SegmentCondition;
  if (cond.operator !== 'AND' && cond.operator !== 'OR') throw new Error('operator must be AND or OR');
  if (!Array.isArray(cond.rules)) throw new Error('rules must be an array');
  // buildSegmentWhere は未知 rule type / 型不整合で throw する = 実効的な validator。
  buildSegmentWhere(cond);
  return JSON.stringify({ operator: cond.operator, rules: cond.rules });
}

// GET /api/saved-searches?accountId=
savedSearches.get('/api/saved-searches', async (c) => {
  const accountId = c.req.query('accountId') ?? null;
  const items = await listSavedSearches(c.env.DB, accountId);
  return c.json({ success: true, data: items });
});

// POST /api/saved-searches — { name, conditions, accountId }
savedSearches.post('/api/saved-searches', async (c) => {
  const body = await c.req.json<{ name?: string; conditions?: unknown; accountId?: string | null }>();
  const name = (body.name ?? '').trim();
  if (!name) return c.json({ success: false, error: 'name is required' }, 400);

  let conditionsJson: string;
  try {
    conditionsJson = validateConditions(body.conditions);
  } catch (err) {
    return c.json({ success: false, error: err instanceof Error ? err.message : 'invalid conditions' }, 400);
  }

  const created = await createSavedSearch(c.env.DB, {
    lineAccountId: body.accountId ?? null,
    name,
    conditions: conditionsJson,
  });
  return c.json({ success: true, data: created }, 201);
});

/**
 * account-scoped (lineAccountId 非 null) の行は request の accountId と厳密一致でなければ
 * 拒否する (reviewer R1 MED: GET /api/friends の guard と整合)。global(null) は常に許可。
 * 一致しなければ 403 を返し、一致すれば null を返す。
 */
function accountScopeReject(
  existing: { lineAccountId: string | null },
  accountId: string | null,
): Response | null {
  if (existing.lineAccountId !== null && existing.lineAccountId !== accountId) {
    return Response.json({ success: false, error: 'saved search account mismatch' }, { status: 403 });
  }
  return null;
}

// PATCH /api/saved-searches/:id — rename and/or update conditions
savedSearches.patch('/api/saved-searches/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await getSavedSearchById(c.env.DB, id);
  if (!existing) return c.json({ success: false, error: 'Not found' }, 404);

  const rejected = accountScopeReject(existing, c.req.query('accountId') ?? null);
  if (rejected) return rejected;

  const body = await c.req.json<{ name?: string; conditions?: unknown }>();

  let updated = existing;
  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name) return c.json({ success: false, error: 'name is required' }, 400);
    updated = (await renameSavedSearch(c.env.DB, id, name))!;
  }
  if (body.conditions !== undefined) {
    let conditionsJson: string;
    try {
      conditionsJson = validateConditions(body.conditions);
    } catch (err) {
      return c.json({ success: false, error: err instanceof Error ? err.message : 'invalid conditions' }, 400);
    }
    updated = (await updateSavedSearchConditions(c.env.DB, id, conditionsJson))!;
  }
  return c.json({ success: true, data: updated });
});

// DELETE /api/saved-searches/:id
savedSearches.delete('/api/saved-searches/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await getSavedSearchById(c.env.DB, id);
  if (existing) {
    const rejected = accountScopeReject(existing, c.req.query('accountId') ?? null);
    if (rejected) return rejected;
  }
  await deleteSavedSearch(c.env.DB, id);
  return c.json({ success: true, data: null });
});

export { savedSearches };
