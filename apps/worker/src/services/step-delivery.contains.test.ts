/**
 * T-B1〜T-B5 (scenario-condition-contains) — contains 条件を production の
 * processStepDeliveries まで通す実 SQLite E2E。
 *
 * ⚠️ scenarios.test.ts の手書き mock (makeScenarioDb) は canned 応答を返すため
 * advanceFriendScenario の cursor 遷移を実行せず、分岐ジャンプの壊れを false-PASS させる
 * (planner GF-2 / failure_observable「検証が机上のみ」)。ゆえに本テストは b4-regression.test.ts と
 * 同じ real-SQLite パターン (better-sqlite3 :memory: + schema.sql + migrations replay(005 含む) + d1 shim)
 * を踏襲し、production の processStepDeliveries を実 cron 相当で回す。
 *
 * 日時比較は epoch (new Date(x).getTime())。文字列辞書比較は禁止 (地雷 D1: JST +09:00 vs UTC Z の false negative)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach, vi } from 'vitest';
import {
  addTagToFriend,
  createScenario,
  createScenarioStep,
  createTag,
  enrollFriendInScenario,
} from '@line-crm/db';
import * as stepDeliveryModule from './step-delivery.js';
import { isSupportedConditionType, processStepDeliveries } from './step-delivery.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../..', 'packages/db');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(DB_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    for (const s of readFileSync(join(DB_ROOT, 'migrations', f), 'utf8').split(/;\s*(?:\r?\n|$)/).map((x) => x.trim()).filter(Boolean)) {
      try { db.exec(s); } catch (e) { if (!BENIGN.test(e instanceof Error ? e.message : String(e))) throw e; }
    }
  }
}
function d1(db: Database.Database): D1Database {
  const makeStmt = (sql: string) => {
    const s = db.prepare(sql);
    let params: unknown[] = [];
    const api = {
      bind(...a: unknown[]) { params = a; return api; },
      async first<T>() { return (s.get(...(params as never[])) as T) ?? null; },
      async all<T>() { return { results: s.all(...(params as never[])) as T[] }; },
      async run() { const i = s.run(...(params as never[])); return { meta: { changes: i.changes } }; },
      __exec() { return s.run(...(params as never[])); },
    };
    return api;
  };
  return {
    prepare(sql: string) { return makeStmt(sql); },
    async batch(stmts: Array<{ __exec: () => unknown }>) { const tx = db.transaction(() => stmts.map((st) => st.__exec())); tx(); return stmts.map(() => ({ success: true })); },
  } as unknown as D1Database;
}

/** 過去の固定時刻 (JST +09:00)。全 active 登録の next_delivery_at をここへ倒し 1 tick=1 配信を保証。 */
const PAST = '2020-01-01T00:00:00.000+09:00';

let raw: Database.Database;
let db: D1Database;
let lineClient: { pushMessage: ReturnType<typeof vi.fn> };

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  db = d1(raw);
  lineClient = { pushMessage: vi.fn(async () => {}) };
});

function seedFriend(id: string, metadata: Record<string, unknown>): void {
  raw.prepare(
    `INSERT INTO friends (id, line_user_id, display_name, is_following, metadata) VALUES (?, ?, ?, 1, ?)`,
  ).run(id, `u-${id}`, 'テスト友だち', JSON.stringify(metadata));
}

/** active 登録の next_delivery_at を過去へ倒して確実に due にする (時間制御)。 */
function forceDue(): void {
  raw.prepare(`UPDATE friend_scenarios SET next_delivery_at = ? WHERE status = 'active'`).run(PAST);
}

/** messages_log から配信された step_order を配信順 (created_at epoch) で返す。 */
function deliveredStepOrders(): number[] {
  const rows = raw
    .prepare(
      `SELECT ss.step_order AS step_order, ml.rowid AS seq
       FROM messages_log ml
       JOIN scenario_steps ss ON ml.scenario_step_id = ss.id
       WHERE ml.direction = 'outgoing'
       ORDER BY ml.rowid ASC`,
    )
    .all() as Array<{ step_order: number; seq: number }>;
  return rows.map((r) => r.step_order);
}

async function runTick(): Promise<void> {
  forceDue();
  await processStepDeliveries(db, lineClient as unknown as Parameters<typeof processStepDeliveries>[1], undefined);
}

