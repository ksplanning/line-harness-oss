import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createRichMenuDisplayRule } from '@line-crm/db';
import {
  applyRichMenuRulesForFriend,
  type RichMenuRuleLineClient,
} from './rich-menu-rule-engine.js';

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
      try {
        db.exec(sql);
      } catch (error) {
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

function lineDouble(options: { failLink?: boolean; failUnlink?: boolean } = {}) {
  const calls: Array<{ method: 'link' | 'unlink'; userId: string; richMenuId?: string }> = [];
  const factory = vi.fn((_token: string): RichMenuRuleLineClient => ({
    async linkRichMenuToUser(userId, richMenuId) {
      calls.push({ method: 'link', userId, richMenuId });
      if (options.failLink) throw new Error('LINE 503 temporary');
    },
    async unlinkRichMenuFromUser(userId) {
      calls.push({ method: 'unlink', userId });
      if (options.failUnlink) throw new Error('LINE 503 temporary');
    },
  }));
  return { calls, factory };
}

let raw: Database.Database;
let db: D1Database;

beforeEach(() => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  replayAll(raw);
  raw.prepare(
    `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
     VALUES ('acc-1', 'channel-1', 'A', 'account-token', 'secret')`,
  ).run();
  raw.prepare(
    `INSERT INTO friends (id, line_user_id, line_account_id, metadata, is_following)
     VALUES ('friend-1', 'U1', 'acc-1', '{}', 1)`,
  ).run();
  raw.prepare("INSERT INTO tags (id, name) VALUES ('tag-paid', '購入済み')").run();
  raw.prepare("INSERT INTO friend_tags (friend_id, tag_id) VALUES ('friend-1', 'tag-paid')").run();
  raw.prepare('DELETE FROM rich_menu_rule_evaluation_queue').run();
  db = d1(raw);
});

