import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  executeFormSubmitActions,
  parseFormSubmitActions,
  resolveFormSubmitActions,
} from './form-submit-actions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_PATH = join(__dirname, '../../../../packages/db/bootstrap.sql');

function d1(db: Database.Database): D1Database {
  return {
    prepare(sql: string) {
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
      };
      return api;
    },
  } as unknown as D1Database;
}

let raw: Database.Database;
let DB: D1Database;

beforeEach(() => {
  raw = new Database(':memory:');
  raw.exec(readFileSync(BOOTSTRAP_PATH, 'utf8'));
  raw.pragma('foreign_keys = ON');
  raw.prepare(
    "INSERT INTO friends (id, line_user_id, display_name, metadata) VALUES ('friend-1', 'U1', '田中', '{}')",
  ).run();
  raw.prepare(
    "INSERT INTO tags (id, name, color) VALUES ('tag-a', 'A', '#111111'), ('tag-b', 'B', '#222222')",
  ).run();
  raw.prepare(
    `INSERT INTO friend_field_definitions (id, name, default_value, display_order, is_active)
     VALUES ('field-status', '入金確認', '未', 0, 1)`,
  ).run();
  DB = d1(raw);
});

describe('form submit action validation and legacy compatibility', () => {
  test('accepts the four canonical action shapes in order', () => {
    const input = [
      { type: 'add_tag', tagId: 'tag-a' },
      { type: 'remove_tag', tagId: 'tag-b' },
      { type: 'set_field', fieldId: 'field-status', value: '済' },
      { type: 'clear_field', fieldId: 'field-status' },
    ];

    expect(parseFormSubmitActions(input)).toEqual({ ok: true, actions: input });
  });

  test('rejects unknown, incomplete, or non-array payloads', () => {
    for (const input of [
      {},
      [{ type: 'unknown' }],
      [{ type: 'add_tag', tagId: '' }],
      [{ type: 'set_field', fieldId: 'field-status' }],
    ]) {
      expect(parseFormSubmitActions(input)).toMatchObject({ ok: false });
    }
  });

  test('NULL synthesizes the legacy tag while explicit [] means no actions', () => {
    expect(resolveFormSubmitActions(null, 'legacy-tag')).toEqual([
      { type: 'add_tag', tagId: 'legacy-tag' },
    ]);
    expect(resolveFormSubmitActions('[]', 'legacy-tag')).toEqual([]);
    expect(resolveFormSubmitActions(null, null)).toEqual([]);
  });
});

describe('executeFormSubmitActions', () => {
  test('runs tag and field actions sequentially and is idempotent on replay', async () => {
    const actions = [
      { type: 'add_tag', tagId: 'tag-a' },
      { type: 'remove_tag', tagId: 'tag-a' },
      { type: 'add_tag', tagId: 'tag-b' },
      { type: 'set_field', fieldId: 'field-status', value: '済' },
      { type: 'clear_field', fieldId: 'field-status' },
    ] as const;

    for (let attempt = 0; attempt < 2; attempt++) {
      const outcomes = await executeFormSubmitActions(DB, {
        formId: 'form-1',
        friendId: 'friend-1',
        actions,
      });
      expect(outcomes.map((outcome) => outcome.status))
        .toEqual(['applied', 'applied', 'applied', 'applied', 'applied']);
    }

    expect(raw.prepare(
      "SELECT tag_id FROM friend_tags WHERE friend_id = 'friend-1' ORDER BY tag_id",
    ).all()).toEqual([{ tag_id: 'tag-b' }]);
    expect(JSON.parse(raw.prepare(
      "SELECT metadata FROM friends WHERE id = 'friend-1'",
    ).pluck().get() as string)).toEqual({ 入金確認: '' });
  });

  test('records a failed action and continues with later actions', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const outcomes = await executeFormSubmitActions(DB, {
        formId: 'form-1',
        friendId: 'friend-1',
        actions: [
          { type: 'add_tag', tagId: 'missing-tag' },
          { type: 'set_field', fieldId: 'field-status', value: '後続成功' },
        ],
      });

      expect(outcomes).toMatchObject([
        { index: 0, type: 'add_tag', status: 'failed' },
        { index: 1, type: 'set_field', status: 'applied' },
      ]);
      expect(JSON.parse(raw.prepare(
        "SELECT metadata FROM friends WHERE id = 'friend-1'",
      ).pluck().get() as string)).toMatchObject({ 入金確認: '後続成功' });
      expect(log.mock.calls.map(([line]) => String(line))).toEqual([
        expect.stringContaining('"index":0'),
      ]);
    } finally {
      log.mockRestore();
    }
  });

  test('anonymous submissions skip every action and emit PII-free records only', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const outcomes = await executeFormSubmitActions(DB, {
        formId: 'form-anonymous',
        friendId: null,
        actions: [
          { type: 'add_tag', tagId: 'tag-a' },
          { type: 'clear_field', fieldId: 'field-status' },
        ],
      });

      expect(outcomes).toEqual([
        {
          index: 0,
          type: 'add_tag',
          status: 'skipped',
          reason: 'friend_not_linked',
        },
        {
          index: 1,
          type: 'clear_field',
          status: 'skipped',
          reason: 'friend_not_linked',
        },
      ]);
      expect(raw.prepare('SELECT COUNT(*) AS count FROM friend_tags').get())
        .toEqual({ count: 0 });
      const logs = log.mock.calls.map(([line]) => String(line));
      expect(logs).toHaveLength(2);
      expect(logs.join(' ')).not.toContain('田中');
      expect(logs.join(' ')).not.toContain('U1');
    } finally {
      log.mockRestore();
    }
  });
});
