import { Hono } from 'hono';
import type { Env } from '../index.js';
import {
  approveAiFaqDraft,
  discardAiFaqDraft,
  editAiFaqDraft,
  FaqDraftReviewError,
  listPendingAiFaqDraftReviews,
  resolveAiFaqDraftReviewFriend,
} from '../services/faq-draft-review.js';

const faqDraftReviews = new Hono<Env>();

function failure(error: unknown): {
  message: string;
  status: 400 | 403 | 404 | 409 | 500 | 502;
} {
  if (error instanceof FaqDraftReviewError) {
    return { message: error.message, status: error.status };
  }
  console.error('FAQ draft inbox review error:', error instanceof Error ? error.name : 'unknown');
  return { message: 'Internal server error', status: 500 };
}

function accountIdFromBody(body: { accountId?: unknown }): string | null {
  return typeof body.accountId === 'string' && body.accountId.trim()
    ? body.accountId.trim()
    : null;
}

faqDraftReviews.get('/api/faq-draft-reviews', async (c) => {
  const accountId = c.req.query('accountId')?.trim();
  if (!accountId) {
    return c.json({ success: false, error: 'accountId is required' }, 400);
  }
  try {
    const data = await listPendingAiFaqDraftReviews(c.env.DB, accountId);
    return c.json({ success: true, data });
  } catch (error) {
    const result = failure(error);
    return c.json({ success: false, error: result.message }, result.status);
  }
});

faqDraftReviews.patch('/api/faq-draft-reviews/:draftId', async (c) => {
  const actor = c.get('staff');
  if (!actor) return c.json({ success: false, error: 'Authentication required' }, 401);
  let body: { accountId?: unknown; draftAnswer?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'JSON body required' }, 400);
  }
  const accountId = accountIdFromBody(body);
  if (!accountId || typeof body.draftAnswer !== 'string') {
    return c.json({ success: false, error: 'accountId and draftAnswer are required' }, 400);
  }
  try {
    const draftId = c.req.param('draftId');
    const friendId = await resolveAiFaqDraftReviewFriend(c.env.DB, draftId, accountId);
    const data = await editAiFaqDraft({
      db: c.env.DB,
      draftId,
      friendId,
      actorStaffId: actor.id,
      draftAnswer: body.draftAnswer,
      expectedLineAccountId: accountId,
    });
    return c.json({ success: true, data });
  } catch (error) {
    const result = failure(error);
    return c.json({ success: false, error: result.message }, result.status);
  }
});

faqDraftReviews.delete('/api/faq-draft-reviews/:draftId', async (c) => {
  const actor = c.get('staff');
  if (!actor) return c.json({ success: false, error: 'Authentication required' }, 401);
  let body: { accountId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'JSON body required' }, 400);
  }
  const accountId = accountIdFromBody(body);
  if (!accountId) return c.json({ success: false, error: 'accountId is required' }, 400);
  try {
    const draftId = c.req.param('draftId');
    const friendId = await resolveAiFaqDraftReviewFriend(c.env.DB, draftId, accountId);
    const data = await discardAiFaqDraft({
      db: c.env.DB,
      draftId,
      friendId,
      actorStaffId: actor.id,
      expectedLineAccountId: accountId,
    });
    return c.json({ success: true, data });
  } catch (error) {
    const result = failure(error);
    return c.json({ success: false, error: result.message }, result.status);
  }
});

faqDraftReviews.post('/api/faq-draft-reviews/:draftId/approve', async (c) => {
  const actor = c.get('staff');
  if (!actor) return c.json({ success: false, error: 'Authentication required' }, 401);
  let body: { accountId?: unknown; addToFaq?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, error: 'JSON body required' }, 400);
  }
  const accountId = accountIdFromBody(body);
  if (!accountId) return c.json({ success: false, error: 'accountId is required' }, 400);
  if (body.addToFaq !== undefined && typeof body.addToFaq !== 'boolean') {
    return c.json({ success: false, error: 'addToFaq must be a boolean' }, 400);
  }
  try {
    const draftId = c.req.param('draftId');
    const friendId = await resolveAiFaqDraftReviewFriend(c.env.DB, draftId, accountId);
    const result = await approveAiFaqDraft({
      db: c.env.DB,
      draftId,
      friendId,
      actorStaffId: actor.id,
      expectedLineAccountId: accountId,
      addToFaq: body.addToFaq === true,
    });
    return c.json({
      success: true,
      data: {
        draft: result.draft,
        message: {
          direction: result.message.direction,
          messageType: result.message.messageType,
          content: result.message.content,
          createdAt: result.message.createdAt,
        },
      },
    });
  } catch (error) {
    const result = failure(error);
    return c.json({ success: false, error: result.message }, result.status);
  }
});

export { faqDraftReviews };
