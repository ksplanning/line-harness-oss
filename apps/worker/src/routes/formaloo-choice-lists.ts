import { Hono, type Context } from 'hono';
import {
  ChoiceListError,
  createFormalooChoiceList,
  deleteFormalooChoiceList,
  getFormalooChoiceList,
  getFormalooForm,
  listFormalooChoiceLists,
  updateFormalooChoiceList,
  type ParsedFormalooChoiceList,
} from '@line-crm/db';
import type { Env } from '../index.js';

export const formalooChoiceLists = new Hono<Env>();

function sourceUrl(c: Context<Env>, formId: string, listId: string): string {
  const configuredOrigin = c.env.WORKER_URL?.trim().replace(/\/+$/, '');
  const origin = configuredOrigin || new URL(c.req.url).origin;
  return `${origin}/formaloo/choices/${encodeURIComponent(formId)}/${encodeURIComponent(listId)}`;
}

function serialize(c: Context<Env>, list: ParsedFormalooChoiceList) {
  return {
    id: list.id,
    formId: list.form_id,
    name: list.name,
    items: list.items,
    sourceUrl: sourceUrl(c, list.form_id, list.id),
    createdAt: list.created_at,
    updatedAt: list.updated_at,
  };
}

async function activeFormExists(c: Context<Env>, formId: string): Promise<boolean> {
  const form = await getFormalooForm(c.env.DB, formId);
  return form != null && form.deleted === 0;
}

function fail(c: Context<Env>, error: unknown, label: string) {
  if (error instanceof ChoiceListError) {
    return c.json({ success: false, error: error.message }, error.status);
  }
  console.error(`${label} error`);
  return c.json({ success: false, error: 'Internal server error' }, 500);
}

formalooChoiceLists.get('/api/forms-advanced/:formId/choice-lists', async (c) => {
  const formId = c.req.param('formId')!;
  if (!(await activeFormExists(c, formId))) {
    return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
  }
  const lists = await listFormalooChoiceLists(c.env.DB, formId);
  return c.json({ success: true, data: lists.map((list) => serialize(c, list)) });
});

formalooChoiceLists.post('/api/forms-advanced/:formId/choice-lists', async (c) => {
  const formId = c.req.param('formId')!;
  if (!(await activeFormExists(c, formId))) {
    return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
  }
  const body = await c.req
    .json<{ name?: unknown; items?: unknown }>()
    .catch(() => ({} as { name?: unknown; items?: unknown }));
  try {
    const list = await createFormalooChoiceList(c.env.DB, formId, { name: body.name, items: body.items });
    return c.json({ success: true, data: serialize(c, list) }, 201);
  } catch (error) {
    return fail(c, error, 'POST choice list');
  }
});

formalooChoiceLists.patch('/api/forms-advanced/:formId/choice-lists/:listId', async (c) => {
  const formId = c.req.param('formId')!;
  if (!(await activeFormExists(c, formId))) {
    return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
  }
  const body = await c.req
    .json<{ name?: unknown; items?: unknown }>()
    .catch(() => ({} as { name?: unknown; items?: unknown }));
  try {
    const list = await updateFormalooChoiceList(c.env.DB, formId, c.req.param('listId')!, body);
    return c.json({ success: true, data: serialize(c, list) });
  } catch (error) {
    return fail(c, error, 'PATCH choice list');
  }
});

formalooChoiceLists.delete('/api/forms-advanced/:formId/choice-lists/:listId', async (c) => {
  const formId = c.req.param('formId')!;
  if (!(await activeFormExists(c, formId))) {
    return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
  }
  try {
    await deleteFormalooChoiceList(c.env.DB, formId, c.req.param('listId')!);
    return c.json({ success: true, data: null });
  } catch (error) {
    return fail(c, error, 'DELETE choice list');
  }
});

// Formaloo calls this endpoint while a choice_fetch field is created and while respondents search.
// The response intentionally has no success/data envelope: the official contract is a raw array.
formalooChoiceLists.get('/formaloo/choices/:formId/:listId', async (c) => {
  const formId = c.req.param('formId')!;
  if (!(await activeFormExists(c, formId))) {
    return c.json({ error: 'Not found' }, 404);
  }
  const list = await getFormalooChoiceList(c.env.DB, formId, c.req.param('listId')!);
  if (!list) return c.json({ error: 'Not found' }, 404);

  const query = (c.req.query('q') ?? '').trim().toLocaleLowerCase().slice(0, 200);
  const items = (query
    ? list.items.filter((item) =>
        item.label.toLocaleLowerCase().includes(query) || item.value.toLocaleLowerCase().includes(query),
      )
    : list.items
  ).slice(0, 10);
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Cache-Control', 'no-store');
  return c.json(items);
});
