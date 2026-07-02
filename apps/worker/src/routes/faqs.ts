import { Hono } from 'hono';
import {
  createFaq,
  deleteFaq,
  getFaqById,
  getFaqs,
  getUnmatchedById,
  getUnmatchedQuestions,
  markUnmatchedResolved,
  updateFaq,
} from '@line-crm/db';
import type { Faq as DbFaq, UnmatchedQuestion as DbUnmatchedQuestion } from '@line-crm/db';
import type { Env } from '../index.js';

const faqs = new Hono<Env>();

const DEFAULT_FAQ_BOT_SETTINGS = {
  enabled: false,
  threshold: 0.6,
  handoffMessage: '',
  autoReplyNotice: '',
  maxRepliesPerDay: 5,
};

function parseVariants(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function serializeFaq(row: DbFaq) {
  return {
    id: row.id,
    lineAccountId: row.line_account_id,
    question: row.question,
    variants: parseVariants(row.variants),
    answer: row.answer,
    isActive: Boolean(row.is_active),
    hitCount: row.hit_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeUnmatched(row: DbUnmatchedQuestion) {
  return {
    id: row.id,
    lineAccountId: row.line_account_id,
    friendId: row.friend_id,
    question: row.question,
    topScore: row.top_score,
    resolvedFaqId: row.resolved_faq_id,
    createdAt: row.created_at,
  };
}

function normalizeSettings(input: Partial<typeof DEFAULT_FAQ_BOT_SETTINGS>) {
  return {
    enabled: input.enabled === true,
    threshold: typeof input.threshold === 'number' ? input.threshold : DEFAULT_FAQ_BOT_SETTINGS.threshold,
    handoffMessage: typeof input.handoffMessage === 'string' ? input.handoffMessage : DEFAULT_FAQ_BOT_SETTINGS.handoffMessage,
    autoReplyNotice: typeof input.autoReplyNotice === 'string' ? input.autoReplyNotice : DEFAULT_FAQ_BOT_SETTINGS.autoReplyNotice,
    maxRepliesPerDay: typeof input.maxRepliesPerDay === 'number' ? input.maxRepliesPerDay : DEFAULT_FAQ_BOT_SETTINGS.maxRepliesPerDay,
  };
}

function nowJst(): string {
  return new Date(Date.now() + 9 * 60 * 60_000).toISOString().replace('Z', '+09:00');
}

faqs.get('/api/faqs', async (c) => {
  try {
    const accountId = c.req.query('accountId');
    const rows = await getFaqs(c.env.DB, accountId || undefined);
    return c.json({ success: true, data: rows.map(serializeFaq) });
  } catch (err) {
    console.error('GET /api/faqs error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

faqs.post('/api/faqs', async (c) => {
  try {
    const body = await c.req.json<{
      question?: string;
      variants?: string[];
      answer?: string;
      lineAccountId?: string | null;
      isActive?: boolean;
    }>();
    if (!body.question?.trim()) return c.json({ success: false, error: 'question is required' }, 400);
    if (!body.answer?.trim()) return c.json({ success: false, error: 'answer is required' }, 400);
    if (body.variants !== undefined && !Array.isArray(body.variants)) {
      return c.json({ success: false, error: 'variants must be an array' }, 400);
    }

    const item = await createFaq(c.env.DB, {
      question: body.question,
      variants: body.variants ?? [],
      answer: body.answer,
      lineAccountId: body.lineAccountId ?? null,
      isActive: body.isActive ?? true,
    });
    return c.json({ success: true, data: serializeFaq(item) }, 201);
  } catch (err) {
    console.error('POST /api/faqs error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

faqs.put('/api/faqs/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{
      question?: string;
      variants?: string[];
      answer?: string;
      lineAccountId?: string | null;
      isActive?: boolean;
    }>();
    if (body.variants !== undefined && !Array.isArray(body.variants)) {
      return c.json({ success: false, error: 'variants must be an array' }, 400);
    }

    const input: Parameters<typeof updateFaq>[2] = {};
    if (body.question !== undefined) input.question = body.question;
    if (body.variants !== undefined) input.variants = body.variants;
    if (body.answer !== undefined) input.answer = body.answer;
    if ('lineAccountId' in body) input.lineAccountId = body.lineAccountId ?? null;
    if (body.isActive !== undefined) input.isActive = body.isActive;

    const updated = await updateFaq(c.env.DB, id, input);
    if (!updated) return c.json({ success: false, error: 'FAQ not found' }, 404);
    return c.json({ success: true, data: serializeFaq(updated) });
  } catch (err) {
    console.error('PUT /api/faqs/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

faqs.delete('/api/faqs/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const item = await getFaqById(c.env.DB, id);
    if (!item) return c.json({ success: false, error: 'FAQ not found' }, 404);
    await deleteFaq(c.env.DB, id);
    return c.json({ success: true, data: null });
  } catch (err) {
    console.error('DELETE /api/faqs/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

faqs.get('/api/faqs/unmatched', async (c) => {
  try {
    const accountId = c.req.query('accountId');
    const rows = await getUnmatchedQuestions(c.env.DB, accountId || undefined);
    return c.json({ success: true, data: rows.map(serializeUnmatched) });
  } catch (err) {
    console.error('GET /api/faqs/unmatched error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

faqs.post('/api/faqs/from-unmatched/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json<{
      answer?: string;
      variants?: string[];
      question?: string;
      lineAccountId?: string | null;
      isActive?: boolean;
    }>();
    if (!body.answer?.trim()) return c.json({ success: false, error: 'answer is required' }, 400);
    if (body.variants !== undefined && !Array.isArray(body.variants)) {
      return c.json({ success: false, error: 'variants must be an array' }, 400);
    }
    const unmatched = await getUnmatchedById(c.env.DB, id);
    if (!unmatched) return c.json({ success: false, error: 'Unmatched question not found' }, 404);

    const item = await createFaq(c.env.DB, {
      question: body.question?.trim() || unmatched.question,
      variants: body.variants ?? [],
      answer: body.answer,
      lineAccountId: 'lineAccountId' in body ? (body.lineAccountId ?? null) : unmatched.line_account_id,
      // reviewer R1-I1: EditDialog が送る isActive を尊重する。無効で昇格したら無効 FAQ を作る
      // (flag ON アカウントで意図せぬ自動返信の入口にしない)。省略時のみ既定 true。
      isActive: body.isActive ?? true,
    });
    await markUnmatchedResolved(c.env.DB, id, item.id);
    return c.json({ success: true, data: serializeFaq(item) }, 201);
  } catch (err) {
    console.error('POST /api/faqs/from-unmatched/:id error:', err);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

faqs.get('/api/account-settings/faq-bot', async (c) => {
  const accountId = c.req.query('accountId');
  if (!accountId) return c.json({ success: false, error: 'accountId required' }, 400);

  const row = await c.env.DB
    .prepare(`SELECT value FROM account_settings WHERE line_account_id = ? AND key = 'faq_bot'`)
    .bind(accountId)
    .first<{ value: string }>();
  const value = row?.value ? normalizeSettings(JSON.parse(row.value) as Partial<typeof DEFAULT_FAQ_BOT_SETTINGS>) : DEFAULT_FAQ_BOT_SETTINGS;
  return c.json({ success: true, data: value });
});

faqs.put('/api/account-settings/faq-bot', async (c) => {
  const body = await c.req.json<Partial<typeof DEFAULT_FAQ_BOT_SETTINGS> & { accountId?: string }>();
  if (!body.accountId) return c.json({ success: false, error: 'accountId required' }, 400);

  const value = normalizeSettings(body);
  const id = crypto.randomUUID();
  const now = nowJst();
  const json = JSON.stringify(value);

  await c.env.DB
    .prepare(
      `INSERT INTO account_settings (id, line_account_id, key, value, created_at, updated_at)
       VALUES (?, ?, 'faq_bot', ?, ?, ?)
       ON CONFLICT (line_account_id, key) DO UPDATE SET value = ?, updated_at = ?`,
    )
    .bind(id, body.accountId, json, now, now, json, now)
    .run();

  return c.json({ success: true, data: value });
});

export { faqs };
