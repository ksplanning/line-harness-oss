/**
 * segment-query の buildSegmentWhere 抽出 + OR 括弧 (HIGH-2) の純関数テスト。
 *
 *   - buildSegmentWhere 断片が buildSegmentQuery の WHERE と一致 (機能等価維持)
 *   - 複数ルール (特に OR) の clause は必ず括弧で包む → account 条件と AND 合成しても
 *     別アカウントの友だちが漏れない (HIGH-2: `acc AND (tagA OR tagB)`)
 *   - 空 rules は '1=1'
 */
import { describe, test, expect } from 'vitest';
import { buildSegmentWhere, buildSegmentQuery } from './segment-query.js';
import type { SegmentCondition } from './segment-query.js';

const OR_TWO: SegmentCondition = {
  operator: 'OR',
  rules: [
    { type: 'tag_exists', value: 'tag-a' },
    { type: 'tag_exists', value: 'tag-b' },
  ],
};

describe('buildSegmentWhere', () => {
  test('single rule clause is not parenthesized and matches buildSegmentQuery WHERE', () => {
    const cond: SegmentCondition = { operator: 'AND', rules: [{ type: 'ref_code', value: 'RC1' }] };
    const { clause, bindings } = buildSegmentWhere(cond);
    expect(clause).toBe('f.ref_code = ?');
    expect(bindings).toEqual(['RC1']);
    expect(buildSegmentQuery(cond).sql).toBe(`SELECT f.id, f.line_user_id FROM friends f WHERE ${clause}`);
    expect(buildSegmentQuery(cond).bindings).toEqual(bindings);
  });

  test('multiple OR rules are wrapped in parentheses (HIGH-2 precedence guard)', () => {
    const { clause, bindings } = buildSegmentWhere(OR_TWO);
    expect(clause.startsWith('(')).toBe(true);
    expect(clause.endsWith(')')).toBe(true);
    expect(clause).toContain(' OR ');
    expect(bindings).toEqual(['tag-a', 'tag-b']);
  });

  test('AND-composing an account scope with an OR segment keeps the OR grouped (no cross-account leak)', () => {
    const { clause } = buildSegmentWhere(OR_TWO);
    // /api/friends / count が account 条件と AND する時の合成形。
    const composed = `f.line_account_id = ? AND ${clause}`;
    // 括弧が無いと `acc AND A OR B` = `(acc AND A) OR B` になり acc-2 の友だちが漏れる。
    expect(composed).toBe(
      'f.line_account_id = ? AND (EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?) OR EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?))',
    );
  });

  test('empty rules produce 1=1', () => {
    const { clause, bindings } = buildSegmentWhere({ operator: 'AND', rules: [] });
    expect(clause).toBe('1=1');
    expect(bindings).toEqual([]);
    expect(buildSegmentQuery({ operator: 'AND', rules: [] }).sql).toBe(
      'SELECT f.id, f.line_user_id FROM friends f WHERE 1=1',
    );
  });

  test('AND multiple rules also wrapped and equal to buildSegmentQuery WHERE', () => {
    const cond: SegmentCondition = {
      operator: 'AND',
      rules: [
        { type: 'is_following', value: true },
        { type: 'ref_code', value: 'RC1' },
      ],
    };
    const { clause } = buildSegmentWhere(cond);
    expect(clause).toBe('(f.is_following = ? AND f.ref_code = ?)');
    expect(buildSegmentQuery(cond).sql).toBe(`SELECT f.id, f.line_user_id FROM friends f WHERE ${clause}`);
  });
});
