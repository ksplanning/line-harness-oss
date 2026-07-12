/**
 * T-A2 (scenario-visual-p2-branch slice-1) — 実 SQLite E2E で「分岐宣言 → 実配信で B ルートが
 * 配られる」を機械検証する RED 先行テスト。
 *
 * ⚠️ scenarios.test.ts の手書き mock (makeScenarioDb) は canned 応答を返すため
 * advanceFriendScenario の cursor 遷移を実行せず、分岐ジャンプの壊れを false-PASS させる
 * (planner GF-2 / failure_observable「検証が机上のみ」)。ゆえに本テストは b4-regression.test.ts と
 * 同じ real-SQLite パターン (better-sqlite3 :memory: + schema.sql + migrations replay(005 含む) + d1 shim)
 * を踏襲し、production の processStepDeliveries を実 cron 相当で回す。
 *
 * RED (step-delivery.ts:195 修正前): jumpStep(B ルート) は時刻だけ流用され、実配信は順次の次
 *   (A ルート) が配られる → delivered=[0,2]。
 * GREEN (修正後): cursor が jumpStep.step_order-1 へ進み、次 cron で jumpStep が配られる → delivered=[0,3]。
 *
 * 日時比較は epoch (new Date(x).getTime())。文字列辞書比較は禁止 (地雷 D1: JST +09:00 vs UTC Z の false negative)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, test, beforeEach, vi } from 'vitest';
import {
  createScenario,
  createScenarioStep,
  enrollFriendInScenario,
} from '@line-crm/db';
import { processStepDeliveries } from './step-delivery.js';

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

describe('T-A2 分岐ジャンプ E2E (実 SQLite)', () => {
  test('metadata_equals 不成立 → next_step_on_false の B ルートが配られ、順次の A ルートは配られない', async () => {
    const scenario = await createScenario(db, { name: '分岐テスト', triggerType: 'manual', deliveryMode: 'relative' });
    // order0: plain / order1: gate metadata_equals(answer=A) → false なら order3 (B) へ /
    // order2: route-A (順次の次・分岐が効けば配られないはず) / order3: route-B (jump 先)
    await createScenarioStep(db, { scenarioId: scenario.id, stepOrder: 0, messageType: 'text', messageContent: 'STEP0-plain' });
    await createScenarioStep(db, {
      scenarioId: scenario.id, stepOrder: 1, messageType: 'text', messageContent: 'STEP1-gate',
      conditionType: 'metadata_equals', conditionValue: JSON.stringify({ key: 'answer', value: 'A' }), nextStepOnFalse: 3,
    });
    await createScenarioStep(db, { scenarioId: scenario.id, stepOrder: 2, messageType: 'text', messageContent: 'STEP2-routeA' });
    await createScenarioStep(db, { scenarioId: scenario.id, stepOrder: 3, messageType: 'text', messageContent: 'STEP3-routeB' });

    // 回答 = "B" → order1 の metadata_equals(answer,"A") は不成立 → 分岐発火。
    seedFriend('f1', { answer: 'B' });
    await enrollFriendInScenario(db, 'f1', scenario.id);

    // 3 tick: t1=order0 配信, t2=order1 で分岐 (無配信), t3=分岐先 order3(B) 配信。
    await runTick();
    await runTick();
    await runTick();

    // GREEN 期待: [0,3] (B ルート)。RED (修正前) は [0,2] (A 誤配信) となり本 assert が落ちる。
    expect(deliveredStepOrders()).toEqual([0, 3]);
    // order2 (A ルート) は配られない。
    expect(deliveredStepOrders()).not.toContain(2);

    const fsRow = raw.prepare(`SELECT status FROM friend_scenarios WHERE friend_id = 'f1'`).get() as { status: string };
    expect(fsRow.status).toBe('completed');
  });

  test('条件成立 (metadata_equals 一致) 時は分岐せず順次配信される', async () => {
    const scenario = await createScenario(db, { name: '条件成立', triggerType: 'manual', deliveryMode: 'relative' });
    await createScenarioStep(db, { scenarioId: scenario.id, stepOrder: 0, messageType: 'text', messageContent: 'STEP0' });
    await createScenarioStep(db, {
      scenarioId: scenario.id, stepOrder: 1, messageType: 'text', messageContent: 'STEP1-gate',
      conditionType: 'metadata_equals', conditionValue: JSON.stringify({ key: 'answer', value: 'A' }), nextStepOnFalse: 3,
    });
    await createScenarioStep(db, { scenarioId: scenario.id, stepOrder: 2, messageType: 'text', messageContent: 'STEP2-routeA' });
    await createScenarioStep(db, { scenarioId: scenario.id, stepOrder: 3, messageType: 'text', messageContent: 'STEP3-routeB' });

    // 回答 = "A" → 条件成立 → order1 も配信され、順次 order2/order3 へ進む (分岐しない)。
    seedFriend('f1', { answer: 'A' });
    await enrollFriendInScenario(db, 'f1', scenario.id);
    for (let i = 0; i < 4; i++) await runTick();

    expect(deliveredStepOrders()).toEqual([0, 1, 2, 3]);
  });

  test('後方 next_step_on_false (loop guard) は無限ループせず順次 skip して完了する', async () => {
    const scenario = await createScenario(db, { name: '後方ジャンプ防御', triggerType: 'manual', deliveryMode: 'relative' });
    await createScenarioStep(db, { scenarioId: scenario.id, stepOrder: 0, messageType: 'text', messageContent: 'STEP0' });
    await createScenarioStep(db, {
      scenarioId: scenario.id, stepOrder: 1, messageType: 'text', messageContent: 'STEP1-gate',
      // next_step_on_false=0 は後方 (0 < 1) = ループ危険。runtime guard が拒否し順次 skip へフォール。
      conditionType: 'metadata_equals', conditionValue: JSON.stringify({ key: 'answer', value: 'A' }), nextStepOnFalse: 0,
    });
    await createScenarioStep(db, { scenarioId: scenario.id, stepOrder: 2, messageType: 'text', messageContent: 'STEP2' });

    seedFriend('f1', { answer: 'B' }); // order1 不成立 → 後方ジャンプ発火を試みる
    await enrollFriendInScenario(db, 'f1', scenario.id);
    // 十分な tick 数を回しても無限ループせず終端する (cursor 単調前進の証明)。
    for (let i = 0; i < 6; i++) await runTick();

    // 後方ジャンプは拒否され、順次 skip で order2 が配られて完了 (order0, order2)。
    expect(deliveredStepOrders()).toEqual([0, 2]);
    const fsRow = raw.prepare(`SELECT status FROM friend_scenarios WHERE friend_id = 'f1'`).get() as { status: string };
    expect(fsRow.status).toBe('completed');
  });
});
