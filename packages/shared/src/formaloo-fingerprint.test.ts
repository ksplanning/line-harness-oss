/**
 * T-A1 — Formaloo 定義 fingerprint (drift 検知 primary シグナル)。
 *   (a) 変換器読取キー (slug/type/title/required/position/max_length/choice_items 等) の変化 → hash 変化
 *   (b) volatile キー (submit_count/url/作成日時/subset 外 field) の変化 → hash 不変
 *   (c) field 順序入替 → hash 不変 (position/slug ソート)
 *   (d) 弱化発生 (複合 logic 追加) / logic 編集 → hash 変化 (logic 側 drift を検知)
 *   (e) field_map 非依存 = raw Formaloo slug のみを射影 (auto-apply で id が churn しても不変)
 */
import { describe, it, expect } from 'vitest';
import {
  canonicalDefinitionProjection,
  formalooDefinitionFingerprint,
  stableStringify,
} from './formaloo-fingerprint';

/** raw Formaloo field 要素 (form-detail の fields_list 要素 read-shape)。 */
function rawField(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { slug: 'q1', type: 'short_text', title: '氏名', required: false, position: 0, ...over };
}
function rawChoiceField(slug: string, choiceTitles: string[], position = 0): Record<string, unknown> {
  return {
    slug,
    type: 'choice',
    title: '選択',
    required: false,
    position,
    choice_items: choiceTitles.map((title, i) => ({ title, slug: `${slug}_c${i}`, position: i })),
  };
}

async function fp(fields: unknown[], logic: unknown = null): Promise<string> {
  return formalooDefinitionFingerprint(fields, logic);
}

describe('formalooDefinitionFingerprint — (a) 変換器読取キー変化 → hash 変化', () => {
  it('title 変更で hash が変わる', async () => {
    const a = await fp([rawField({ title: '氏名' })]);
    const b = await fp([rawField({ title: 'お名前' })]);
    expect(a).not.toBe(b);
  });
  it('type 変更で hash が変わる', async () => {
    expect(await fp([rawField({ type: 'short_text' })])).not.toBe(await fp([rawField({ type: 'long_text' })]));
  });
  it('required 変更で hash が変わる', async () => {
    expect(await fp([rawField({ required: false })])).not.toBe(await fp([rawField({ required: true })]));
  });
  it('position 変更で hash が変わる', async () => {
    expect(await fp([rawField({ position: 0 })])).not.toBe(await fp([rawField({ position: 3 })]));
  });
  it('max_length 変更で hash が変わる', async () => {
    expect(await fp([rawField({ max_length: 100 })])).not.toBe(await fp([rawField({ max_length: 255 })]));
  });
  it('choice_items の選択肢追加で hash が変わる', async () => {
    const a = await fp([rawChoiceField('q1', ['A', 'B'])]);
    const b = await fp([rawChoiceField('q1', ['A', 'B', 'C'])]);
    expect(a).not.toBe(b);
  });
  it('field 追加で hash が変わる', async () => {
    const a = await fp([rawField({ slug: 'q1' })]);
    const b = await fp([rawField({ slug: 'q1' }), rawField({ slug: 'q2', position: 1 })]);
    expect(a).not.toBe(b);
  });
});

describe('formalooDefinitionFingerprint — (b) volatile キー変化 → hash 不変', () => {
  it('field に submit_count / url / 作成日時 等の非読取キーを足しても hash は不変', async () => {
    const base = await fp([rawField()]);
    const noisy = await fp([
      rawField({ submit_count: 42, some_url: 'https://x', created_at: '2026-07-12', id: 'server-id-xyz' }),
    ]);
    expect(noisy).toBe(base);
  });
  it('subset 外 field (matrix 等) の追加/変更は hash に影響しない (harness に反映されないため)', async () => {
    const base = await fp([rawField()]);
    const withMatrix = await fp([rawField(), { slug: 'm1', type: 'matrix', title: '表', position: 1 }]);
    expect(withMatrix).toBe(base);
    const withMatrixEdited = await fp([rawField(), { slug: 'm1', type: 'matrix', title: '別の表', position: 1 }]);
    expect(withMatrixEdited).toBe(base);
  });
  it('choice の is_other_choice 自由記述行は選択肢に含めない (hash 不変)', async () => {
    const plain = await fp([rawChoiceField('q1', ['A', 'B'])]);
    const withOther = await fp([
      {
        slug: 'q1',
        type: 'choice',
        title: '選択',
        required: false,
        position: 0,
        choice_items: [
          { title: 'A', slug: 'q1_c0', position: 0 },
          { title: 'B', slug: 'q1_c1', position: 1 },
          { title: 'その他', slug: 'q1_other', position: 2, is_other_choice: true },
        ],
      },
    ]);
    expect(withOther).toBe(plain);
  });
});

