import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { beforeEach, describe, expect, test } from 'vitest';
import type { Env } from '../index.js';
import { richMenuDisplayRules } from './rich-menu-display-rules.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database): void {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(join(DB_ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    for (const sql of readFileSync(join(DB_ROOT, 'migrations', file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/)
      .map((part) => part.trim())
      .filter(Boolean)) {
      try { db.exec(sql); } catch (error) {
        if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
  }
}

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
        async run() {
          const info = statement.run(...(params as never[]));
          return { meta: { changes: info.changes } };
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

let DB: D1Database;

function app(): Hono<Env> {
  const hono = new Hono<Env>();
  hono.route('/', richMenuDisplayRules);
  return hono;
}

function call(method: string, path: string, body?: unknown): Promise<Response> {
  return app().request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  }, { DB } as Env['Bindings']);
}

const validRule = {
  name: '購入済み向け',
  conditionType: 'tag_exists',
  conditionValue: 'tag-paid',
  richMenuId: 'richmenu-paid',
  priority: 10,
  isActive: true,
};

beforeEach(() => {
  const raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  replayAll(raw);
  for (const accountId of ['acc-1', 'acc-2']) {
    raw.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
       VALUES (?, ?, ?, 'token', 'secret')`,
    ).run(accountId, `channel-${accountId}`, accountId);
  }
  DB = d1(raw);
});

describe('/api/rich-menu-display-rules CRUD', () => {
  test('requires accountId for all verbs and does not expose foreign ids', async () => {
    expect((await call('GET', '/api/rich-menu-display-rules')).status).toBe(400);
    expect((await call('POST', '/api/rich-menu-display-rules', validRule)).status).toBe(400);
    expect((await call('PATCH', '/api/rich-menu-display-rules/rule-x', validRule)).status).toBe(400);
    expect((await call('DELETE', '/api/rich-menu-display-rules/rule-x')).status).toBe(400);

    const createdResponse = await call('POST', '/api/rich-menu-display-rules?accountId=acc-1', validRule);
    const created = await createdResponse.json() as { data: { id: string } };
    expect((await call('PATCH', `/api/rich-menu-display-rules/${created.data.id}?accountId=acc-2`, { name: '改ざん' })).status).toBe(404);
    expect((await call('DELETE', `/api/rich-menu-display-rules/${created.data.id}?accountId=acc-2`)).status).toBe(404);
  });

  test('creates, lists in winner order, edits, toggles, and deletes', async () => {
    const low = await call('POST', '/api/rich-menu-display-rules?accountId=acc-1', validRule);
    expect(low.status).toBe(201);
    const high = await call('POST', '/api/rich-menu-display-rules?accountId=acc-1', {
      ...validRule,
      name: 'VIP',
      priority: 100,
      richMenuId: 'richmenu-vip',
    });
    expect(high.status).toBe(201);
    const highJson = await high.json() as { data: { id: string } };

    const listed = await call('GET', '/api/rich-menu-display-rules?accountId=acc-1');
    const listedJson = await listed.json() as { data: Array<{ name: string }> };
    expect(listedJson.data.map((rule) => rule.name)).toEqual(['VIP', '購入済み向け']);

    const updated = await call('PATCH', `/api/rich-menu-display-rules/${highJson.data.id}?accountId=acc-1`, {
      priority: 5,
      isActive: false,
      conditionType: 'metadata_equals',
      conditionValue: JSON.stringify({ key: '入金確認', value: '済' }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      data: { priority: 5, isActive: false, conditionType: 'metadata_equals' },
    });

    expect((await call('DELETE', `/api/rich-menu-display-rules/${highJson.data.id}?accountId=acc-1`)).status).toBe(200);
  });

  test('rejects unsupported or malformed conditions and invalid priority before writing', async () => {
    const invalidBodies = [
      { ...validRule, name: '  ' },
      { ...validRule, conditionType: 'unknown' },
      { ...validRule, conditionValue: '' },
      { ...validRule, conditionType: 'metadata_equals', conditionValue: '{}' },
      { ...validRule, conditionType: 'metadata_contains', conditionValue: JSON.stringify({ key: 'x', value: 1 }) },
      { ...validRule, richMenuId: '' },
      { ...validRule, priority: 1.5 },
      { ...validRule, priority: 1000001 },
      { ...validRule, isActive: 'yes' },
    ];
    for (const body of invalidBodies) {
      const response = await call('POST', '/api/rich-menu-display-rules?accountId=acc-1', body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    const listed = await call('GET', '/api/rich-menu-display-rules?accountId=acc-1');
    expect(await listed.json()).toEqual({ success: true, data: [] });
  });
});

describe('/api/rich-menu-display-rules/reapply', () => {
  test('reports the latest job, starts one bounded sweep, and blocks repeated starts', async () => {
    await DB.prepare(
      `INSERT INTO friends (id, line_user_id, line_account_id, is_following)
       VALUES ('friend-1', 'U-friend-1', 'acc-1', 1)`,
    ).run();

    const empty = await call('GET', '/api/rich-menu-display-rules/reapply/latest?accountId=acc-1');
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ success: true, data: null });

    const started = await call('POST', '/api/rich-menu-display-rules/reapply?accountId=acc-1');
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({
      success: true,
      data: { accountId: 'acc-1', status: 'running', totalCount: 1, processedCount: 0 },
    });

    const latest = await call('GET', '/api/rich-menu-display-rules/reapply/latest?accountId=acc-1');
    expect(await latest.json()).toMatchObject({
      success: true,
      data: { accountId: 'acc-1', status: 'running', totalCount: 1 },
    });

    const repeated = await call('POST', '/api/rich-menu-display-rules/reapply?accountId=acc-1');
    expect(repeated.status).toBe(409);
    expect(await repeated.json()).toMatchObject({
      success: false,
      error: 'reapply already running or started recently',
      data: { accountId: 'acc-1', status: 'running' },
    });
  });

  test('requires an existing account', async () => {
    expect((await call('GET', '/api/rich-menu-display-rules/reapply/latest')).status).toBe(400);
    expect((await call('POST', '/api/rich-menu-display-rules/reapply')).status).toBe(400);
    expect((await call('POST', '/api/rich-menu-display-rules/reapply?accountId=missing')).status).toBe(404);
  });
});
