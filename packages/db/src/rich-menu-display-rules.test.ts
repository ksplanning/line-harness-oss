import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  createRichMenuDisplayRule,
  deleteRichMenuDisplayRule,
  getRichMenuDisplayRule,
  listRichMenuDisplayRules,
  updateRichMenuDisplayRule,
} from './rich-menu-display-rules.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database): void {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(join(PKG_ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    for (const sql of readFileSync(join(PKG_ROOT, 'migrations', file), 'utf8')
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

let raw: Database.Database;
let db: D1Database;

beforeEach(() => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  replayAll(raw);
  for (const accountId of ['acc-1', 'acc-2']) {
    raw.prepare(
      `INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
       VALUES (?, ?, ?, 'token', 'secret')`,
    ).run(accountId, `channel-${accountId}`, accountId);
  }
  db = d1(raw);
});

describe('rich menu display rule model', () => {
  test('CRUD is account-scoped, including update and delete by a known foreign id', async () => {
    const created = await createRichMenuDisplayRule(db, {
      accountId: 'acc-1',
      name: '購入済み',
      conditionType: 'tag_exists',
      conditionValue: 'tag-paid',
      richMenuId: 'richmenu-paid',
      priority: 20,
      isActive: true,
    });

    expect(created).toMatchObject({
      accountId: 'acc-1',
      name: '購入済み',
      priority: 20,
      isActive: true,
      activeFrom: null,
      activeUntil: null,
    });
    expect(await getRichMenuDisplayRule(db, created.id, 'acc-2')).toBeNull();
    expect(await updateRichMenuDisplayRule(db, created.id, 'acc-2', { name: '改ざん' })).toBeNull();
    expect(await deleteRichMenuDisplayRule(db, created.id, 'acc-2')).toBe(false);

    const updated = await updateRichMenuDisplayRule(db, created.id, 'acc-1', {
      name: 'VIP購入済み',
      priority: 30,
      isActive: false,
    });
    expect(updated).toMatchObject({ name: 'VIP購入済み', priority: 30, isActive: false });
    expect(await deleteRichMenuDisplayRule(db, created.id, 'acc-1')).toBe(true);
    expect(await getRichMenuDisplayRule(db, created.id, 'acc-1')).toBeNull();
  });

  test('highest priority wins; ties use created_at ASC then id ASC', async () => {
    const insert = raw.prepare(
      `INSERT INTO rich_menu_display_rules
       (id, account_id, name, condition_type, condition_value, rich_menu_id, priority, is_active, created_at)
       VALUES (?, 'acc-1', ?, 'tag_exists', 'tag-1', ?, ?, 1, ?)`,
    );
    insert.run('z-later', '高いが後発', 'menu-z', 100, '2026-07-19T20:00:01.000');
    insert.run('z-old', '同点ID後', 'menu-old-z', 100, '2026-07-19T20:00:00.000');
    insert.run('a-old', '同点ID先', 'menu-old-a', 100, '2026-07-19T20:00:00.000');
    insert.run('low', '低い', 'menu-low', 10, '2026-07-19T19:59:59.000');

    expect((await listRichMenuDisplayRules(db, 'acc-1')).map((rule) => rule.id)).toEqual([
      'a-old',
      'z-old',
      'z-later',
      'low',
    ]);
  });

  test('active-only filtering and an unpaginated practical rule count have no hidden limit', async () => {
    const insert = raw.prepare(
      `INSERT INTO rich_menu_display_rules
       (id, account_id, name, condition_type, condition_value, rich_menu_id, priority, is_active)
       VALUES (?, 'acc-1', ?, 'tag_exists', 'tag-1', ?, ?, ?)`,
    );
    for (let index = 0; index < 125; index++) {
      insert.run(`rule-${String(index).padStart(3, '0')}`, `ルール${index}`, `menu-${index}`, index, index === 124 ? 0 : 1);
    }

    expect(await listRichMenuDisplayRules(db, 'acc-1')).toHaveLength(125);
    expect(await listRichMenuDisplayRules(db, 'acc-1', { activeOnly: true })).toHaveLength(124);
    expect(await listRichMenuDisplayRules(db, 'acc-2')).toEqual([]);
  });

  test('round-trips optional period bounds and clears either bound explicitly', async () => {
    const created = await createRichMenuDisplayRule(db, {
      accountId: 'acc-1',
      name: '夏キャンペーン',
      conditionType: 'tag_exists',
      conditionValue: 'tag-1',
      richMenuId: 'menu-summer',
      priority: 50,
      isActive: true,
      activeFrom: '2026-07-20T01:00:00.000Z',
      activeUntil: '2026-07-31T09:00:00.000Z',
    });

    expect(created).toMatchObject({
      activeFrom: '2026-07-20T01:00:00.000Z',
      activeUntil: '2026-07-31T09:00:00.000Z',
    });
    expect(await updateRichMenuDisplayRule(db, created.id, 'acc-1', { activeUntil: null }))
      .toMatchObject({
        activeFrom: '2026-07-20T01:00:00.000Z',
        activeUntil: null,
      });
  });
});
