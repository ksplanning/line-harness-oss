import { Hono } from 'hono';
import {
  listCannedResponses,
  createCannedResponse,
  getCannedResponseById,
  updateCannedResponse,
  deleteCannedResponse,
} from '@line-crm/db';
import type { Env } from '../index.js';

const cannedResponses = new Hono<Env>();

/**
 * account-scoped (lineAccountId 非 null) の行は request の accountId と厳密一致でなければ
 * 拒否する (saved-searches の accountScopeReject と 1:1 / batch4 R1 教訓)。global(null) は
 * 常に許可。一致しなければ 403 を返し、一致すれば null を返す。
 */
function accountScopeReject(
  existing: { lineAccountId: string | null },
  accountId: string | null,
): Response | null {
  if (existing.lineAccountId !== null && existing.lineAccountId !== accountId) {
    return Response.json({ success: false, error: 'canned response account mismatch' }, { status: 403 });
  }
  return null;
}

// GET /api/canned-responses?accountId= — account + global を返す
cannedResponses.get('/api/canned-responses', async (c) => {
  const accountId = c.req.query('accountId') ?? null;
  const items = await listCannedResponses(c.env.DB, accountId);
  return c.json({ success: true, data: items });
});

// POST /api/canned-responses — { title, content, accountId }
cannedResponses.post('/api/canned-responses', async (c) => {
  const body = await c.req.json<{ title?: string; content?: string; accountId?: string | null }>();
  const title = (body.title ?? '').trim();
  if (!title) return c.json({ success: false, error: 'title is required' }, 400);
  const content = (body.content ?? '').trim();
  if (!content) return c.json({ success: false, error: 'content is required' }, 400);

  const created = await createCannedResponse(c.env.DB, {
    lineAccountId: body.accountId ?? null,
    title,
    content,
  });
  return c.json({ success: true, data: created }, 201);
});

// PATCH /api/canned-responses/:id — update title and/or content
cannedResponses.patch('/api/canned-responses/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await getCannedResponseById(c.env.DB, id);
  if (!existing) return c.json({ success: false, error: 'Not found' }, 404);

  const rejected = accountScopeReject(existing, c.req.query('accountId') ?? null);
  if (rejected) return rejected;

  const body = await c.req.json<{ title?: string; content?: string }>();
  const patch: { title?: string; content?: string } = {};
  if (typeof body.title === 'string') {
    const title = body.title.trim();
    if (!title) return c.json({ success: false, error: 'title is required' }, 400);
    patch.title = title;
  }
  if (typeof body.content === 'string') {
    const content = body.content.trim();
    if (!content) return c.json({ success: false, error: 'content is required' }, 400);
    patch.content = content;
  }

  const updated = (await updateCannedResponse(c.env.DB, id, patch))!;
  return c.json({ success: true, data: updated });
});

// DELETE /api/canned-responses/:id
cannedResponses.delete('/api/canned-responses/:id', async (c) => {
  const id = c.req.param('id');
  const existing = await getCannedResponseById(c.env.DB, id);
  if (existing) {
    const rejected = accountScopeReject(existing, c.req.query('accountId') ?? null);
    if (rejected) return rejected;
  }
  await deleteCannedResponse(c.env.DB, id);
  return c.json({ success: true, data: null });
});

export { cannedResponses };
