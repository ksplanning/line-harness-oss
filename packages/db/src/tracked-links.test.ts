/**
 * updateTrackedLink originalUrl 反映テスト (batch2 C7 / BACKLOG-tracked-link-url-edit)。
 *
 * silent-success 罠の根治: PATCH body 型に originalUrl を足しても db SET 句に original_url が
 * 無ければ無視される (batch1 で readOnly にした症状の原因)。SET 句に original_url = ? を加え
 * 「updateTrackedLink({originalUrl}) → getTrackedLinkById で反映」を real SQLite で assert。
 */
import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { createTrackedLink, updateTrackedLink, getTrackedLinkById } from './tracked-links.js';

// better-sqlite3 (同期) を D1 の async prepare().bind().first()/all()/run() 形に薄くラップ。
function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const s = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (s.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: s.all(...(params as never[])) as T[] }; },
        async run() { s.run(...(params as never[])); return {}; },
      };
      return api;
    },
  } as unknown as D1Database;
}

function seedDb(): D1Database {
  const raw = new Database(':memory:');
  raw.exec(`CREATE TABLE tracked_links (
    id TEXT PRIMARY KEY, name TEXT, original_url TEXT, tag_id TEXT, scenario_id TEXT,
    intro_template_id TEXT, reward_template_id TEXT, is_active INTEGER, click_count INTEGER,
    created_at TEXT, updated_at TEXT
  )`);
  return d1(raw);
}

describe('updateTrackedLink originalUrl (silent-success 根治 / T-U1)', () => {
  test('originalUrl を更新すると getTrackedLinkById で反映される', async () => {
    const db = seedDb();
    const created = await createTrackedLink(db, { name: 'リンク', originalUrl: 'https://old.example.com' });
    expect(created.original_url).toBe('https://old.example.com');

    const updated = await updateTrackedLink(db, created.id, { originalUrl: 'https://new.example.com/path' });
    expect(updated?.original_url).toBe('https://new.example.com/path');

    const fetched = await getTrackedLinkById(db, created.id);
    expect(fetched?.original_url).toBe('https://new.example.com/path');
  });

  test('originalUrl 未指定なら既存 URL を維持する (他フィールドだけ更新)', async () => {
    const db = seedDb();
    const created = await createTrackedLink(db, { name: 'リンク', originalUrl: 'https://keep.example.com' });

    const updated = await updateTrackedLink(db, created.id, { name: '改名' });
    expect(updated?.name).toBe('改名');
    expect(updated?.original_url).toBe('https://keep.example.com'); // 維持
  });

  test('name と originalUrl を同時更新できる', async () => {
    const db = seedDb();
    const created = await createTrackedLink(db, { name: '旧', originalUrl: 'https://a.example.com' });

    const updated = await updateTrackedLink(db, created.id, { name: '新', originalUrl: 'https://b.example.com' });
    expect(updated?.name).toBe('新');
    expect(updated?.original_url).toBe('https://b.example.com');
  });
});