async function attachTag(friendId: string, name: string): Promise<void> {
  const tag = await createTag(db, { name });
  await addTagToFriend(db, friendId, tag.id);
}

async function createBranchScenario(conditionType: string, conditionValue: string) {
  const scenario = await createScenario(db, {
    name: `contains-${conditionType}`,
    triggerType: 'manual',
    deliveryMode: 'relative',
  });
  await createScenarioStep(db, {
    scenarioId: scenario.id,
    stepOrder: 0,
    messageType: 'text',
    messageContent: 'STEP0-plain',
  });
  await createScenarioStep(db, {
    scenarioId: scenario.id,
    stepOrder: 1,
    messageType: 'text',
    messageContent: 'STEP1-gate',
    conditionType,
    conditionValue,
    nextStepOnFalse: 3,
  });
  await createScenarioStep(db, {
    scenarioId: scenario.id,
    stepOrder: 2,
    messageType: 'text',
    messageContent: 'STEP2-routeA',
  });
  await createScenarioStep(db, {
    scenarioId: scenario.id,
    stepOrder: 3,
    messageType: 'text',
    messageContent: 'STEP3-routeB',
  });
  return scenario;
}

async function runBranchCase(input: {
  conditionType: string;
  conditionValue: string;
  metadata?: Record<string, unknown>;
  tagName?: string;
}): Promise<number[]> {
  const scenario = await createBranchScenario(input.conditionType, input.conditionValue);
  seedFriend('f1', input.metadata ?? {});
  if (input.tagName !== undefined) await attachTag('f1', input.tagName);
  await enrollFriendInScenario(db, 'f1', scenario.id);
  for (let i = 0; i < 4; i++) await runTick();
  return deliveredStepOrders();
}

describe('contains 条件の型・正規化 contract', () => {
  test('T-B1: 既存 4 型と contains 4 型を supported と判定する', () => {
    for (const conditionType of [
      'tag_exists',
      'tag_not_exists',
      'metadata_equals',
      'metadata_not_equals',
      'metadata_contains',
      'metadata_not_contains',
      'tag_name_contains',
      'tag_name_not_contains',
    ]) {
      expect(isSupportedConditionType(conditionType), conditionType).toBe(true);
    }
  });

  test('T-B2: normalizeForContains は NFKC + lower の純関数で、trim は呼び出し側で行う', () => {
    const normalizeForContains = Reflect.get(stepDeliveryModule, 'normalizeForContains') as
      | ((value: string) => string)
      | undefined;
    expect(normalizeForContains).toBeTypeOf('function');
    expect(normalizeForContains!('ＡＢＣ')).toBe('abc');
    expect(normalizeForContains!('MiXeD')).toBe('mixed');
    expect(normalizeForContains!('　購入　')).toBe(' 購入 ');
    expect(normalizeForContains!('　購入　').trim()).toBe('購入');
    expect(normalizeForContains!('')).toBe('');
  });
});

describe('T-B3 metadata contains 分岐 E2E (実 SQLite)', () => {
  test('metadata_contains 一致は true のため分岐せず順次配信する', async () => {
    const delivered = await runBranchCase({
      conditionType: 'metadata_contains',
      conditionValue: JSON.stringify({ key: 'answer', value: '購入済' }),
      metadata: { answer: '購入済-2026-01' },
    });
    expect(delivered).toEqual([0, 1, 2, 3]);
  });

  test('metadata_contains 不一致は false のため order3 へ分岐する', async () => {
    const delivered = await runBranchCase({
      conditionType: 'metadata_contains',
      conditionValue: JSON.stringify({ key: 'answer', value: '購入済' }),
      metadata: { answer: '未購入' },
    });
    expect(delivered).toEqual([0, 3]);
  });

  test('metadata_not_contains は真偽を反転し、contains 一致なら order3 へ分岐する', async () => {
    const delivered = await runBranchCase({
      conditionType: 'metadata_not_contains',
      conditionValue: JSON.stringify({ key: 'answer', value: '購入済' }),
      metadata: { answer: '購入済-2026-01' },
    });
    expect(delivered).toEqual([0, 3]);
  });

  test('metadata_not_contains は真偽を反転し、contains 不一致なら順次配信する', async () => {
    const delivered = await runBranchCase({
      conditionType: 'metadata_not_contains',
      conditionValue: JSON.stringify({ key: 'answer', value: '購入済' }),
      metadata: { answer: '未購入' },
    });
    expect(delivered).toEqual([0, 1, 2, 3]);
  });

  test.each([
    ['metadata_contains', [0, 3]],
    ['metadata_not_contains', [0, 1, 2, 3]],
  ] as const)('%s は metadata key 欠落を空 haystack として扱う', async (conditionType, expected) => {
    const delivered = await runBranchCase({
      conditionType,
      conditionValue: JSON.stringify({ key: 'missing', value: '購入済' }),
      metadata: {},
    });
    expect(delivered).toEqual(expected);
  });

  test.each([
    ['metadata_contains', [0, 3]],
    ['metadata_not_contains', [0, 1, 2, 3]],
  ] as const)('%s は Object.prototype 継承名も key 欠落として扱う', async (conditionType, expected) => {
    const delivered = await runBranchCase({
      conditionType,
      conditionValue: JSON.stringify({ key: 'toString', value: 'native code' }),
      metadata: {},
    });
    expect(delivered).toEqual(expected);
  });
});