describe('formalooDefinitionFingerprint — (c) field 順序入替 → hash 不変', () => {
  it('配列順が違っても position が同じなら hash は不変 (position/slug ソート)', async () => {
    const f1 = rawField({ slug: 'q1', position: 0 });
    const f2 = rawField({ slug: 'q2', position: 1 });
    expect(await fp([f1, f2])).toBe(await fp([f2, f1]));
  });
  it('choice_items が逆順でも position が同じなら hash 不変', async () => {
    const forward = await fp([rawChoiceField('q1', ['A', 'B', 'C'])]);
    const reversed = await fp([
      {
        slug: 'q1',
        type: 'choice',
        title: '選択',
        required: false,
        position: 0,
        choice_items: [
          { title: 'C', slug: 'q1_c2', position: 2 },
          { title: 'B', slug: 'q1_c1', position: 1 },
          { title: 'A', slug: 'q1_c0', position: 0 },
        ],
      },
    ]);
    expect(reversed).toBe(forward);
  });
});

describe('formalooDefinitionFingerprint — (d) logic 側 drift 検知', () => {
  const fields = [rawField({ slug: 'q1' }), rawField({ slug: 'q2', position: 1 })];
  it('logic (bare array) を追加すると hash が変わる', async () => {
    const noLogic = await fp(fields, null);
    const withLogic = await fp(fields, [
      { type: 'logic', identifier: 'L1', actions: [{ action: 'show', args: [{ identifier: 'q2' }], when: { operation: 'is', args: [{ type: 'field', value: 'q1' }, { value: 'yes' }] } }] },
    ]);
    expect(withLogic).not.toBe(noLogic);
  });
  it('複合 (compound) logic の条件変更で hash が変わる (弱化発生の検知)', async () => {
    const compoundA = [
      { identifier: 'L1', actions: [{ action: 'show', args: [{ identifier: 'q2' }], when: { operation: 'and', args: [{ operation: 'is', args: [{ type: 'field', value: 'q1' }, { value: 'a' }] }] } }] },
    ];
    const compoundB = [
      { identifier: 'L1', actions: [{ action: 'show', args: [{ identifier: 'q2' }], when: { operation: 'and', args: [{ operation: 'is', args: [{ type: 'field', value: 'q1' }, { value: 'b' }] }] } }] },
    ];
    expect(await fp(fields, compoundA)).not.toBe(await fp(fields, compoundB));
  });
  it('logic bare array の要素キー順が違っても hash は不変 (stableStringify canonical)', async () => {
    const a = [{ identifier: 'L1', type: 'x', actions: [] }];
    const b = [{ type: 'x', actions: [], identifier: 'L1' }];
    expect(await fp(fields, a)).toBe(await fp(fields, b));
  });
  it('legacy synthetic {rules} 形の operator 変更で hash が変わる', async () => {
    const eq = { rules: [{ conditions: [{ field: 'q1', operator: 'equals', value: 'x' }], actions: [{ type: 'show', field: 'q2' }] }] };
    const neq = { rules: [{ conditions: [{ field: 'q1', operator: 'not_equals', value: 'x' }], actions: [{ type: 'show', field: 'q2' }] }] };
    expect(await fp(fields, eq)).not.toBe(await fp(fields, neq));
  });
});

describe('canonicalDefinitionProjection — (e) field_map 非依存 (raw slug のみ)', () => {
  it('射影は raw Formaloo slug をキーに使い harness id を含まない', () => {
    const canon = canonicalDefinitionProjection([rawField({ slug: 'q1' })], null);
    const s = stableStringify(canon);
    expect(s).toContain('q1');
    expect(canon.fields[0].slug).toBe('q1');
    // harness id (fa_* 等) は射影に現れない (field_map churn の影響を受けない)
    expect(s).not.toContain('fa_');
  });
  it('同一定義は決定的に同一 hash (再計算で安定)', async () => {
    const a = await fp([rawChoiceField('q1', ['A', 'B'])], [{ identifier: 'L', actions: [] }]);
    const b = await fp([rawChoiceField('q1', ['A', 'B'])], [{ identifier: 'L', actions: [] }]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
