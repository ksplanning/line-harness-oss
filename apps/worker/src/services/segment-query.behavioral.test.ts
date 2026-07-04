/**
 * T-C4 / D-2 (F2 batch4 G11) — segment-builder の行動 rule (遡及オーディエンス) の純関数テスト。
 *
 *  - clicked_link: link_clicks(friend_id 経由・任意 tracked_link_id・clicked_at 遡及) の EXISTS
 *  - tapped_menu: messages_log postback (source='postback'・NOT delivery_type=Codex CRITICAL・
 *    対象 rich_menu_group の action_data キー集合に content 一致で閉じ Flex postback を拾わない・
 *    line_account_id account-scope は group の account 由来) の EXISTS
 *  - opened_form: form_opens(任意 form_id・opened_at 遡及) の EXISTS
 *  - 期間境界 JST 一貫 (過去N日 / 期間指定)・account scope と AND した時の cross-account 非漏洩
 *  - default:never 網羅性が壊れない (TS 側)
 */
import { describe, test, expect } from 'vitest';
import { buildSegmentWhere } from './segment-query.js';
import type { SegmentCondition } from './segment-query.js';

// 決定論のため固定 now (JST 2026-07-04T12:00:00+09:00 = UTC 2026-07-04T03:00:00Z)。
const NOW = new Date('2026-07-04T03:00:00.000Z');

describe('clicked_link behavioral rule', () => {
  test('any tracked link, past N days → EXISTS on link_clicks with JST threshold', () => {
    const cond: SegmentCondition = { operator: 'AND', rules: [{ type: 'clicked_link', value: { sinceDays: 30 } }] };
    const { clause, bindings } = buildSegmentWhere(cond, { now: NOW });
    expect(clause).toContain('EXISTS (SELECT 1 FROM link_clicks lc WHERE lc.friend_id = f.id');
    expect(clause).toContain('lc.clicked_at >= ?');
    // 30 日前 (JST) = 2026-06-04
    expect(bindings).toEqual(['2026-06-04T00:00:00']);
  });

  test('specific tracked link adds tracked_link_id binding', () => {
    const cond: SegmentCondition = { operator: 'AND', rules: [{ type: 'clicked_link', value: { trackedLinkId: 'tl-1', sinceDays: 7 } }] };
    const { clause, bindings } = buildSegmentWhere(cond, { now: NOW });
    expect(clause).toContain('lc.tracked_link_id = ?');
    expect(bindings).toEqual(['2026-06-27T00:00:00', 'tl-1']);
  });

  test('absolute period (since/until) uses half-open JST interval', () => {
    const cond: SegmentCondition = { operator: 'AND', rules: [{ type: 'clicked_link', value: { since: '2026-06-01', until: '2026-06-30' } }] };
    const { clause, bindings } = buildSegmentWhere(cond, { now: NOW });
    expect(clause).toContain('lc.clicked_at >= ?');
    expect(clause).toContain('lc.clicked_at < ?');
    // until は inclusive → exclusive next-day boundary 2026-07-01
    expect(bindings).toEqual(['2026-06-01T00:00:00', '2026-07-01T00:00:00']);
  });
});

describe('opened_form behavioral rule', () => {
  test('any form → EXISTS on form_opens', () => {
    const cond: SegmentCondition = { operator: 'AND', rules: [{ type: 'opened_form', value: { sinceDays: 14 } }] };
    const { clause, bindings } = buildSegmentWhere(cond, { now: NOW });
    expect(clause).toContain('EXISTS (SELECT 1 FROM form_opens fo WHERE fo.friend_id = f.id');
    expect(clause).toContain('fo.opened_at >= ?');
    expect(bindings).toEqual(['2026-06-20T00:00:00']);
  });

  test('specific form adds form_id binding', () => {
    const cond: SegmentCondition = { operator: 'AND', rules: [{ type: 'opened_form', value: { formId: 'form-9', sinceDays: 14 } }] };
    const { clause, bindings } = buildSegmentWhere(cond, { now: NOW });
    expect(clause).toContain('fo.form_id = ?');
    expect(bindings).toEqual(['2026-06-20T00:00:00', 'form-9']);
  });
});

describe('tapped_menu behavioral rule (Codex CRITICAL/HIGH)', () => {
  test("uses source='postback' (NOT delivery_type) + action_data 照合 + account scope from group", () => {
    const cond: SegmentCondition = { operator: 'AND', rules: [{ type: 'tapped_menu', value: { groupId: 'g-1', sinceDays: 30 } }] };
    const { clause, bindings } = buildSegmentWhere(cond, { now: NOW });
    expect(clause).toContain("ml.source = 'postback'");
    expect(clause).not.toContain("delivery_type = 'postback'"); // Codex CRITICAL: 0 件バグを踏まない
    // account scope は group の account 由来 (別 account の postback を拾わない)
    expect(clause).toContain('ml.line_account_id = (SELECT g.account_id FROM rich_menu_groups g WHERE g.id = ?)');
    // Flex postback を拾わないよう対象 group の action_data キー集合に content を閉じる
    expect(clause).toContain('ml.content IN (');
    expect(clause).toContain('FROM rich_menu_areas rma');
    expect(clause).toContain("rma.action_type IN ('postback','richmenuswitch')");
    // richmenuswitch キー再構成 (rich-menu-analytics と同一式)
    expect(clause).toContain("'switch-to-' || json_extract(rma.action_data, '$.targetPageId')");
    // bindings: [start, groupId(account scope), groupId(area 集合)]
    expect(bindings).toEqual(['2026-06-04T00:00:00', 'g-1', 'g-1']);
  });

  test('missing groupId throws (tapped_menu は対象メニュー必須)', () => {
    const cond: SegmentCondition = { operator: 'AND', rules: [{ type: 'tapped_menu', value: { sinceDays: 30 } as never }] };
    expect(() => buildSegmentWhere(cond, { now: NOW })).toThrow();
  });
});

describe('cross-account non-leak (account scope AND behavioral EXISTS grouping)', () => {
  test('OR of two behavioral rules stays parenthesized so account AND does not leak', () => {
    const cond: SegmentCondition = {
      operator: 'OR',
      rules: [
        { type: 'clicked_link', value: { sinceDays: 30 } },
        { type: 'opened_form', value: { sinceDays: 30 } },
      ],
    };
    const { clause } = buildSegmentWhere(cond, { now: NOW });
    expect(clause.startsWith('(')).toBe(true);
    expect(clause.endsWith(')')).toBe(true);
    const composed = `f.line_account_id = ? AND ${clause}`;
    // 括弧が無いと acc AND clicked OR opened で別 account の opened が漏れる。
    expect(composed).toContain('AND (EXISTS');
  });
});
