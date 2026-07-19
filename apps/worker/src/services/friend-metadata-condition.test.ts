import Database from 'better-sqlite3';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  buildEffectiveFriendMetadataExpression,
  buildFriendMetadataPredicate,
} from './friend-metadata-condition.js';
import { buildSegmentQuery, buildSegmentWhere } from './segment-query.js';

type QueryOutcome =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE friends (
      id TEXT PRIMARY KEY,
      line_user_id TEXT,
      metadata TEXT
    );
    CREATE TABLE friend_field_definitions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      default_value TEXT NOT NULL DEFAULT '',
      display_order INTEGER NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX idx_friend_field_definitions_name
      ON friend_field_definitions (name);
  `);
});

function insertFriend(id: string, metadata: string | null): void {
  db.prepare('INSERT INTO friends (id, metadata) VALUES (?, ?)').run(id, metadata);
}

function expressionOutcome(
  sql: string,
  bindings: readonly unknown[],
  friendId: string,
): QueryOutcome {
  try {
    const row = db
      .prepare(`SELECT ${sql} AS value FROM friends f WHERE f.id = ?`)
      .get(...([...bindings, friendId] as never[])) as { value: unknown };
    return { ok: true, value: row.value };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function predicateIds(
  type: 'metadata_equals' | 'metadata_not_equals',
  key: string,
  value: string,
): string[] {
  const { clause, bindings } = buildSegmentWhere({
    operator: 'AND',
    rules: [{ type, value: { key, value } }],
  });
  return (
    db.prepare(`SELECT f.id FROM friends f WHERE ${clause} ORDER BY f.id`)
      .all(...(bindings as never[])) as Array<{ id: string }>
  ).map((row) => row.id);
}

describe('effective friend metadata SQL — field-definition defaults', () => {
  test('active definition supplies its default only when a valid object is missing the key', () => {
    db.prepare(
      `INSERT INTO friend_field_definitions (id, name, default_value, is_active)
       VALUES ('def-1', '入金確認', '未', 1)`,
    ).run();
    insertFriend('empty', JSON.stringify({ 入金確認: '' }));
    insertFriend('explicit-null', JSON.stringify({ 入金確認: null }));
    insertFriend('missing', '{}');
    insertFriend('override', JSON.stringify({ 入金確認: '済' }));
    insertFriend('sql-null', null);
    insertFriend('top-level-array', '[]');

    expect(predicateIds('metadata_equals', '入金確認', '未')).toEqual(['missing']);
    expect(predicateIds('metadata_equals', '入金確認', '')).toEqual(['empty']);
    expect(predicateIds('metadata_not_equals', '入金確認', '未')).toEqual([
      'empty',
      'explicit-null',
      'override',
      'sql-null',
      'top-level-array',
    ]);
  });

  test('inactive or zero definitions keep missing-key legacy behavior', () => {
    insertFriend('missing', '{}');
    expect(predicateIds('metadata_equals', '入金確認', '未')).toEqual([]);
    expect(predicateIds('metadata_not_equals', '入金確認', '未')).toEqual(['missing']);

    db.prepare(
      `INSERT INTO friend_field_definitions (id, name, default_value, is_active)
       VALUES ('def-inactive', '入金確認', '未', 0)`,
    ).run();
    expect(predicateIds('metadata_equals', '入金確認', '未')).toEqual([]);
    expect(predicateIds('metadata_not_equals', '入金確認', '未')).toEqual(['missing']);
  });
});

describe('R1 F-1 — json_each conversion preserves legacy edge behavior', () => {
  const key = 'status';
  const legacySql = `json_extract(f.metadata, '$.status')`;

  test('with zero definitions, valid, NULL, non-object, and malformed rows match legacy outcomes', () => {
    const fixtures: Array<[string, string | null]> = [
      ['object-value', '{"status":"済"}'],
      ['object-number', '{"status":1}'],
      ['object-boolean', '{"status":true}'],
      ['object-array', '{"status":[1,2]}'],
      ['object-nested', '{"status":{"code":1}}'],
      ['object-null', '{"status":null}'],
      ['object-missing', '{}'],
      ['sql-null', null],
      ['array', '[]'],
      ['string', '"scalar"'],
      ['json-null', 'null'],
      ['number', '42'],
      ['malformed', '{not json'],
    ];
    for (const [id, metadata] of fixtures) insertFriend(id, metadata);

    const effective = buildEffectiveFriendMetadataExpression(key);
    const effectiveNotEquals = buildFriendMetadataPredicate(key, '済', 'not_equals');
    for (const [id] of fixtures) {
      const before = expressionOutcome(legacySql, [], id);
      const after = expressionOutcome(effective.sql, effective.bindings, id);
      if (!before.ok) {
        expect(after, id).toMatchObject({ ok: false });
        expect(before.message, id).toMatch(/malformed JSON/i);
        expect((after as { ok: false; message: string }).message, id).toMatch(/malformed JSON/i);
      } else {
        expect(after, id).toEqual(before);
      }

      const beforeNotEquals = expressionOutcome(
        `(${legacySql} IS NULL OR ${legacySql} != ?)`,
        ['済'],
        id,
      );
      const afterNotEquals = expressionOutcome(
        effectiveNotEquals.sql,
        effectiveNotEquals.bindings,
        id,
      );
      expect(afterNotEquals.ok, `${id} not-equals error parity`).toBe(beforeNotEquals.ok);
      if (beforeNotEquals.ok) expect(afterNotEquals, `${id} not-equals value parity`).toEqual(beforeNotEquals);
    }
  });

  test('with an active definition, SQL NULL, malformed JSON, and every non-object stay legacy-equivalent', () => {
    db.prepare(
      `INSERT INTO friend_field_definitions (id, name, default_value, is_active)
       VALUES ('def-status', 'status', '未', 1)`,
    ).run();
    const fixtures: Array<[string, string | null]> = [
      ['sql-null', null],
      ['array', '[]'],
      ['string', '"scalar"'],
      ['json-null', 'null'],
      ['number', '42'],
      ['malformed', '{not json'],
    ];
    for (const [id, metadata] of fixtures) insertFriend(id, metadata);

    const effective = buildEffectiveFriendMetadataExpression(key);
    for (const [id] of fixtures) {
      const before = expressionOutcome(legacySql, [], id);
      const after = expressionOutcome(effective.sql, effective.bindings, id);
      if (!before.ok) {
        expect(after, id).toMatchObject({ ok: false });
      } else {
        expect(after, id).toEqual(before);
      }
    }
  });
});

describe('R1 F-3 — metadata predicate cost is structurally bounded', () => {
  test('one rule has one correlated json_each scan and indexed definition lookups', () => {
    const predicate = buildFriendMetadataPredicate('status', '未', 'equals');
    expect(predicate.sql.match(/json_each/g)).toHaveLength(1);

    const query = buildSegmentQuery({
      operator: 'AND',
      rules: [{ type: 'metadata_equals', value: { key: 'status', value: '未' } }],
    });
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${query.sql}`)
      .all(...(query.bindings as never[])) as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail);

    expect(details.filter((detail) => /SCAN j VIRTUAL TABLE/i.test(detail))).toHaveLength(1);
    expect(details.some((detail) => /idx_friend_field_definitions_name/i.test(detail))).toBe(true);
    expect(details.some((detail) => /SCAN (?:TABLE )?friend_field_definitions/i.test(detail))).toBe(false);
  });
});
