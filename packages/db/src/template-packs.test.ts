/**
 * template-packs.ts (G16 テンプレパック) の db helper 検証 (real SQLite / schema replay)。
 *
 *   - create → getWithItems で順序付き items を保全
 *   - update で name / items を丸ごと差し替え (並び替え = 配列順で order_index 再採番)
 *   - delete で items が CASCADE 削除
 *   - list は account-scoped + itemCount 付き
 *   - 空パック (items 0 件) も作れる
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import {
  listTemplatePacks,
  createTemplatePack,
  getTemplatePackWithItems,
  updateTemplatePack,
  deleteTemplatePack,
} from './template-packs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const s = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) {
          params = args;
          return api;
        },
        async first<T>() {
          return (s.get(...(params as never[])) as T) ?? null;
        },
        async all<T>() {
          return { results: s.all(...(params as never[])) as T[] };
        },
        async run() {
          const info = s.run(...(params as never[]));
          return { meta: { changes: info.changes } };
        },
      };
      return api;
    },
  } as unknown as D1Database;
}

let raw: Database.Database;
let db: D1Database;

function seedAccount(id: string) {
  raw.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret) VALUES (?,?,?,?,?)`).run(id, `ch-${id}`, id, 'tok', 'sec');
}

beforeEach(() => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON'); // CASCADE を効かせる
  raw.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  db = d1(raw);
  seedAccount('acc-1');
  seedAccount('acc-2');
});

describe('template-packs helper', () => {
  test('create → getWithItems preserves ordered items', async () => {
    const pack = await createTemplatePack(db, {
      accountId: 'acc-1',
      name: '初回あいさつセット',
      items: [
        { messageType: 'text', messageContent: 'こんにちは' },
        { messageType: 'flex', messageContent: '{"type":"bubble"}' },
        { messageType: 'text', messageContent: 'ご質問はお気軽に' },
      ],
    });
    const got = await getTemplatePackWithItems(db, pack.id);
    expect(got!.name).toBe('初回あいさつセット');
    expect(got!.items.map((i) => i.order_index)).toEqual([0, 1, 2]);
    expect(got!.items.map((i) => i.message_type)).toEqual(['text', 'flex', 'text']);
    expect(got!.items[0].message_content).toBe('こんにちは');
  });

  test('update replaces items in array order (reorder → order_index re-numbered)', async () => {
    const pack = await createTemplatePack(db, {
      accountId: 'acc-1',
      name: 'p',
      items: [
        { messageType: 'text', messageContent: 'A' },
        { messageType: 'text', messageContent: 'B' },
      ],
    });
    // 並び替え: B → A
    await updateTemplatePack(db, pack.id, {
      items: [
        { messageType: 'text', messageContent: 'B' },
        { messageType: 'text', messageContent: 'A' },
      ],
    });
    const got = await getTemplatePackWithItems(db, pack.id);
    expect(got!.items.map((i) => i.message_content)).toEqual(['B', 'A']);
    expect(got!.items.map((i) => i.order_index)).toEqual([0, 1]);
  });

  test('update rename keeps items', async () => {
    const pack = await createTemplatePack(db, { accountId: 'acc-1', name: '旧', items: [{ messageType: 'text', messageContent: 'A' }] });
    await updateTemplatePack(db, pack.id, { name: '新' });
    const got = await getTemplatePackWithItems(db, pack.id);
    expect(got!.name).toBe('新');
    expect(got!.items).toHaveLength(1);
  });

  test('delete removes the pack and CASCADE-deletes its items', async () => {
    const pack = await createTemplatePack(db, { accountId: 'acc-1', name: 'p', items: [{ messageType: 'text', messageContent: 'A' }] });
    await deleteTemplatePack(db, pack.id);
    expect(await getTemplatePackWithItems(db, pack.id)).toBeNull();
    const remaining = raw.prepare(`SELECT COUNT(*) AS n FROM template_pack_items WHERE pack_id = ?`).get(pack.id) as { n: number };
    expect(remaining.n).toBe(0);
  });

  test('list is account-scoped with itemCount', async () => {
    await createTemplatePack(db, { accountId: 'acc-1', name: 'A1', items: [{ messageType: 'text', messageContent: 'x' }, { messageType: 'text', messageContent: 'y' }] });
    await createTemplatePack(db, { accountId: 'acc-2', name: 'A2', items: [] });
    const forAcc1 = await listTemplatePacks(db, 'acc-1');
    expect(forAcc1.map((p) => p.name)).toEqual(['A1']);
    expect(forAcc1[0].itemCount).toBe(2);
  });

  test('empty pack (0 items) is allowed', async () => {
    const pack = await createTemplatePack(db, { accountId: 'acc-1', name: 'empty', items: [] });
    const got = await getTemplatePackWithItems(db, pack.id);
    expect(got!.items).toHaveLength(0);
  });
});
