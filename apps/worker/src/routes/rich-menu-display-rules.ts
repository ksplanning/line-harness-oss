import {
  RICH_MENU_DISPLAY_CONDITION_TYPES,
  createRichMenuDisplayRule,
  deleteRichMenuDisplayRule,
  getLineAccountById,
  getRichMenuDisplayRule,
  listRichMenuDisplayRules,
  updateRichMenuDisplayRule,
  type CreateRichMenuDisplayRuleInput,
  type RichMenuDisplayConditionType,
  type UpdateRichMenuDisplayRuleInput,
} from '@line-crm/db';
import { Hono } from 'hono';
import type { Env } from '../index.js';
import {
  RichMenuRuleReapplyConflictError,
  createRichMenuRuleReapplyJob,
  getLatestRichMenuRuleReapplyJob,
} from '../services/rich-menu-rule-work.js';

const richMenuDisplayRules = new Hono<Env>();
const CONDITION_TYPES = new Set<string>(RICH_MENU_DISPLAY_CONDITION_TYPES);

function accountIdFromQuery(c: { req: { query(name: string): string | undefined } }): string | null {
  const accountId = c.req.query('accountId')?.trim();
  return accountId || null;
}

function normalizeConditionValue(type: RichMenuDisplayConditionType, raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 10_000) return null;
  if (type.startsWith('metadata_')) {
    try {
      const parsed = JSON.parse(raw) as { key?: unknown; value?: unknown };
      if (typeof parsed.key !== 'string' || !parsed.key.trim() || parsed.key.length > 200) return null;
      if (!Object.prototype.hasOwnProperty.call(parsed, 'value')) return null;
      const allowedScalar = parsed.value === null || ['string', 'number', 'boolean'].includes(typeof parsed.value);
      if (!allowedScalar) return null;
      if (type.endsWith('contains') && typeof parsed.value !== 'string') return null;
      return JSON.stringify({ key: parsed.key.trim(), value: parsed.value });
    } catch {
      return null;
    }
  }
  const value = raw.trim();
  return value && value.length <= 200 ? value : null;
}

function parseFullInput(
  accountId: string,
  body: unknown,
): { value: CreateRichMenuDisplayRuleInput } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be an object' };
  const input = body as Record<string, unknown>;
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const richMenuId = typeof input.richMenuId === 'string' ? input.richMenuId.trim() : '';
  if (!name || name.length > 80) return { error: 'name must be 1-80 characters' };
  if (!CONDITION_TYPES.has(String(input.conditionType))) return { error: 'unsupported conditionType' };
  const conditionType = input.conditionType as RichMenuDisplayConditionType;
  const conditionValue = normalizeConditionValue(conditionType, input.conditionValue);
  if (!conditionValue) return { error: 'invalid conditionValue' };
  if (!richMenuId || richMenuId.length > 200) return { error: 'richMenuId must be 1-200 characters' };
  if (!Number.isInteger(input.priority) || (input.priority as number) < -1_000_000 || (input.priority as number) > 1_000_000) {
    return { error: 'priority must be an integer between -1000000 and 1000000' };
  }
  if (typeof input.isActive !== 'boolean') return { error: 'isActive must be boolean' };
  return {
    value: {
      accountId,
      name,
      conditionType,
      conditionValue,
      richMenuId,
      priority: input.priority as number,
      isActive: input.isActive,
    },
  };
}

async function readJson(c: { req: { json<T>(): Promise<T> } }): Promise<unknown | null> {
  try { return await c.req.json<unknown>(); } catch { return null; }
}

richMenuDisplayRules.get('/api/rich-menu-display-rules', async (c) => {
  const accountId = accountIdFromQuery(c);
  if (!accountId) return c.json({ success: false, error: 'accountId is required' }, 400);
  if (!await getLineAccountById(c.env.DB, accountId)) return c.json({ success: false, error: 'account not found' }, 404);
  const rules = await listRichMenuDisplayRules(c.env.DB, accountId);
  return c.json({ success: true, data: rules });
});

