import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { Hono } from 'hono';

const multicastRecipients: string[][] = [];
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: class {
    constructor(public token: string) {}
    async multicast(userIds: string[]) {
      multicastRecipients.push(userIds);
      return {};
    }
    async broadcast() {
      return { requestId: 'request-id' };
    }
  },
}));

const { broadcasts } = await import('./broadcasts.js');
const {
  countBroadcastRecipients,
  processQueuedBroadcasts,
  processScheduledBroadcasts,
} = await import('../services/broadcast.js');

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../../packages/db');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(raw: Database.Database): void {
  raw.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  const files = readdirSync(join(DB_ROOT, 'migrations'))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const statements = readFileSync(join(DB_ROOT, 'migrations', file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/)
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) {
      try {
        raw.exec(statement);
      } catch (error) {
        if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
  }
}

function d1(
  raw: Database.Database,
  beforeBatch?: () => Promise<void>,
): D1Database {
  return {
    prepare(sql: string) {
      const statement = raw.prepare(sql);
      let bindings: unknown[] = [];
      const api = {
        bind(...values: unknown[]) {
          bindings = values;
          return api;
        },
        async first<T>() {
          return (statement.get(...(bindings as never[])) as T) ?? null;
        },
        async all<T>() {
          return { results: statement.all(...(bindings as never[])) as T[] };
        },
        async run() {
          const result = statement.run(...(bindings as never[]));
          return { meta: { changes: result.changes } };
        },
      };
      return api;
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      await beforeBatch?.();
      const results: unknown[] = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  } as unknown as D1Database;
}

function setup(beforeBatch?: () => Promise<void>): {
  raw: Database.Database;
  db: D1Database;
  app: Hono;
} {
  const raw = new Database(':memory:');
  replayAll(raw);
  raw.prepare(
    `INSERT INTO line_accounts
       (id, channel_id, name, channel_access_token, channel_secret)
     VALUES ('acc-1', 'channel-1', '確認用', 'token', 'secret')`,
  ).run();
  raw.prepare(`INSERT INTO tags (id, name) VALUES ('vip', 'VIP'), ('blocked', '対象外')`).run();
  raw.prepare(
    `INSERT INTO friend_field_definitions
       (id, name, default_value, is_active)
     VALUES ('field-plan', 'プラン', '', 1)`,
  ).run();

  const insertFriend = raw.prepare(
    `INSERT INTO friends
       (id, line_user_id, display_name, line_account_id, is_following, metadata)
     VALUES (?, ?, ?, 'acc-1', ?, ?)`,
  );
  insertFriend.run('f-gold', 'u-gold', 'Gold', 1, JSON.stringify({ プラン: 'gold' }));
  insertFriend.run('f-blocked', 'u-blocked', 'Blocked', 1, JSON.stringify({ プラン: 'gold' }));
  insertFriend.run('f-silver', 'u-silver', 'Silver', 1, JSON.stringify({ プラン: 'silver' }));
  insertFriend.run('f-unfollowed', 'u-unfollowed', 'Unfollowed', 0, JSON.stringify({ プラン: 'gold' }));
  raw.prepare(
    `INSERT INTO friend_tags (friend_id, tag_id)
     VALUES ('f-gold', 'vip'), ('f-blocked', 'vip'), ('f-blocked', 'blocked'), ('f-unfollowed', 'vip')`,
  ).run();

  const db = d1(raw, beforeBatch);
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.env = {
      DB: db,
      WORKER_URL: 'https://worker.invalid',
      LINE_CHANNEL_ACCESS_TOKEN: 'token',
    } as never;
    await next();
  });
  app.route('/', broadcasts);
  return { raw, db, app };
}

const segmentConditions = {
  operator: 'AND' as const,
  rules: [
    { type: 'tag_exists' as const, value: 'vip' },
    { type: 'tag_not_exists' as const, value: 'blocked' },
    { type: 'metadata_equals' as const, value: { key: 'プラン', value: 'gold' } },
  ],
};

beforeEach(() => {
  multicastRecipients.length = 0;
});