describe('T-B4 tag name contains 分岐 E2E (実 SQLite JOIN)', () => {
  test('tag_name_contains 一致は true のため分岐せず順次配信する', async () => {
    const delivered = await runBranchCase({
      conditionType: 'tag_name_contains',
      conditionValue: '購入済',
      tagName: '購入済-2026-02',
    });
    expect(delivered).toEqual([0, 1, 2, 3]);
  });

  test('tag_name_contains 不一致は false のため order3 へ分岐する', async () => {
    const delivered = await runBranchCase({
      conditionType: 'tag_name_contains',
      conditionValue: '購入済',
      tagName: '問い合わせ中',
    });
    expect(delivered).toEqual([0, 3]);
  });

  test('tag_name_not_contains は真偽を反転し、contains 一致なら order3 へ分岐する', async () => {
    const delivered = await runBranchCase({
      conditionType: 'tag_name_not_contains',
      conditionValue: '購入済',
      tagName: '購入済-2026-02',
    });
    expect(delivered).toEqual([0, 3]);
  });

  test('tag_name_not_contains は真偽を反転し、contains 不一致なら順次配信する', async () => {
    const delivered = await runBranchCase({
      conditionType: 'tag_name_not_contains',
      conditionValue: '購入済',
      tagName: '問い合わせ中',
    });
    expect(delivered).toEqual([0, 1, 2, 3]);
  });
});

describe('T-B5 contains 正規化 E2E (実 SQLite)', () => {
  test.each([
    ['全角半角 + 大文字小文字', { answer: 'prefix-ＡＢＣ-suffix' }, 'abc'],
    ['ASCII 前後空白', { answer: '購入済-2026-01' }, '  購入済  '],
    ['全角前後空白', { answer: '購入済-2026-01' }, '　購入済　'],
    ['数値 metadata の String 化', { answer: 2026 }, '2026'],
  ] as const)('%s を吸収して metadata_contains が true になる', async (_name, metadata, needle) => {
    const delivered = await runBranchCase({
      conditionType: 'metadata_contains',
      conditionValue: JSON.stringify({ key: 'answer', value: needle }),
      metadata,
    });
    expect(delivered).toEqual([0, 1, 2, 3]);
  });

  test.each([
    ['metadata_contains', JSON.stringify({ key: 'answer', value: '' })],
    ['metadata_not_contains', JSON.stringify({ key: 'answer', value: '' })],
    ['tag_name_contains', ''],
    ['tag_name_not_contains', ''],
    ['metadata_contains', JSON.stringify({ key: 'answer', value: '　' })],
    ['metadata_not_contains', JSON.stringify({ key: 'answer', value: '　' })],
    ['tag_name_contains', '　'],
    ['tag_name_not_contains', '　'],
  ] as const)('%s の空または全角空白だけの needle は常に false', async (conditionType, conditionValue) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const delivered = await runBranchCase({
        conditionType,
        conditionValue,
        metadata: { answer: '購入済-2026-01' },
        tagName: '購入済-2026-02',
      });
      expect(delivered).toEqual([0, 3]);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
