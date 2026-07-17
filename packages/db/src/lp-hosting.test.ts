/**
 * lp-hosting D1 accessor (harness-lp-hosting / T-A1 / C2)。
 *
 * 実 SQLite (better-sqlite3) に **実際の migration 102_lp_hosting.sql** を適用してから accessor を叩く。
 * 「記録が D1 に残る」= soft-200 禁止 (D-5): recordLpView 後に SELECT で行の実在を assert する。
 * 匿名 (friend_id=null) も必ず 1 行残す (§spec J)。countLpViews は総数と friend 紐付き数を分離する。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, test, expect, beforeEach } from 'vitest';
import {
  createLpPage,
  getLpPageBySlug,
  listLpPages,
  updateLpPageStatus,
  setLpPageEntryKey,
  deleteLpPage,
  recordLpView,
  getLpViews,
  countLpViews,
} from './lp-hosting.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION = join(__dirname, '../migrations/102_lp_hosting.sql');

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const s = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (s.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: s.all(...(params as never[])) as T[] }; },
        async run() { const info = s.run(...(params as never[])); return { meta: { changes: info.changes } }; },
      };
      return api;
    },
  } as unknown as D1Database;
}

let raw: Database.Database;
let db: D1Database;

beforeEach(() => {
  raw = new Database(':memory:');
  // 実 migration をそのまま適用 (statement 分割は他 test と同型)
  for (const stmt of readFileSync(MIGRATION, 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
    raw.exec(stmt);
  }
  db = d1(raw);
});

describe('lp_pages CRUD', () => {
  test('createLpPage → getLpPageBySlug で復元 (status 既定 active)', async () => {
    const page = await createLpPage(db, { slug: 'promo-a', title: '夏キャンペーン' });
    expect(page.slug).toBe('promo-a');
    expect(page.title).toBe('夏キャンペーン');
    expect(page.status).toBe('active');
    const got = await getLpPageBySlug(db, 'promo-a');
    expect(got?.title).toBe('夏キャンペーン');
    expect(got?.status).toBe('active');
  });

  test('listLpPages が作成済みを返す', async () => {
    await createLpPage(db, { slug: 'a', title: 'A' });
    await createLpPage(db, { slug: 'b', title: 'B' });
    const list = await listLpPages(db);
    expect(list.map((p) => p.slug).sort()).toEqual(['a', 'b']);
  });

  test('updateLpPageStatus で active↔stopped が反映される', async () => {
    await createLpPage(db, { slug: 'flip', title: 'F' });
    const stopped = await updateLpPageStatus(db, 'flip', 'stopped');
    expect(stopped?.status).toBe('stopped');
    expect((await getLpPageBySlug(db, 'flip'))?.status).toBe('stopped');
    const active = await updateLpPageStatus(db, 'flip', 'active');
    expect(active?.status).toBe('active');
  });

  test('setLpPageEntryKey で entry_key が記録される (index.html upload 時)', async () => {
    await createLpPage(db, { slug: 'e', title: 'E' });
    const updated = await setLpPageEntryKey(db, 'e', 'lp/e/index.html');
    expect(updated?.entry_key).toBe('lp/e/index.html');
    expect((await getLpPageBySlug(db, 'e'))?.entry_key).toBe('lp/e/index.html');
  });

  test('deleteLpPage で registry から消える (get → null)', async () => {
    await createLpPage(db, { slug: 'del', title: 'D' });
    await deleteLpPage(db, 'del');
    expect(await getLpPageBySlug(db, 'del')).toBeNull();
  });

  test('存在しない slug の update/get は null (crash させない)', async () => {
    expect(await getLpPageBySlug(db, 'nope')).toBeNull();
    expect(await updateLpPageStatus(db, 'nope', 'stopped')).toBeNull();
  });
});

describe('lp_views 記録 (soft-200 禁止・D1 実測 / D-5)', () => {
  test('recordLpView (friend 紐付き) の行が D1 に残る', async () => {
    await createLpPage(db, { slug: 'v', title: 'V' });
    const view = await recordLpView(db, { lpSlug: 'v', friendId: 'fr-1', friendName: '田中', referrer: 'https://line.me' });
    expect(view.friend_id).toBe('fr-1');
    // 実測: 生 SQL で行の実在を assert
    const rows = raw.prepare(`SELECT * FROM lp_views WHERE lp_slug = ?`).all('v') as Array<{ friend_id: string | null; friend_name: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].friend_id).toBe('fr-1');
    expect(rows[0].friend_name).toBe('田中');
  });

  test('recordLpView (匿名) も必ず 1 行残す (§spec J)', async () => {
    await createLpPage(db, { slug: 'v', title: 'V' });
    await recordLpView(db, { lpSlug: 'v' });
    const rows = raw.prepare(`SELECT * FROM lp_views WHERE lp_slug = ?`).all('v') as Array<{ friend_id: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].friend_id).toBeNull();
  });

  test('getLpViews が直近順で friend 名/時刻を返す', async () => {
    await createLpPage(db, { slug: 'v', title: 'V' });
    await recordLpView(db, { lpSlug: 'v', friendId: 'fr-1', friendName: 'A' });
    await recordLpView(db, { lpSlug: 'v' });
    const views = await getLpViews(db, 'v');
    expect(views).toHaveLength(2);
    // friend 紐付き行に friend_name が入る
    expect(views.some((v) => v.friend_id === 'fr-1' && v.friend_name === 'A')).toBe(true);
  });

  test('countLpViews が総数と friend 紐付き数を分離', async () => {
    await createLpPage(db, { slug: 'v', title: 'V' });
    await recordLpView(db, { lpSlug: 'v', friendId: 'fr-1', friendName: 'A' });
    await recordLpView(db, { lpSlug: 'v', friendId: 'fr-2', friendName: 'B' });
    await recordLpView(db, { lpSlug: 'v' }); // 匿名
    const counts = await countLpViews(db, 'v');
    expect(counts.total).toBe(3);
    expect(counts.friendBound).toBe(2);
  });

  test('閲覧ゼロの LP は total=0 / friendBound=0', async () => {
    await createLpPage(db, { slug: 'empty', title: 'E' });
    const counts = await countLpViews(db, 'empty');
    expect(counts.total).toBe(0);
    expect(counts.friendBound).toBe(0);
  });
});