describe('broadcast conditions save, preview, and send', () => {
  test('composer count excludes unfollowed friends with the same audience resolver', async () => {
    const { app } = setup();
    const response = await app.request('/api/segments/count', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        accountId: 'acc-1',
        followingOnly: true,
        conditions: {
          operator: 'AND',
          rules: [{ type: 'tag_exists', value: 'vip' }],
        },
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, count: 2 });
  });

  test('conditions round-trip and preview count equals the frozen actual recipients', async () => {
    const { raw, db, app } = setup();
    const create = await app.request('/api/broadcasts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '条件配信',
        messageType: 'text',
        messageContent: 'お知らせ',
        targetType: 'segment',
        lineAccountId: 'acc-1',
        segmentConditions,
      }),
    });
    expect(create.status).toBe(201);
    const created = await create.json() as {
      data: { id: string; targetType: string; segmentConditions: unknown };
    };
    expect(created.data.targetType).toBe('segment');
    expect(created.data.segmentConditions).toEqual(segmentConditions);

    const get = await app.request(`/api/broadcasts/${created.data.id}`);
    const fetched = await get.json() as { data: { segmentConditions: unknown } };
    expect(fetched.data.segmentConditions).toEqual(segmentConditions);

    const preview = await app.request(`/api/broadcasts/${created.data.id}/preview-count`);
    expect(preview.status).toBe(200);
    const previewBody = await preview.json() as { data: { count: number } };
    expect(previewBody.data.count).toBe(1);

    const send = await app.request(`/api/broadcasts/${created.data.id}/send`, { method: 'POST' });
    expect(send.status).toBe(202);
    const snapshot = raw.prepare(
      `SELECT friend_id, line_user_id
       FROM broadcast_recipient_snapshots
       WHERE broadcast_id = ?
       ORDER BY friend_id`,
    ).all(created.data.id);
    expect(snapshot).toEqual([{ friend_id: 'f-gold', line_user_id: 'u-gold' }]);

    raw.prepare(`DELETE FROM friend_tags WHERE friend_id = 'f-gold' AND tag_id = 'vip'`).run();
    await processQueuedBroadcasts(db, { multicast: vi.fn() } as never);
    expect(multicastRecipients).toEqual([['u-gold']]);

    const sent = raw.prepare(
      `SELECT status, total_count, success_count FROM broadcasts WHERE id = ?`,
    ).get(created.data.id) as { status: string; total_count: number; success_count: number };
    expect(sent).toEqual({ status: 'sent', total_count: 1, success_count: 1 });
    expect(sent.total_count).toBe(previewBody.data.count);
  });

  test('keeps an audience hidden from queue workers until its snapshot is complete', async () => {
    let releaseBatch!: () => void;
    let announceBatch!: () => void;
    const batchStarted = new Promise<void>((resolve) => { announceBatch = resolve; });
    const batchGate = new Promise<void>((resolve) => { releaseBatch = resolve; });
    let firstBatch = true;
    const { raw, db, app } = setup(async () => {
      if (!firstBatch) return;
      firstBatch = false;
      announceBatch();
      await batchGate;
    });
    const create = await app.request('/api/broadcasts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'スナップショット競合',
        messageType: 'text',
        messageContent: '送らない',
        targetType: 'segment',
        lineAccountId: 'acc-1',
        segmentConditions,
      }),
    });
    const created = await create.json() as { data: { id: string } };

    const sending = app.request(`/api/broadcasts/${created.data.id}/send`, {
      method: 'POST',
    });
    await batchStarted;
    expect(raw.prepare(
      `SELECT status, batch_offset FROM broadcasts WHERE id = ?`,
    ).get(created.data.id)).toEqual({ status: 'sending', batch_offset: -2 });

    await processQueuedBroadcasts(db, { multicast: vi.fn() } as never);
    expect(multicastRecipients).toEqual([]);

    releaseBatch();
    expect((await sending).status).toBe(202);
    expect(raw.prepare(
      `SELECT status, batch_offset FROM broadcasts WHERE id = ?`,
    ).get(created.data.id)).toEqual({ status: 'sending', batch_offset: 0 });
  });

  test('legacy tag-only draft keeps its payload and recipient behavior', async () => {
    const { raw, app } = setup();
    const create = await app.request('/api/broadcasts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '従来タグ配信',
        messageType: 'text',
        messageContent: '従来',
        targetType: 'tag',
        targetTagId: 'vip',
        lineAccountId: 'acc-1',
      }),
    });
    expect(create.status).toBe(201);
    const created = await create.json() as {
      data: { id: string; targetType: string; targetTagId: string; segmentConditions: unknown };
    };
    expect(created.data).toMatchObject({
      targetType: 'tag',
      targetTagId: 'vip',
      segmentConditions: null,
    });

    const preview = await app.request(`/api/broadcasts/${created.data.id}/preview-count`);
    const previewBody = await preview.json() as { data: { count: number } };
    expect(previewBody.data.count).toBe(2);

    const send = await app.request(`/api/broadcasts/${created.data.id}/send`, { method: 'POST' });
    expect(send.status).toBe(200);
    expect(multicastRecipients).toEqual([
      expect.arrayContaining(['u-gold', 'u-blocked']),
    ]);
    expect(raw.prepare(
      `SELECT segment_conditions FROM broadcasts WHERE id = ?`,
    ).get(created.data.id)).toEqual({ segment_conditions: null });
  });

  test('legacy tag queue markers stay internal, retain their old cap count, and clear on edit', async () => {
    const { raw, db, app } = setup();
    const marker = JSON.stringify({
      operator: 'AND',
      rules: [{ type: 'tag_exists', value: 'vip' }],
    });
    raw.prepare(
      `INSERT INTO broadcasts
         (id, title, message_type, message_content, target_type, target_tag_id,
          status, line_account_id, segment_conditions)
       VALUES ('legacy-marker', '旧タグ', 'text', '従来', 'tag', 'vip',
               'draft', 'acc-1', ?)`,
    ).run(marker);

    const existing = await import('@line-crm/db').then(
      ({ getBroadcastById }) => getBroadcastById(db, 'legacy-marker'),
    );
    expect(existing).not.toBeNull();
    await expect(countBroadcastRecipients(db, existing!)).resolves.toBe(3);

    const get = await app.request('/api/broadcasts/legacy-marker');
    await expect(get.json()).resolves.toMatchObject({
      success: true,
      data: { targetType: 'tag', segmentConditions: null },
    });

    const update = await app.request('/api/broadcasts/legacy-marker', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '編集済み旧タグ' }),
    });
    expect(update.status).toBe(200);
    expect(raw.prepare(
      `SELECT title, target_tag_id, segment_conditions
       FROM broadcasts WHERE id = 'legacy-marker'`,
    ).get()).toEqual({
      title: '編集済み旧タグ',
      target_tag_id: 'vip',
      segment_conditions: null,
    });
  });

  test('scheduled conditional delivery also freezes recipients before queue execution', async () => {
    const { raw, db, app } = setup();
    const create = await app.request('/api/broadcasts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '予約条件配信',
        messageType: 'text',
        messageContent: '予約',
        targetType: 'segment',
        lineAccountId: 'acc-1',
        scheduledAt: '2020-01-01T00:00:00.000+09:00',
        segmentConditions,
      }),
    });
    const created = await create.json() as { data: { id: string } };

    await processScheduledBroadcasts(db, { multicast: vi.fn() } as never);
    expect(raw.prepare(
      `SELECT status, total_count FROM broadcasts WHERE id = ?`,
    ).get(created.data.id)).toEqual({ status: 'sending', total_count: 1 });

    raw.prepare(`DELETE FROM friend_tags WHERE friend_id = 'f-gold' AND tag_id = 'vip'`).run();
    await processQueuedBroadcasts(db, { multicast: vi.fn() } as never);
    expect(multicastRecipients).toEqual([['u-gold']]);
  });

  test('rejects empty tag IDs instead of saving a broader accidental audience', async () => {
    const { app } = setup();
    const response = await app.request('/api/broadcasts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '不正条件',
        messageType: 'text',
        messageContent: '送らない',
        targetType: 'segment',
        lineAccountId: 'acc-1',
        segmentConditions: {
          operator: 'AND',
          rules: [{ type: 'tag_not_exists', value: '' }],
        },
      }),
    });
    expect(response.status).toBe(400);
  });

  test('rejects a conditional target without conditions instead of scheduling a permanent retry', async () => {
    const { app } = setup();
    const response = await app.request('/api/broadcasts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: '条件なし',
        messageType: 'text',
        messageContent: '送らない',
        targetType: 'segment',
        lineAccountId: 'acc-1',
      }),
    });
    expect(response.status).toBe(400);
  });
});