describe('applyRichMenuRulesForFriend', () => {
  test('applies the first matching rule by priority DESC, created_at ASC, id ASC', async () => {
    raw.prepare(
      `INSERT INTO rich_menu_display_rules
       (id, account_id, name, condition_type, condition_value, rich_menu_id, priority, created_at)
       VALUES ('z-old', 'acc-1', '同点後', 'tag_exists', 'tag-paid', 'menu-z', 100, '2026-07-19T20:00:00.000'),
              ('a-old', 'acc-1', '同点先', 'tag_exists', 'tag-paid', 'menu-a', 100, '2026-07-19T20:00:00.000'),
              ('higher-no-match', 'acc-1', '不一致', 'tag_exists', 'missing', 'menu-x', 200, '2026-07-19T19:00:00.000')`,
    ).run();
    const line = lineDouble();

    const result = await applyRichMenuRulesForFriend(db, 'friend-1', line.factory);

    expect(result).toMatchObject({ status: 'applied', ruleId: 'a-old', richMenuId: 'menu-a' });
    expect(line.calls).toEqual([{ method: 'link', userId: 'U1', richMenuId: 'menu-a' }]);
    expect(raw.prepare('SELECT rule_id, rich_menu_id FROM rich_menu_friend_assignments WHERE friend_id = ?').get('friend-1'))
      .toEqual({ rule_id: 'a-old', rich_menu_id: 'menu-a' });
  });

  test('reuses effective custom-field defaults through evaluateCondition', async () => {
    raw.prepare(
      `INSERT INTO friend_field_definitions (id, name, default_value)
       VALUES ('field-payment', '入金確認', '未')`,
    ).run();
    const rule = await createRichMenuDisplayRule(db, {
      accountId: 'acc-1',
      name: '未入金',
      conditionType: 'metadata_equals',
      conditionValue: JSON.stringify({ key: '入金確認', value: '未' }),
      richMenuId: 'menu-unpaid',
      priority: 10,
      isActive: true,
    });
    const line = lineDouble();

    const result = await applyRichMenuRulesForFriend(db, 'friend-1', line.factory);

    expect(result).toMatchObject({ status: 'applied', ruleId: rule.id, richMenuId: 'menu-unpaid' });
  });

  test('same successful assignment skips every LINE call and only refreshes the winning rule id', async () => {
    const rule = await createRichMenuDisplayRule(db, {
      accountId: 'acc-1',
      name: '購入済み',
      conditionType: 'tag_exists',
      conditionValue: 'tag-paid',
      richMenuId: 'menu-paid',
      priority: 10,
      isActive: true,
    });
    raw.prepare(
      `INSERT INTO rich_menu_friend_assignments (friend_id, account_id, rule_id, rich_menu_id)
       VALUES ('friend-1', 'acc-1', NULL, 'menu-paid')`,
    ).run();
    const line = lineDouble();

    const result = await applyRichMenuRulesForFriend(db, 'friend-1', line.factory);

    expect(result).toMatchObject({ status: 'skipped', reason: 'same_menu', ruleId: rule.id });
    expect(line.factory).not.toHaveBeenCalled();
    expect(line.calls).toEqual([]);
    expect(raw.prepare('SELECT rule_id FROM rich_menu_friend_assignments WHERE friend_id = ?').get('friend-1'))
      .toEqual({ rule_id: rule.id });
  });

  test('active rules with no match remove the per-user override and record default state', async () => {
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-1',
      name: '未所持タグ',
      conditionType: 'tag_exists',
      conditionValue: 'missing',
      richMenuId: 'menu-missing',
      priority: 10,
      isActive: true,
    });
    const line = lineDouble();

    const result = await applyRichMenuRulesForFriend(db, 'friend-1', line.factory);

    expect(result).toMatchObject({ status: 'reverted', richMenuId: null });
    expect(line.calls).toEqual([{ method: 'unlink', userId: 'U1' }]);
    expect(raw.prepare('SELECT rule_id, rich_menu_id FROM rich_menu_friend_assignments WHERE friend_id = ?').get('friend-1'))
      .toEqual({ rule_id: null, rich_menu_id: null });
  });

  test('zero rules and no engine assignment is byte-compatible: no LINE client and no assignment', async () => {
    raw.prepare(
      `INSERT INTO rich_menu_rule_evaluation_queue (friend_id) VALUES ('friend-1')
       ON CONFLICT(friend_id) DO NOTHING`,
    ).run();
    const line = lineDouble();

    const result = await applyRichMenuRulesForFriend(db, 'friend-1', line.factory);

    expect(result).toEqual({ status: 'no_rules', friendId: 'friend-1' });
    expect(line.factory).not.toHaveBeenCalled();
    expect(raw.prepare('SELECT * FROM rich_menu_friend_assignments').all()).toEqual([]);
    expect(raw.prepare('SELECT * FROM rich_menu_rule_evaluation_queue').all()).toEqual([]);
  });

  test('deleting the last rule still reverts friends previously managed by the engine', async () => {
    raw.prepare(
      `INSERT INTO rich_menu_friend_assignments (friend_id, account_id, rule_id, rich_menu_id)
       VALUES ('friend-1', 'acc-1', NULL, 'menu-old')`,
    ).run();
    const line = lineDouble();

    const result = await applyRichMenuRulesForFriend(db, 'friend-1', line.factory);

    expect(result.status).toBe('reverted');
    expect(line.calls).toEqual([{ method: 'unlink', userId: 'U1' }]);
  });

  test('LINE failure is fail-soft, preserves successful state, and leaves a retry row', async () => {
    await createRichMenuDisplayRule(db, {
      accountId: 'acc-1',
      name: '購入済み',
      conditionType: 'tag_exists',
      conditionValue: 'tag-paid',
      richMenuId: 'menu-new',
      priority: 10,
      isActive: true,
    });
    raw.prepare(
      `INSERT INTO rich_menu_friend_assignments (friend_id, account_id, rule_id, rich_menu_id)
       VALUES ('friend-1', 'acc-1', NULL, 'menu-old')`,
    ).run();
    const line = lineDouble({ failLink: true });

    const result = await applyRichMenuRulesForFriend(db, 'friend-1', line.factory);

    expect(result).toMatchObject({ status: 'failed', friendId: 'friend-1' });
    expect(raw.prepare('SELECT rich_menu_id FROM rich_menu_friend_assignments WHERE friend_id = ?').get('friend-1'))
      .toEqual({ rich_menu_id: 'menu-old' });
    expect(raw.prepare('SELECT attempts FROM rich_menu_rule_evaluation_queue WHERE friend_id = ?').get('friend-1'))
      .toEqual({ attempts: 1 });
  });
});
