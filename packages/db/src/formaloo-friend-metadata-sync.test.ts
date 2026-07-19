import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import { upsertFormalooSubmission, type UpsertFormalooSubmissionInput } from './formaloo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const BENIGN = /duplicate column name|already exists/i;

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      let params: unknown[] = [];
      const api = {
        bind(...args: unknown[]) { params = args; return api; },
        async first<T>() { return (statement.get(...(params as never[])) as T) ?? null; },
        async all<T>() { return { results: statement.all(...(params as never[])) as T[] }; },
        async run() { const info = statement.run(...(params as never[])); return { meta: { changes: info.changes } }; },
      };
      return api;
    },
  } as unknown as D1Database;
}

function replayAll(db: Database.Database) {
  db.exec(readFileSync(join(PKG_ROOT, 'schema.sql'), 'utf8'));
  for (const file of readdirSync(join(PKG_ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    for (const sql of readFileSync(join(PKG_ROOT, 'migrations', file), 'utf8').split(/;\s*(?:\r?\n|$)/).map((part) => part.trim()).filter(Boolean)) {
      try { db.exec(sql); } catch (error) { if (!BENIGN.test(error instanceof Error ? error.message : String(error))) throw error; }
    }
  }
}

let raw: Database.Database;
let DB: D1Database;
let preparedStatements: number;

beforeEach(() => {
  raw = new Database(':memory:');
  replayAll(raw);
  preparedStatements = 0;
  const base = d1(raw);
  DB = {
    prepare(sql: string) {
      preparedStatements += 1;
      return base.prepare(sql);
    },
  } as D1Database;
  raw.prepare("INSERT INTO formaloo_forms (id, title, definition_json) VALUES ('form_pay','Pay','{\"fields\":[],\"logic\":[]}')").run();
  raw.prepare("INSERT INTO friends (id, line_user_id, display_name, metadata) VALUES ('frA','U_A','A',?), ('frB','U_B','B',?)")
    .run(JSON.stringify({ 備考: '手動値' }), JSON.stringify({ 入金確認: '別人の値' }));
});

function input(overrides: Partial<UpsertFormalooSubmissionInput> = {}): UpsertFormalooSubmissionInput {
  return {
    id: 'ROW_PAY',
    formId: 'form_pay',
    formalooSlug: 'FORM_PAY',
    friendId: 'frA',
    answersJson: JSON.stringify({ BjEp0J2J: '済' }),
    submittedAt: '2026-07-19T12:00:00+09:00',
    rowSlug: 'ROW_PAY',
    verifiedFriendMetadataSync: {
      friendId: 'frA',
      updates: [{ formalooFieldKey: 'BjEp0J2J', friendMetadataKey: '入金確認', value: '済' }],
    },
    ...overrides,
  };
}

function metadata(friendId: string): Record<string, unknown> {
  const row = raw.prepare('SELECT metadata FROM friends WHERE id=?').get(friendId) as { metadata: string };
  return JSON.parse(row.metadata) as Record<string, unknown>;
}

describe('upsertFormalooSubmission — verified friend metadata sync', () => {
  test('完全一致 friend だけ mapped key を更新し、手動の別キーと由来履歴を保持する', async () => {
    await upsertFormalooSubmission(DB, input());
    expect(metadata('frA')).toMatchObject({
      備考: '手動値',
      入金確認: '済',
      __formaloo_friend_metadata_sync: {
        入金確認: {
          formId: 'form_pay', rowId: 'ROW_PAY', formalooFieldKey: 'BjEp0J2J', value: '済',
        },
      },
    });
    expect(metadata('frB')).toEqual({ 入金確認: '別人の値' });
  });

  test('mapped 値が同じ再 reconcile は friends を UPDATE しない', async () => {
    await upsertFormalooSubmission(DB, input());
    raw.prepare("UPDATE friends SET updated_at='sentinel' WHERE id='frA'").run();
    await upsertFormalooSubmission(DB, input());
    const row = raw.prepare("SELECT updated_at FROM friends WHERE id='frA'").get() as { updated_at: string };
    expect(row.updated_at).toBe('sentinel');
  });

  test('一行の同期は upsert + atomic metadata update の2ステートメント以内', async () => {
    await upsertFormalooSubmission(DB, input());
    expect(preparedStatements).toBeLessThanOrEqual(2);
  });

  test('mapping 対象キーの手動値は次 reconcile で Formaloo 値へ戻し、未 mapping キーは残す', async () => {
    await upsertFormalooSubmission(DB, input());
    const manuallyEdited = metadata('frA');
    manuallyEdited['入金確認'] = '手動で保留';
    manuallyEdited['担当メモ'] = '消さない';
    raw.prepare('UPDATE friends SET metadata=? WHERE id=?').run(JSON.stringify(manuallyEdited), 'frA');
    await upsertFormalooSubmission(DB, input());
    expect(metadata('frA')).toMatchObject({ 入金確認: '済', 備考: '手動値', 担当メモ: '消さない' });
  });

  test('今回の署名検証済み intent が無い input は書かない', async () => {
    await upsertFormalooSubmission(DB, input({ verifiedFriendMetadataSync: undefined }));
    expect(metadata('frA')).toEqual({ 備考: '手動値' });
  });

  test('複数 row が newest-first で来ても、後続の古い row で値を巻き戻さない', async () => {
    await upsertFormalooSubmission(DB, input({
      id: 'ROW_NEW', rowSlug: 'ROW_NEW', submittedAt: '2026-07-19T12:00:00+09:00',
      answersJson: JSON.stringify({ BjEp0J2J: '済' }),
      verifiedFriendMetadataSync: { friendId: 'frA', updates: [{ formalooFieldKey: 'BjEp0J2J', friendMetadataKey: '入金確認', value: '済' }] },
    }));
    await upsertFormalooSubmission(DB, input({
      id: 'ROW_OLD', rowSlug: 'ROW_OLD', submittedAt: '2026-07-18T12:00:00+09:00',
      answersJson: JSON.stringify({ BjEp0J2J: '未' }),
      verifiedFriendMetadataSync: { friendId: 'frA', updates: [{ formalooFieldKey: 'BjEp0J2J', friendMetadataKey: '入金確認', value: '未' }] },
    }));
    expect(metadata('frA')['入金確認']).toBe('済');
  });

  test('同一 submitted_at の row が newest-first で来ても後続 row で巻き戻さない', async () => {
    const submittedAt = '2026-07-19T12:00:00+09:00';
    await upsertFormalooSubmission(DB, input({
      id: 'ROW_NEW', rowSlug: 'ROW_NEW', submittedAt,
      verifiedFriendMetadataSync: { friendId: 'frA', updates: [{ formalooFieldKey: 'BjEp0J2J', friendMetadataKey: '入金確認', value: '済' }] },
    }));
    await upsertFormalooSubmission(DB, input({
      id: 'ROW_OLD', rowSlug: 'ROW_OLD', submittedAt,
      verifiedFriendMetadataSync: { friendId: 'frA', updates: [{ formalooFieldKey: 'BjEp0J2J', friendMetadataKey: '入金確認', value: '未' }] },
    }));
    expect(metadata('frA')['入金確認']).toBe('済');
  });

  test('空文字値は mapped key を clear し、予約/プロトタイプ key は DB でも拒否する', async () => {
    await upsertFormalooSubmission(DB, input());
    await upsertFormalooSubmission(DB, input({
      submittedAt: '2026-07-19T13:00:00+09:00',
      verifiedFriendMetadataSync: {
        friendId: 'frA',
        updates: [
          { formalooFieldKey: 'BjEp0J2J', friendMetadataKey: '入金確認', value: '' },
          { formalooFieldKey: 'evil', friendMetadataKey: '__proto__', value: 'polluted' },
          { formalooFieldKey: 'evil2', friendMetadataKey: '__formaloo_fake', value: 'hidden' },
        ],
      },
    }));
    const current = metadata('frA');
    expect(current['入金確認']).toBe('');
    expect(Object.prototype.hasOwnProperty.call(current, '__proto__')).toBe(false);
    expect(current['__formaloo_fake']).toBeUndefined();
  });

  test('過去の valid friend_id が mirror に残っていても今回 intent 無しなら手動値を触らない', async () => {
    await upsertFormalooSubmission(DB, input());
    const edited = metadata('frA');
    edited['入金確認'] = '手動で保留';
    raw.prepare('UPDATE friends SET metadata=? WHERE id=?').run(JSON.stringify(edited), 'frA');
    await upsertFormalooSubmission(DB, input({ friendId: null, verifiedFriendMetadataSync: undefined }));
    expect(metadata('frA')['入金確認']).toBe('手動で保留');
  });
});
