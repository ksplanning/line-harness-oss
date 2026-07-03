/**
 * campaigns.ts (G3 キャンペーン集計) の db helper 検証 (real SQLite / schema replay + 052)。
 *
 *   - CRUD round-trip (create/list/rename/delete)
 *   - list は account-scoped (別 account の campaign は出ない)
 *   - linkBroadcastToCampaign は同 account の配信のみ更新 (別 account の配信は動かさない)
 *   - 集計: pre-aggregate (broadcast 単位) → campaign 合算が単純合計と一致 (fan-out 膨張なし)
 *   - 未紐付け配信を分母に混ぜない
 *   - 二重計上なし (複数 insight 行があっても最新 1 行のみ)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach } from 'vitest';
import {
  listCampaigns,
  createCampaign,
  getCampaignById,
  renameCampaign,
  deleteCampaign,
  linkBroadcastToCampaign,
  getCampaignAggregate,
} from './campaigns.js';

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

/** broadcasts に line_account_id + campaign_id を指定して insert。total_count = 対象数。 */
function seedBroadcast(id: string, accountId: string, campaignId: string | null, title: string, targetCount: number, sentAt: string | null) {
  raw.prepare(
    `INSERT INTO broadcasts (id, title, message_type, message_content, line_account_id, campaign_id, total_count, sent_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(id, title, 'text', 'hi', accountId, campaignId, targetCount, sentAt, sentAt ?? '2026-03-01T00:00:00.000');
}

function seedInsight(id: string, broadcastId: string, opened: number, clicked: number, createdAt: string) {
  raw.prepare(
    `INSERT INTO broadcast_insights (id, broadcast_id, unique_impression, unique_click, status, created_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(id, broadcastId, opened, clicked, 'ready', createdAt);
}

const BENIGN = /duplicate column name|already exists/i;

/** schema.sql + 全 migration を replay して本番 D1 相当のスキーマを作る (bootstrap.test と同方式)。
 *  broadcasts.line_account_id (migration 008) と campaign_id (migration 052) の両方が要るため。 */
function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  const files = readdirSync(join(PKG_ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    for (const stmt of readFileSync(join(PKG_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((s) => s.trim()).filter(Boolean)) {
      try {
        db.exec(stmt);
      } catch (e) {
        if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e;
      }
    }
  }
}

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  db = d1(raw);
});

describe('campaigns CRUD', () => {
  test('create → getById round-trips name and account', async () => {
    seedAccount('acc-1');
    const c = await createCampaign(db, { accountId: 'acc-1', name: '春の販促' });
    const got = await getCampaignById(db, c.id);
    expect(got!.name).toBe('春の販促');
    expect(got!.account_id).toBe('acc-1');
  });

  test('rename changes the name', async () => {
    seedAccount('acc-1');
    const c = await createCampaign(db, { accountId: 'acc-1', name: '旧' });
    const r = await renameCampaign(db, c.id, '新');
    expect(r!.name).toBe('新');
  });

  test('delete removes the row', async () => {
    seedAccount('acc-1');
    const c = await createCampaign(db, { accountId: 'acc-1', name: 'x' });
    expect(await deleteCampaign(db, c.id)).toBe(true);
    expect(await getCampaignById(db, c.id)).toBeNull();
  });

  test('list is account-scoped (other account campaigns are invisible)', async () => {
    seedAccount('acc-1');
    seedAccount('acc-2');
    await createCampaign(db, { accountId: 'acc-1', name: 'A1' });
    await createCampaign(db, { accountId: 'acc-2', name: 'A2' });
    const forAcc1 = await listCampaigns(db, 'acc-1');
    expect(forAcc1.map((c) => c.name)).toEqual(['A1']);
  });
});

describe('linkBroadcastToCampaign', () => {
  test('links a broadcast of the same account', async () => {
    seedAccount('acc-1');
    const c = await createCampaign(db, { accountId: 'acc-1', name: 'C' });
    seedBroadcast('b-1', 'acc-1', null, 'B', 100, '2026-03-01T00:00:00.000');
    const ok = await linkBroadcastToCampaign(db, 'b-1', c.id, 'acc-1');
    expect(ok).toBe(true);
    const agg = await getCampaignAggregate(db, c.id);
    expect(agg.broadcastCount).toBe(1);
  });

  test('does NOT link a broadcast belonging to another account', async () => {
    seedAccount('acc-1');
    seedAccount('acc-2');
    const c = await createCampaign(db, { accountId: 'acc-1', name: 'C' });
    seedBroadcast('b-2', 'acc-2', null, 'B2', 100, '2026-03-01T00:00:00.000'); // acc-2 の配信
    const ok = await linkBroadcastToCampaign(db, 'b-2', c.id, 'acc-1'); // acc-1 として紐付け試行
    expect(ok).toBe(false); // 更新 0 件 = 別 account の配信は動かない
  });
});

describe('getCampaignAggregate (pre-aggregate → sum)', () => {
  test('sums per-broadcast opened/clicked; matches simple total (no fan-out inflation)', async () => {
    seedAccount('acc-1');
    const c = await createCampaign(db, { accountId: 'acc-1', name: 'C' });
    seedBroadcast('b-1', 'acc-1', c.id, 'B1', 300, '2026-03-01T00:00:00.000');
    seedBroadcast('b-2', 'acc-1', c.id, 'B2', 200, '2026-03-02T00:00:00.000');
    seedInsight('i-1', 'b-1', 80, 20, '2026-03-01T12:00:00.000');
    seedInsight('i-2', 'b-2', 50, 10, '2026-03-02T12:00:00.000');

    const agg = await getCampaignAggregate(db, c.id);
    expect(agg.broadcastCount).toBe(2);
    expect(agg.totalTarget).toBe(500); // 300 + 200
    expect(agg.totalOpened).toBe(130); // 80 + 50
    expect(agg.totalClicked).toBe(30); // 20 + 10
  });

  test('uses only the latest insight per broadcast (no double counting from multiple insight rows)', async () => {
    seedAccount('acc-1');
    const c = await createCampaign(db, { accountId: 'acc-1', name: 'C' });
    seedBroadcast('b-1', 'acc-1', c.id, 'B1', 100, '2026-03-01T00:00:00.000');
    // 同一 broadcast に 2 つの insight 行 (retry 等)。最新のみ採用。
    seedInsight('i-old', 'b-1', 10, 2, '2026-03-01T10:00:00.000');
    seedInsight('i-new', 'b-1', 40, 8, '2026-03-01T20:00:00.000');
    const agg = await getCampaignAggregate(db, c.id);
    expect(agg.totalOpened).toBe(40); // 最新のみ (10+40 で膨張しない)
    expect(agg.totalClicked).toBe(8);
  });

  test('does NOT include unlinked broadcasts in the totals', async () => {
    seedAccount('acc-1');
    const c = await createCampaign(db, { accountId: 'acc-1', name: 'C' });
    seedBroadcast('b-1', 'acc-1', c.id, 'linked', 100, '2026-03-01T00:00:00.000');
    seedBroadcast('b-2', 'acc-1', null, 'unlinked', 999, '2026-03-01T00:00:00.000'); // 未紐付け
    seedInsight('i-1', 'b-1', 30, 5, '2026-03-01T12:00:00.000');
    seedInsight('i-2', 'b-2', 500, 100, '2026-03-01T12:00:00.000'); // 混ざってはいけない

    const agg = await getCampaignAggregate(db, c.id);
    expect(agg.broadcastCount).toBe(1);
    expect(agg.totalTarget).toBe(100);
    expect(agg.totalOpened).toBe(30);
  });

  test('returns null totals when no insight exists yet (crash-free)', async () => {
    seedAccount('acc-1');
    const c = await createCampaign(db, { accountId: 'acc-1', name: 'C' });
    seedBroadcast('b-1', 'acc-1', c.id, 'B1', 100, '2026-03-01T00:00:00.000');
    const agg = await getCampaignAggregate(db, c.id);
    expect(agg.broadcastCount).toBe(1);
    expect(agg.totalTarget).toBe(100);
    expect(agg.totalOpened).toBeNull();
    expect(agg.totalClicked).toBeNull();
  });
});
