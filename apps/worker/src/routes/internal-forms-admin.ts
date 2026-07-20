import { Hono, type Context, type Next } from 'hono';
import {
  getFormalooForm,
  getInternalFormSubmission,
  listInternalFormSubmissions,
  setFormRenderBackend,
  type FormalooForm,
  type InternalFormSubmission,
} from '@line-crm/db';
import type { Env } from '../index.js';

export const internalFormsAdmin = new Hono<Env>();

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

type DefinitionField = {
  id: string;
  label: string;
  type: string;
  required: boolean;
};

function parseIntSafe(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function queryInternalSubmissions(
  db: D1Database,
  formId: string,
  params: {
    q?: string | null;
    from?: string | null;
    to?: string | null;
    sortDir: 'asc' | 'desc';
    limit: number;
    offset: number;
  },
): Promise<{ rows: InternalFormSubmission[]; total: number }> {
  const where = ['form_id = ?'];
  const binds: unknown[] = [formId];
  if (params.q) {
    where.push("(answers_json LIKE ? OR IFNULL(friend_id, '') LIKE ?)");
    const like = `%${params.q}%`;
    binds.push(like, like);
  }
  if (params.from) {
    where.push('julianday(submitted_at) >= julianday(?)');
    binds.push(params.from);
  }
  if (params.to) {
    where.push('julianday(submitted_at) <= julianday(?)');
    binds.push(params.to);
  }

  const whereSql = where.join(' AND ');
  const direction = params.sortDir === 'asc' ? 'ASC' : 'DESC';
  const totalRow = await db
    .prepare(`SELECT COUNT(*) AS n FROM internal_form_submissions WHERE ${whereSql}`)
    .bind(...binds)
    .first<{ n: number }>();
  const rows = await db
    .prepare(
      `SELECT * FROM internal_form_submissions
       WHERE ${whereSql}
       ORDER BY julianday(submitted_at) ${direction}, rowid ${direction}
       LIMIT ? OFFSET ?`,
    )
    .bind(...binds, params.limit, params.offset)
    .all<InternalFormSubmission>();
  return { rows: rows.results, total: totalRow?.n ?? 0 };
}

function definitionFields(definitionJson: string): DefinitionField[] {
  try {
    const definition = JSON.parse(definitionJson) as { fields?: unknown };
    if (!Array.isArray(definition.fields)) return [];
    return definition.fields.flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
      const field = candidate as Record<string, unknown>;
      if (typeof field.id !== 'string' || !field.id) return [];
      return [{
        id: field.id,
        label: typeof field.label === 'string' && field.label ? field.label : field.id,
        type: typeof field.type === 'string' ? field.type : 'text',
        required: field.required === true,
      }];
    });
  } catch {
    return [];
  }
}

function parseAnswers(answersJson: string): unknown {
  try {
    return JSON.parse(answersJson) as unknown;
  } catch {
    return {};
  }
}

function serializeRow(row: InternalFormSubmission) {
  return {
    id: row.id,
    friendId: row.friend_id,
    answers: parseAnswers(row.answers_json),
    submittedAt: row.submitted_at,
    // A friend id is persisted only after the signed fr_id is verified and the
    // friend exists, so this is the internal equivalent of Formaloo `verified`.
    verified: row.friend_id !== null,
  };
}

async function getInternalForm(db: D1Database, formId: string): Promise<FormalooForm | null> {
  const form = await getFormalooForm(db, formId);
  if (!form || form.deleted || form.render_backend !== 'internal') return null;
  return form;
}

function notFound(c: Context<Env>) {
  return c.json({ success: false, error: 'フォームが見つかりません' }, 404);
}

