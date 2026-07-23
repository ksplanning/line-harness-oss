import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  createStaffNotificationDestination,
  deleteStaffNotificationDestination,
  getStaffNotificationDestination,
  issueStaffNotificationLineLinkCode,
  linkStaffNotificationLineByCode,
  listStaffNotificationDestinations,
  listSubscribedStaffNotificationDestinations,
  recordStaffNotificationDelivery,
  unlinkStaffNotificationLine,
  updateStaffNotificationDestination,
} from './staff-notifications.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const BENIGN = /duplicate column name|already exists/i;

function replayAll(db: Database.Database): void {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(join(PKG_ROOT, 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    const sql = readFileSync(join(PKG_ROOT, 'migrations', file), 'utf8');
    for (const statement of sql
      .split(/;\s*(?:\r?\n|$)/)
      .map((part) => part.trim())
      .filter(Boolean)) {
      try {
        db.exec(statement);
      } catch (error) {
        if (!BENIGN.test(error instanceof Error ? error.message : String(error))) {
          throw error;
        }
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
        bind(...args: unknown[]) {
          params = args;
          return api;
        },
        async first<T>() {
          return (statement.get(...(params as never[])) as T) ?? null;
        },
        async all<T>() {
          return { results: statement.all(...(params as never[])) as T[] };
        },
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
let DB: D1Database;

beforeEach(() => {
  raw = new Database(':memory:');
  raw.pragma('foreign_keys = ON');
  replayAll(raw);
  raw.prepare(
    `INSERT INTO line_accounts
       (id, channel_id, name, channel_access_token, channel_secret)
     VALUES ('account-1', 'channel-1', 'Account 1', 'token', 'secret')`,
  ).run();
  raw.prepare(
    `INSERT INTO friends
       (id, line_user_id, display_name, is_following, line_account_id, metadata)
     VALUES ('friend-1', 'U-customer', '兼任スタッフ', 1, 'account-1', '{"plan":"gold"}')`,
  ).run();
  raw.prepare(
    `INSERT INTO scenarios (id, name, trigger_type)
     VALUES ('scenario-1', '顧客シナリオ', 'manual')`,
  ).run();
  raw.prepare(
    `INSERT INTO friend_scenarios
       (id, friend_id, scenario_id, current_step_order, status, next_delivery_at)
     VALUES ('friend-scenario-1', 'friend-1', 'scenario-1', 2, 'active',
             '2099-01-02T10:00:00.000+09:00')`,
  ).run();
  DB = d1(raw);
});

afterEach(() => {
  raw.close();
});

describe('staff notification destination persistence', () => {
  test('creates, reloads, updates, filters, and deletes a destination round-trip', async () => {
    const created = await createStaffNotificationDestination(DB, {
      id: 'destination-1',
      lineAccountId: 'account-1',
      label: 'Chatwork 受付',
      channelType: 'chatwork',
      config: { apiToken: 'stored-secret', roomId: '12345' },
      notifyInquiry: true,
      notifyFormSubmission: false,
      notifyAutoReply: false,
      enabled: true,
    });

    expect(created.notifyAutoReply).toBe(false);
    expect(await getStaffNotificationDestination(DB, 'account-1', created.id)).toEqual(created);
    expect(await listStaffNotificationDestinations(DB, 'account-1')).toEqual([created]);
    expect(await listSubscribedStaffNotificationDestinations(
      DB,
      'account-1',
      'inquiry_received',
    )).toEqual([created]);
    expect(await listSubscribedStaffNotificationDestinations(
      DB,
      'account-1',
      'form_submitted',
    )).toEqual([]);

    const updated = await updateStaffNotificationDestination(DB, {
      id: created.id,
      lineAccountId: 'account-1',
      label: '申込み担当',
      channelType: 'chatwork',
      config: { apiToken: 'rotated-secret', roomId: '98765' },
      notifyInquiry: false,
      notifyFormSubmission: true,
      notifyAutoReply: true,
      enabled: false,
    });
    expect(updated).toMatchObject({
      label: '申込み担当',
      config: { apiToken: 'rotated-secret', roomId: '98765' },
      notifyInquiry: false,
      notifyFormSubmission: true,
      notifyAutoReply: true,
      enabled: false,
    });
    expect(await getStaffNotificationDestination(DB, 'account-1', created.id)).toEqual(updated);
    expect(await listSubscribedStaffNotificationDestinations(
      DB,
      'account-1',
      'form_submitted',
    )).toEqual([]);

    expect(await deleteStaffNotificationDestination(DB, 'account-1', created.id)).toBe(true);
    expect(await getStaffNotificationDestination(DB, 'account-1', created.id)).toBeNull();
  });

  test('LINE link and unlink only change destination config and leave every friends byte unchanged', async () => {
    const destination = await createStaffNotificationDestination(DB, {
      id: 'destination-line',
      lineAccountId: 'account-1',
      label: 'LINE 受付',
      channelType: 'line',
      config: {},
      notifyInquiry: true,
      notifyFormSubmission: true,
      notifyAutoReply: false,
      enabled: true,
    });
    const friendsBefore = raw.prepare('SELECT * FROM friends ORDER BY id').all();
    const scenariosBefore = raw.prepare(
      'SELECT * FROM friend_scenarios ORDER BY id',
    ).all();

    const issued = await issueStaffNotificationLineLinkCode(DB, {
      id: destination.id,
      lineAccountId: 'account-1',
      codeDigest: 'digest-abcd2345',
      expiresAt: '2099-01-01T00:10:00.000+09:00',
    });
    expect(issued).toMatchObject({
      lineLinkCodeDigest: 'digest-abcd2345',
      lineLinkCodeExpiresAt: '2099-01-01T00:10:00.000+09:00',
    });

    const linked = await linkStaffNotificationLineByCode(DB, {
      lineAccountId: 'account-1',
      codeDigest: 'digest-abcd2345',
      lineUserId: 'U-customer',
      now: '2099-01-01T00:00:00.000+09:00',
    });
    expect(linked?.id).toBe(destination.id);
    expect(linked).toMatchObject({
      lineUserId: 'U-customer',
      lineLinkCodeDigest: null,
      lineLinkCodeExpiresAt: null,
    });
    expect(raw.prepare('SELECT * FROM friends ORDER BY id').all()).toEqual(friendsBefore);
    expect(raw.prepare('SELECT * FROM friend_scenarios ORDER BY id').all()).toEqual(
      scenariosBefore,
    );

    const unlinked = await unlinkStaffNotificationLine(DB, 'account-1', destination.id);
    expect(unlinked?.lineUserId).toBeNull();
    expect(raw.prepare('SELECT * FROM friends ORDER BY id').all()).toEqual(friendsBefore);
    expect(raw.prepare('SELECT * FROM friend_scenarios ORDER BY id').all()).toEqual(
      scenariosBefore,
    );
  });

  test('derives each delivery-log account from its destination row', async () => {
    await createStaffNotificationDestination(DB, {
      id: 'destination-log',
      lineAccountId: 'account-1',
      label: 'ログ対象',
      channelType: 'chatwork',
      config: { apiToken: 'secret', roomId: '12345' },
      notifyInquiry: true,
      notifyFormSubmission: true,
      notifyAutoReply: false,
      enabled: true,
    });

    await recordStaffNotificationDelivery(DB, {
      id: 'delivery-1',
      destinationId: 'destination-log',
      eventType: 'inquiry_received',
      status: 'failed',
      errorCode: 'chatwork_http_error',
    });

    expect(raw.prepare(
      `SELECT destination_id, line_account_id, event_type, status, error_code
         FROM staff_notification_delivery_logs
        WHERE id = 'delivery-1'`,
    ).get()).toEqual({
      destination_id: 'destination-log',
      line_account_id: 'account-1',
      event_type: 'inquiry_received',
      status: 'failed',
      error_code: 'chatwork_http_error',
    });

    await expect(recordStaffNotificationDelivery(DB, {
      id: 'delivery-missing',
      destinationId: 'missing-destination',
      eventType: 'inquiry_received',
      status: 'failed',
      errorCode: 'unsupported_channel',
    })).rejects.toThrow('Staff notification delivery was not recorded');
  });
});