richMenuDisplayRules.post('/api/rich-menu-display-rules', async (c) => {
  const accountId = accountIdFromQuery(c);
  if (!accountId) return c.json({ success: false, error: 'accountId is required' }, 400);
  if (!await getLineAccountById(c.env.DB, accountId)) return c.json({ success: false, error: 'account not found' }, 404);
  const parsed = parseFullInput(accountId, await readJson(c));
  if ('error' in parsed) return c.json({ success: false, error: parsed.error }, 400);
  const created = await createRichMenuDisplayRule(c.env.DB, parsed.value);
  return c.json({ success: true, data: created }, 201);
});

richMenuDisplayRules.get('/api/rich-menu-display-rules/reapply/latest', async (c) => {
  const accountId = accountIdFromQuery(c);
  if (!accountId) return c.json({ success: false, error: 'accountId is required' }, 400);
  if (!await getLineAccountById(c.env.DB, accountId)) return c.json({ success: false, error: 'account not found' }, 404);
  const job = await getLatestRichMenuRuleReapplyJob(c.env.DB, accountId);
  return c.json({ success: true, data: job });
});

richMenuDisplayRules.post('/api/rich-menu-display-rules/reapply', async (c) => {
  const accountId = accountIdFromQuery(c);
  if (!accountId) return c.json({ success: false, error: 'accountId is required' }, 400);
  if (!await getLineAccountById(c.env.DB, accountId)) return c.json({ success: false, error: 'account not found' }, 404);
  try {
    const job = await createRichMenuRuleReapplyJob(c.env.DB, accountId);
    return c.json({ success: true, data: job }, 202);
  } catch (error) {
    if (error instanceof RichMenuRuleReapplyConflictError) {
      return c.json({
        success: false,
        error: 'reapply already running or started recently',
        data: error.job,
      }, 409);
    }
    throw error;
  }
});

richMenuDisplayRules.get('/api/rich-menu-display-rules/:id', async (c) => {
  const accountId = accountIdFromQuery(c);
  if (!accountId) return c.json({ success: false, error: 'accountId is required' }, 400);
  const rule = await getRichMenuDisplayRule(c.env.DB, c.req.param('id'), accountId);
  if (!rule) return c.json({ success: false, error: 'rule not found' }, 404);
  return c.json({ success: true, data: rule });
});

richMenuDisplayRules.patch('/api/rich-menu-display-rules/:id', async (c) => {
  const accountId = accountIdFromQuery(c);
  if (!accountId) return c.json({ success: false, error: 'accountId is required' }, 400);
  const existing = await getRichMenuDisplayRule(c.env.DB, c.req.param('id'), accountId);
  if (!existing) return c.json({ success: false, error: 'rule not found' }, 404);
  const body = await readJson(c);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ success: false, error: 'body must be an object' }, 400);
  }
  const patch = body as Record<string, unknown>;
  const merged = parseFullInput(accountId, {
    name: patch.name ?? existing.name,
    conditionType: patch.conditionType ?? existing.conditionType,
    conditionValue: patch.conditionValue ?? existing.conditionValue,
    richMenuId: patch.richMenuId ?? existing.richMenuId,
    priority: patch.priority ?? existing.priority,
    isActive: patch.isActive ?? existing.isActive,
  });
  if ('error' in merged) return c.json({ success: false, error: merged.error }, 400);
  const update: UpdateRichMenuDisplayRuleInput = {
    name: merged.value.name,
    conditionType: merged.value.conditionType,
    conditionValue: merged.value.conditionValue,
    richMenuId: merged.value.richMenuId,
    priority: merged.value.priority,
    isActive: merged.value.isActive,
  };
  const updated = await updateRichMenuDisplayRule(c.env.DB, existing.id, accountId, update);
  return c.json({ success: true, data: updated });
});

richMenuDisplayRules.delete('/api/rich-menu-display-rules/:id', async (c) => {
  const accountId = accountIdFromQuery(c);
  if (!accountId) return c.json({ success: false, error: 'accountId is required' }, 400);
  const removed = await deleteRichMenuDisplayRule(c.env.DB, c.req.param('id'), accountId);
  if (!removed) return c.json({ success: false, error: 'rule not found' }, 404);
  return c.json({ success: true, data: null });
});

export { richMenuDisplayRules };
