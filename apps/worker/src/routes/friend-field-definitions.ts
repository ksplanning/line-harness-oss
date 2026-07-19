import { Hono } from 'hono';
import {
  createFriendFieldDefinition,
  deleteFriendFieldDefinition,
  listFriendFieldDefinitions,
  updateFriendFieldDefinition,
  type UpdateFriendFieldDefinitionInput,
} from '@line-crm/db';
import { isReservedFriendMetadataKey } from '@line-crm/shared';
import type { Env } from '../index.js';

const friendFieldDefinitions = new Hono<Env>();
const MAX_NAME_LENGTH = 100;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

type ValidationResult =
  | { ok: true; value: UpdateFriendFieldDefinitionInput }
  | { ok: false; error: string };

function validateBody(input: unknown, requireName: boolean): ValidationResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '定義は object で指定してください' };
  }
  const body = input as Record<string, unknown>;
  const value: UpdateFriendFieldDefinitionInput = {};

  if ('name' in body || requireName) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return { ok: false, error: '項目名を入力してください' };
    if (name.length > MAX_NAME_LENGTH || CONTROL_CHARACTER.test(name) || isReservedFriendMetadataKey(name)) {
      return { ok: false, error: '項目名が不正です' };
    }
    value.name = name;
  }
  if ('defaultValue' in body) {
    if (typeof body.defaultValue !== 'string') return { ok: false, error: '既定値は文字列で指定してください' };
    value.defaultValue = body.defaultValue;
  }
  if ('displayOrder' in body) {
    if (!Number.isInteger(body.displayOrder)) return { ok: false, error: '表示順は整数で指定してください' };
    value.displayOrder = body.displayOrder as number;
  }
  if ('isActive' in body) {
    if (typeof body.isActive !== 'boolean') return { ok: false, error: '有効状態は boolean で指定してください' };
    value.isActive = body.isActive;
  }
  if (!requireName && Object.keys(value).length === 0) {
    return { ok: false, error: '更新する項目を指定してください' };
  }
  return { ok: true, value };
}

function isUniqueNameError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed: friend_field_definitions\.name/i.test(error.message);
}

friendFieldDefinitions.get('/api/friend-field-definitions', async (c) => {
  try {
    return c.json({ success: true, data: await listFriendFieldDefinitions(c.env.DB) });
  } catch (error) {
    console.error('GET /api/friend-field-definitions error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

friendFieldDefinitions.post('/api/friend-field-definitions', async (c) => {
  const body = await c.req.json<unknown>().catch(() => null);
  const parsed = validateBody(body, true);
  if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
  try {
    const created = await createFriendFieldDefinition(c.env.DB, {
      name: parsed.value.name!,
      defaultValue: parsed.value.defaultValue ?? '',
      displayOrder: parsed.value.displayOrder ?? 0,
      isActive: parsed.value.isActive ?? true,
    });
    return c.json({ success: true, data: created }, 201);
  } catch (error) {
    if (isUniqueNameError(error)) return c.json({ success: false, error: '同じ項目名がすでに存在します' }, 409);
    console.error('POST /api/friend-field-definitions error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

friendFieldDefinitions.patch('/api/friend-field-definitions/:id', async (c) => {
  const body = await c.req.json<unknown>().catch(() => null);
  const parsed = validateBody(body, false);
  if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
  try {
    const updated = await updateFriendFieldDefinition(c.env.DB, c.req.param('id'), parsed.value);
    if (!updated) return c.json({ success: false, error: 'Friend field definition not found' }, 404);
    return c.json({ success: true, data: updated });
  } catch (error) {
    if (isUniqueNameError(error)) return c.json({ success: false, error: '同じ項目名がすでに存在します' }, 409);
    console.error('PATCH /api/friend-field-definitions/:id error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

friendFieldDefinitions.delete('/api/friend-field-definitions/:id', async (c) => {
  try {
    const deleted = await deleteFriendFieldDefinition(c.env.DB, c.req.param('id'));
    if (!deleted) return c.json({ success: false, error: 'Friend field definition not found' }, 404);
    return c.json({ success: true, data: null });
  } catch (error) {
    console.error('DELETE /api/friend-field-definitions/:id error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

export { friendFieldDefinitions };
