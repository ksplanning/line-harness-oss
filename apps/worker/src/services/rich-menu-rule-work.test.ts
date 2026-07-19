import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import { createRichMenuDisplayRule } from '@line-crm/db';
import {
  RichMenuRuleReapplyConflictError,
  createRichMenuRuleReapplyJob,
  getLatestRichMenuRuleReapplyJob,
  processRichMenuRuleWork,
} from './rich-menu-rule-work.js';

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

let raw: Database.Database;
let db: D1Database;

function seedFriends(count: number, accountId = 'acc-1'): void {
  const insert = raw.prepare(
    `INSERT INTO friends (id, line_user_id, line_account_id, metadata, is_following)
     VALUES (?, ?, ?, '{}', 1)`,
  );
  for (let index = 0; index < count; index++) {
    const id = `friend-${String(index).padStart(3, '0')}`;
    insert.run(id, `U${index}`, accountId);
  }
}

beforeEach(() => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  replayAll(raw);
  raw.prepare(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
     VALUES ('acc-1', 'channel-1', 'A', 'account-token', 'secret')`,
  ).run();
  db = d1(raw);
});

describe('rich menu rule reapply jobs', () => {
  test('starts one account job with total visibility and blocks repeated clicks for a cooldown window', async () => {
    seedFriends(3);
    const job = await createRichMenuRuleReapplyJob(db, 'acc-1');
    expect(job).toMatchObject({ accountId: 'acc-1', status: 'running', totalCount: 3, processedCount: 0 });
    await expect(createRichMenuRuleReapplyJob(db, 'acc-1')).rejects.toBeInstanceOf(RichMenuRuleReapplyConflictError);
    expect(await getLatestRichMenuRuleReapplyJob(db, 'acc-1')).toMatchObject({ id: job.id, totalCount: 3 });
  });

  test('keeps an empty sweep lock until the worker completes it', async () => {
    const job = await createRichMenuRuleReapplyJob(db, 'acc-1');
    expect(job).toMatchObject({ status: 'running', totalCount: 0 });
    await expect(createRichMenuRuleReapplyJob(db, 'acc-1')).rejects.toBeInstanceOf(RichMenuRuleReapplyConflictError);

    expect(await processRichMenuRuleWork(db)).toEqual({ attempted: 0, queueProcessed: 0, jobsCompleted: 1 });
    expect(await getLatestRichMenuRuleReapplyJob(db, 'acc-1')).toMatchObject({ status: 'completed', totalCount: 0 });
  });

  test('processes at most 20 friends per tick and exposes deterministic progress/result counts', async () => {
    seedFriends(25);
    const job = await createRichMenuRuleReapplyJob(db, 'acc-1');

    const first = await processRichMenuRuleWork(db, { limit: 20 });
    expect(first).toMatchObject({ attempted: 20, jobsCompleted: 0 });
    expect(await getLatestRichMenuRuleReapplyJob(db, 'acc-1')).toMatchObject({
      id: job.id,
      status: 'running',
      processedCount: 20,
      skippedCount: 20,
    });

    const second = await processRichMenuRuleWork(db, { limit: 20 });
    expect(second).toMatchObject({ attempted: 5, jobsCompleted: 1 });
    expect(await getLatestRichMenuRuleReapplyJob(db, 'acc-1')).toMatchObject({
      status: 'completed',
      processedCount: 25,
      skippedCount: 25,
      failedCount: 0,
    });
  });

  test('a LINE failure advances the sweep, records failure, and leaves retry work for a later tick', async () => {
    seedFriends(1);
    raw.prepare("INSERT INTO tags (id, name) VALUES ('tag-paid', '購入済み')").run();
    raw.prepare("INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-000', 'tag-paid')").run();
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-1',
      name: '購入済み',
      conditionType: 'tag_exists',
      conditionValue: 'tag-paid',
      richMenuId: 'menu-paid',
      priority: 10,
      isActive: true,
    });
    await createRichMenuRuleReapplyJob(db, 'acc-1');

    await processRichMenuRuleWork(db, {
      limit: 20,
      clientFactory: () => ({
        async linkRichMenuToUser() { throw new Error('temporary'); },
        async unlinkRichMenuFromUser() {},
      }),
    });

    expect(await getLatestRichMenuRuleReapplyJob(db, 'acc-1')).toMatchObject({
      status: 'completed',
      processedCount: 1,
      failedCount: 1,
    });
    expect(raw.prepare('SELECT attempts FROM rich_menu_rule_evaluation_queue WHERE friend_id = ?').get('friend-000'))
      .toEqual({ attempts: 1 });
  });

  test('reserves bounded capacity for dirty changes while a large sweep is running', async () => {
    seedFriends(25);
    raw.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
       VALUES ('acc-2', 'channel-2', 'B', 'account-token-2', 'secret-2')`,
    ).run();
    raw.prepare(
      `INSERT INTO friends (id, line_user_id, line_account_id, metadata, is_following)
       VALUES ('friend-dirty', 'U-dirty', 'acc-2', '{}', 1)`,
    ).run();
    raw.prepare(
      `INSERT INTO rich_menu_rule_evaluation_queue (friend_id) VALUES ('friend-dirty')
       ON CONFLICT(friend_id) DO UPDATE SET available_at = excluded.available_at`,
    ).run();
    await createRichMenuRuleReapplyJob(db, 'acc-1');

    const result = await processRichMenuRuleWork(db, { limit: 20 });

    expect(result).toEqual({ attempted: 20, queueProcessed: 1, jobsCompleted: 0 });
    expect(await getLatestRichMenuRuleReapplyJob(db, 'acc-1')).toMatchObject({ processedCount: 19 });
  });

  test('a sweep never erases a newer metadata change queued while LINE is in flight', async () => {
    seedFriends(1);
    raw.prepare("INSERT INTO tags (id, name) VALUES ('tag-paid', '購入済み')").run();
    raw.prepare("INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-000', 'tag-paid')").run();
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-1', name: '購入済み', conditionType: 'tag_exists', conditionValue: 'tag-paid',
      richMenuId: 'menu-paid', priority: 10, isActive: true,
    });
    await createRichMenuRuleReapplyJob(db, 'acc-1');
    raw.prepare('DELETE FROM rich_menu_rule_evaluation_queue').run();
    let releaseLine!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseLine = resolve; });

    const processing = processRichMenuRuleWork(db, {
      limit: 1,
      clientFactory: () => ({
        async linkRichMenuToUser() { markStarted(); await release; },
        async unlinkRichMenuFromUser() {},
      }),
    });
    await started;
    raw.prepare("UPDATE friends SET metadata = '{\"rank\":\"VIP\"}' WHERE id = 'friend-000'").run();
    releaseLine();
    await processing;

    expect(raw.prepare('SELECT friend_id FROM rich_menu_rule_evaluation_queue').all())
      .toEqual([{ friend_id: 'friend-000' }]);
  });

  test('only the worker that still owns the job lock reports its completion', async () => {
    seedFriends(1);
    raw.prepare("INSERT INTO tags (id, name) VALUES ('tag-paid', '購入済み')").run();
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-1', name: '購入済み', conditionType: 'tag_exists', conditionValue: 'tag-paid',
      richMenuId: 'menu-paid', priority: 10, isActive: true,
    });
    raw.prepare("INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-000', 'tag-paid')").run();
    await createRichMenuRuleReapplyJob(db, 'acc-1');
    raw.prepare('DELETE FROM rich_menu_rule_evaluation_queue').run();
    let releaseLine!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseLine = resolve; });
    const clientFactory = () => ({
      async linkRichMenuToUser() { markStarted(); await release; },
      async unlinkRichMenuFromUser() {},
    });

    const staleWorker = processRichMenuRuleWork(db, { limit: 1, clientFactory });
    await started;
    raw.prepare(
      "UPDATE rich_menu_rule_reapply_jobs SET locked_until = '2000-01-01T00:00:00.000' WHERE account_id = 'acc-1'",
    ).run();
    const newOwnerResult = await processRichMenuRuleWork(db, { limit: 1, clientFactory });
    releaseLine();
    const staleResult = await staleWorker;

    expect(newOwnerResult.jobsCompleted + staleResult.jobsCompleted).toBe(1);
    expect(await getLatestRichMenuRuleReapplyJob(db, 'acc-1')).toMatchObject({ status: 'completed' });
  });
});