async function rejectInternalFormalooMutation(c: Context<Env>, next: Next) {
  try {
    const form = await getInternalForm(c.env.DB, c.req.param('id')!);
    if (!form) return next();
    return c.json({
      success: false,
      error: '自前配信では Formaloo 専用操作を利用できません',
    }, 409);
  } catch (error) {
    console.error('internal form provider guard error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
}

internalFormsAdmin.get('/api/forms-advanced/:id/render-backend', async (c) => {
  try {
    const form = await getFormalooForm(c.env.DB, c.req.param('id'));
    if (!form || form.deleted) return notFound(c);
    return c.json({ success: true, data: { renderBackend: form.render_backend } });
  } catch (error) {
    console.error('GET /api/forms-advanced/:id/render-backend error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

internalFormsAdmin.patch('/api/forms-advanced/:id/render-backend', async (c) => {
  try {
    const id = c.req.param('id');
    const form = await getFormalooForm(c.env.DB, id);
    if (!form || form.deleted) return notFound(c);

    const body = await c.req.json<{ renderBackend?: unknown }>().catch(() => null);
    const renderBackend = body?.renderBackend;
    if (renderBackend !== 'formaloo' && renderBackend !== 'internal') {
      return c.json({ success: false, error: 'renderBackend は formaloo または internal を指定してください' }, 400);
    }

    if (!await setFormRenderBackend(c.env.DB, id, renderBackend)) return notFound(c);
    return c.json({ success: true, data: { renderBackend } });
  } catch (error) {
    console.error('PATCH /api/forms-advanced/:id/render-backend error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

// These routes mutate Formaloo or its D1 mirror. Internal forms must never fall
// through to them, while Formaloo forms continue to the existing handlers byte-for-byte.
internalFormsAdmin.post('/api/forms-advanced/:id/reapply-hosted', rejectInternalFormalooMutation);
internalFormsAdmin.patch('/api/forms-advanced/:id/rows/:rowId', rejectInternalFormalooMutation);
internalFormsAdmin.post('/api/forms-advanced/:id/import', rejectInternalFormalooMutation);
internalFormsAdmin.post('/api/forms-advanced/:id/rows/bulk-delete', rejectInternalFormalooMutation);
internalFormsAdmin.post('/api/forms-advanced/:id/gsheet/connect', rejectInternalFormalooMutation);
internalFormsAdmin.put('/api/forms-advanced/:id/instant-webhook', rejectInternalFormalooMutation);

internalFormsAdmin.get('/api/forms-advanced/:id/share', async (c, next) => {
  try {
    const id = c.req.param('id');
    const form = await getInternalForm(c.env.DB, id);
    if (!form) return next();

    const published = form.builder_status === 'published';
    const base = (c.env.WORKER_URL || new URL(c.req.url).origin).replace(/\/+$/, '');
    return c.json({
      success: true,
      data: {
        published,
        publicUrl: published ? `${base}/f/${encodeURIComponent(id)}` : null,
        lineDistUrl: null,
        iframeCode: null,
        scriptCode: null,
        gsheetConnected: false,
        gsheetUrl: null,
      },
    });
  } catch (error) {
    console.error('GET internal /api/forms-advanced/:id/share error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

internalFormsAdmin.get('/api/forms-advanced/:id/rows', async (c, next) => {
  try {
    const id = c.req.param('id');
    const form = await getInternalForm(c.env.DB, id);
    if (!form) return next();

    const page = Math.max(1, parseIntSafe(c.req.query('page'), 1));
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, parseIntSafe(c.req.query('pageSize'), DEFAULT_PAGE_SIZE)),
    );
    const { rows, total } = await queryInternalSubmissions(c.env.DB, id, {
      q: c.req.query('q') ?? null,
      from: c.req.query('from') ?? null,
      to: c.req.query('to') ?? null,
      sortDir: c.req.query('sort') === 'asc' ? 'asc' : 'desc',
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    const fields = definitionFields(form.definition_json)
      .map((field) => ({ slug: field.id, label: field.label }));

    return c.json({
      success: true,
      data: { rows: rows.map(serializeRow), total, page, pageSize, fields },
    });
  } catch (error) {
    console.error('GET internal /api/forms-advanced/:id/rows error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

internalFormsAdmin.get('/api/forms-advanced/:id/rows/:rowId', async (c, next) => {
  try {
    const id = c.req.param('id');
    const form = await getInternalForm(c.env.DB, id);
    if (!form) return next();

    const row = await getInternalFormSubmission(c.env.DB, id, c.req.param('rowId'));
    if (!row) return c.json({ success: false, error: '回答が見つかりません' }, 404);
    const fields = definitionFields(form.definition_json).map((field) => ({
      slug: field.id,
      label: field.label,
      type: field.type,
      required: field.required,
      editable: false,
    }));

    return c.json({
      success: true,
      data: {
        ...serializeRow(row),
        source: 'internal',
        allowPostEdit: 0,
        fields,
        lastEdit: null,
      },
    });
  } catch (error) {
    console.error('GET internal /api/forms-advanced/:id/rows/:rowId error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});

internalFormsAdmin.get('/api/forms-advanced/:id/stats', async (c, next) => {
  try {
    const id = c.req.param('id');
    const form = await getInternalForm(c.env.DB, id);
    if (!form) return next();

    const verifiedRow = await c.env.DB
      .prepare(
        `SELECT COUNT(*) AS n FROM internal_form_submissions
         WHERE form_id = ? AND friend_id IS NOT NULL`,
      )
      .bind(id)
      .first<{ n: number }>();
    const dailyRows = await c.env.DB
      .prepare(
        `SELECT substr(submitted_at, 1, 10) AS day, COUNT(*) AS count
         FROM internal_form_submissions
         WHERE form_id = ?
         GROUP BY substr(submitted_at, 1, 10)
         ORDER BY day ASC`,
      )
      .bind(id)
      .all<{ day: string; count: number }>();
    const { total } = await listInternalFormSubmissions(c.env.DB, id, { limit: 1, offset: 0 });

    return c.json({
      success: true,
      data: {
        total,
        verified: verifiedRow?.n ?? 0,
        daily: dailyRows.results,
        formaloo: null,
      },
    });
  } catch (error) {
    console.error('GET internal /api/forms-advanced/:id/stats error:', error);
    return c.json({ success: false, error: 'Internal server error' }, 500);
  }
});
