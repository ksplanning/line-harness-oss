/**
 * T-A3 (scenario-visual-p2-branch slice-1) — 後方互換回帰。
 *
 * 分岐未使用 (condition_type IS NULL) の直列シナリオは、step-delivery.ts:195 の分岐修正の影響を
 * 一切受けず順次配信される (byte 同等) ことを実 SQLite で機械証明する。修正行は
 * `if(condition_type)` → `if(!conditionMet)` → `next_step_on_false != null` の内側 = 分岐宣言時のみ
 * 到達するため、NULL 直列は変更行に触れない (地雷 L2 / spec §2.5)。
 *
 * 日時比較は epoch。文字列辞書比較は禁止 (地雷 D1)。
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

function seedFriend(id: string): void {
  raw.prepare(
    `INSERT INTO friends (id, line_user_id, display_name, is_following, metadata) VALUES (?, ?, ?, 1, '{}')`,
  ).run(id, `u-${id}`, 'テスト友だち');
}
function forceDue(): void {
  raw.prepare(`UPDATE friend_scenarios SET next_delivery_at = ? WHERE status = 'active'`).run(PAST);
}
function deliveredStepOrders(): number[] {
  const rows = raw
    .prepare(
      `SELECT ss.step_order AS step_order FROM messages_log ml
       JOIN scenario_steps ss ON ml.scenario_step_id = ss.id
       WHERE ml.direction = 'outgoing' ORDER BY ml.rowid ASC`,
    )
    .all() as Array<{ step_order: number }>;
  return rows.map((r) => r.step_order);
}
async function runTick(): Promise<void> {
  forceDue();
  await processStepDeliveries(db, lineClient as unknown as Parameters<typeof processStepDeliveries>[1], undefined);
}

describe('T-A3 後方互換 (分岐なし直列は byte 同等)', () => {
  test('condition_type=NULL の直列は order 昇順に配信され、current_step_order が単調前進して完了する', async () => {
    const scenario = await createScenario(db, { name: '直列', triggerType: 'manual', deliveryMode: 'relative' });
    await createScenarioStep(db, { scenarioId: scenario.id, stepOrder: 0, messageType: 'text', messageContent: 'A' });
    await createScenarioStep(db, { scenarioId: scenario.id, stepOrder: 1, messageType: 'text', messageContent: 'B' });
    await createScenarioStep(db, { scenarioId: scenario.id, stepOrder: 2, messageType: 'text', messageContent: 'C' });

    seedFriend('f1');
    await enrollFriendInScenario(db, 'f1', scenario.id);

    // enroll 後 cursor=-1。各 tick で 1 step 配信し cursor が前進する。最終 step (order2) 到達時は
    // completeFriendScenario が status のみ更新し current_step_order は advance しない (既存挙動) ため、
    // 修正前後で同一の cursor 遷移 [0, 1, 1] となる (分岐修正は NULL 直列に一切触れない = byte 同等)。
    const cursorTrail: number[] = [];
    for (let i = 0; i < 3; i++) {
      await runTick();
      const row = raw.prepare(`SELECT current_step_order FROM friend_scenarios WHERE friend_id = 'f1'`).get() as { current_step_order: number };
      cursorTrail.push(row.current_step_order);
    }

    expect(deliveredStepOrders()).toEqual([0, 1, 2]);
    expect(cursorTrail).toEqual([0, 1, 1]);
    const fsRow = raw.prepare(`SELECT status FROM friend_scenarios WHERE friend_id = 'f1'`).get() as { status: string };
    expect(fsRow.status).toBe('completed');
  });
});