describe('dirty friend queue', () => {
  test('deduplicates rapid changes and drains only the global bounded limit', async () => {
    seedFriends(25);
    const enqueue = raw.prepare(
      `INSERT INTO rich_menu_rule_evaluation_queue (friend_id) VALUES (?)
       ON CONFLICT(friend_id) DO UPDATE SET available_at = excluded.available_at`,
    );
    for (let index = 0; index < 25; index++) {
      const friendId = `friend-${String(index).padStart(3, '0')}`;
      enqueue.run(friendId);
      enqueue.run(friendId);
    }
    expect(raw.prepare('SELECT COUNT(*) AS count FROM rich_menu_rule_evaluation_queue').get()).toEqual({ count: 25 });

    expect(await processRichMenuRuleWork(db, { limit: 20 })).toMatchObject({ attempted: 20, queueProcessed: 20 });
    expect(raw.prepare('SELECT COUNT(*) AS count FROM rich_menu_rule_evaluation_queue').get()).toEqual({ count: 5 });
  });

  test('leases a queued friend so overlapping workers perform one LINE mutation', async () => {
    seedFriends(1);
    raw.prepare("INSERT INTO tags (id, name) VALUES ('tag-paid', '購入済み')").run();
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-1',
      name: '購入済み',
      conditionType: 'tag_exists',
      conditionValue: 'tag-paid',
      richMenuId: 'menu-paid',
      priority: 10,
      isActive: true,
    });
    raw.prepare("INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-000', 'tag-paid')").run();
    let linkCalls = 0;
    const clientFactory = () => ({
      async linkRichMenuToUser() {
        linkCalls++;
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
      async unlinkRichMenuFromUser() {},
    });

    const results = await Promise.all([
      processRichMenuRuleWork(db, { limit: 1, clientFactory }),
      processRichMenuRuleWork(db, { limit: 1, clientFactory }),
    ]);

    expect(linkCalls).toBe(1);
    expect(results.reduce((total, result) => total + result.queueProcessed, 0)).toBe(1);
  });

  test('a queue lease only clears its own generation, not a newer dirty update', async () => {
    seedFriends(1);
    raw.prepare("INSERT INTO tags (id, name) VALUES ('tag-paid', '購入済み')").run();
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-1', name: '購入済み', conditionType: 'tag_exists', conditionValue: 'tag-paid',
      richMenuId: 'menu-paid', priority: 10, isActive: true,
    });
    raw.prepare("INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-000', 'tag-paid')").run();
    let releaseLine!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseLine = resolve; });

    const processing = processRichMenuRuleWork(db, {
      limit: 1,
      clientFactory: () => ({
        async linkRichMenuToUser() { markStarted(); await release; },
        async unlinkRichMenuFromUser() {},
      }),
    });
    await started;
    raw.prepare("UPDATE friends SET metadata = '{\"paid\":true}' WHERE id = 'friend-000'").run();
    releaseLine();
    await processing;

    expect(raw.prepare('SELECT friend_id FROM rich_menu_rule_evaluation_queue').all())
      .toEqual([{ friend_id: 'friend-000' }]);
  });

  test('one friend shared by a sweep and dirty queue receives one LINE mutation across overlapping workers', async () => {
    seedFriends(1);
    raw.prepare("INSERT INTO tags (id, name) VALUES ('tag-paid', '購入済み')").run();
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-1', name: '購入済み', conditionType: 'tag_exists', conditionValue: 'tag-paid',
      richMenuId: 'menu-paid', priority: 10, isActive: true,
    });
    raw.prepare("INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-000', 'tag-paid')").run();
    await createRichMenuRuleReapplyJob(db, 'acc-1');
    let linkCalls = 0;
    const clientFactory = () => ({
      async linkRichMenuToUser() {
        linkCalls++;
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
      async unlinkRichMenuFromUser() {},
    });

    await Promise.all([
      processRichMenuRuleWork(db, { limit: 2, clientFactory }),
      processRichMenuRuleWork(db, { limit: 2, clientFactory }),
    ]);

    expect(linkCalls).toBe(1);
  });
});
