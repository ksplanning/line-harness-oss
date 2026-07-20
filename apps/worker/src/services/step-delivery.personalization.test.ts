import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  createFriendFieldDefinition,
  createScenario,
  createScenarioStep,
  enrollFriendInScenario,
} from '@line-crm/db';
import { processStepDeliveries } from './step-delivery.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_ROOT = join(__dirname, '../../../..', 'packages/db');
const BENIGN_MIGRATION_ERROR = /duplicate column name|already exists/i;
const PAST = '2020-01-01T00:00:00.000+09:00';

function replayAll(db: Database.Database): void {
  db.exec(readFileSync(join(DB_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(join(DB_ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    const statements = readFileSync(join(DB_ROOT, 'migrations', file), 'utf8')
      .split(/;\s*(?:\r?\n|$)/)
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) {
      try {
        db.exec(statement);
      } catch (error) {
        if (!BENIGN_MIGRATION_ERROR.test(error instanceof Error ? error.message : String(error))) throw error;
      }
    }
  }
}

function asD1(db: Database.Database): D1Database {
  const makeStatement = (sql: string) => {
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
      __exec() { return statement.run(...(params as never[])); },
    };
    return api;
  };
  return {
    prepare(sql: string) { return makeStatement(sql); },
    async batch(statements: Array<{ __exec: () => unknown }>) {
      db.transaction(() => statements.map((statement) => statement.__exec()))();
      return statements.map(() => ({ success: true }));
    },
  } as unknown as D1Database;
}

let raw: Database.Database;
let db: D1Database;
let lineClient: { pushMessage: ReturnType<typeof vi.fn> };

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  db = asD1(raw);
  lineClient = { pushMessage: vi.fn(async () => {}) };
});

async function deliverOneStep(messageContent: string, friend: {
  displayName: string | null;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const scenario = await createScenario(db, {
    name: 'personalization',
    triggerType: 'manual',
    deliveryMode: 'relative',
  });
  await createScenarioStep(db, {
    scenarioId: scenario.id,
    stepOrder: 0,
    messageType: 'text',
    messageContent,
  });
  raw.prepare(
    `INSERT INTO friends (id, line_user_id, display_name, is_following, metadata)
     VALUES ('friend-1', 'U-friend-1', ?, 1, ?)`,
  ).run(friend.displayName, JSON.stringify(friend.metadata));
  await enrollFriendInScenario(db, 'friend-1', scenario.id);
  raw.prepare(`UPDATE friend_scenarios SET next_delivery_at = ? WHERE status = 'active'`).run(PAST);

  await processStepDeliveries(
    db,
    lineClient as unknown as Parameters<typeof processStepDeliveries>[1],
    undefined,
  );
}

describe('scenario step personalization payload', () => {
  test('display name, custom field, unknown variable, and Unicode emoji reach LINE payload intact', async () => {
    await createFriendFieldDefinition(db, {
      name: '会員ランク',
      defaultValue: '未登録',
      displayOrder: 0,
      isActive: true,
    });

    await deliverOneStep(
      'こんにちは {{display_name}}さん。ランク: {{field:会員ランク}} 😊 {{unknown}}',
      { displayName: '山田花子', metadata: { 会員ランク: 'ゴールド' } },
    );

    expect(lineClient.pushMessage).toHaveBeenCalledOnce();
    expect(lineClient.pushMessage).toHaveBeenCalledWith('U-friend-1', [{
      type: 'text',
      text: 'こんにちは 山田花子さん。ランク: ゴールド 😊 {{unknown}}',
    }]);
    expect(raw.prepare('SELECT content FROM messages_log').get()).toEqual({
      content: 'こんにちは 山田花子さん。ランク: ゴールド 😊 {{unknown}}',
    });
  });

  test('missing profile values use explicit fallback and active field default', async () => {
    await createFriendFieldDefinition(db, {
      name: '会員ランク',
      defaultValue: '未登録',
      displayOrder: 0,
      isActive: true,
    });
    await createFriendFieldDefinition(db, {
      name: '担当者',
      defaultValue: '',
      displayOrder: 1,
      isActive: true,
    });

    await deliverOneStep(
      '{{display_name|お客様}} / {{field:会員ランク}} / {{field:担当者|未設定}} / {{field:廃止項目}}',
      { displayName: null, metadata: {} },
    );

    expect(lineClient.pushMessage).toHaveBeenCalledWith('U-friend-1', [{
      type: 'text',
      text: 'お客様 / 未登録 / 未設定 / {{field:廃止項目}}',
    }]);
  });
});
