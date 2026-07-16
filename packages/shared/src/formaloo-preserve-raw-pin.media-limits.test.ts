/**
 * form-media-limits (R-1) — preserve-raw / logic 系関数の byte 無改変 pin。
 *   ① (field payload: maxSizeKb) / ③ (form 層: allow_post_edit) の追加が logic/preserve 経路に
 *   一切触れていないことを golden byte で pin する (RK-3)。これらの関数の git diff は空 (HEAD 比一致) —
 *   本 pin は将来の accidental 改変を検知する durable guard。既存 preserve round-trip 契約は
 *   formaloo-logic-preserve.test.ts が担保 (本 pin と併走 = R-1 の両輪)。
 */
import { describe, it, expect } from 'vitest';
import { logicFingerprint, serializeRawLogicForPush, type HarnessLogicRule } from './formaloo-forms';

const rules: HarnessLogicRule[] = [
  { id: 'r1', sourceFieldId: 'q1', operator: 'equals', value: 'A', action: 'show', targetFieldId: 'q2' },
  { id: 'r2', sourceFieldId: 'q1', operator: 'not_equals', value: 'B', action: 'jump', targetFieldId: 'p2' },
];
const raw = [{ identifier: 'L1', title: 't', actions: [{ type: 'show', field: 'q2' }] }];

describe('form-media-limits R-1 — preserve-raw / logic byte pin', () => {
  it('logicFingerprint は golden byte で不変 (① field-config 追加後も perturbation 無し)', () => {
    expect(logicFingerprint(rules)).toMatchInlineSnapshot(`"[{"action":"show","id":"r1","operator":"equals","sourceFieldId":"q1","targetFieldId":"q2","value":"A"},{"action":"jump","id":"r2","operator":"not_equals","sourceFieldId":"q1","targetFieldId":"p2","value":"B"}]"`);
  });

  it('serializeRawLogicForPush は raw 配列を無変換で返す (byte 保持)', () => {
    expect(serializeRawLogicForPush(raw)).toMatchInlineSnapshot(`
      [
        {
          "actions": [
            {
              "field": "q2",
              "type": "show",
            },
          ],
          "identifier": "L1",
          "title": "t",
        },
      ]
    `);
    // 非配列は preserve 不成立 = null
    expect(serializeRawLogicForPush(null)).toBeNull();
    expect(serializeRawLogicForPush({ rules: [] })).toBeNull();
  });

  it('決定的: 同一入力は同一 fingerprint (再計算安定)', () => {
    expect(logicFingerprint(rules)).toBe(logicFingerprint(rules));
  });
});
