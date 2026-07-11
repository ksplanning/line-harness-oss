/**
 * F-2 pull (N-8 / formaloo-pull-wiring) — Formaloo → harness 定義 再取り込みサービス。
 *   fromFormalooField / fromFormalooLogic (shared・無改変) を builder pull 経路に結線する層。
 *   - mapping: 非 subset は drop / slug→id resolve / logic slug 解決
 *   - T-A2 choice_items round-trip zero-loss (choice/dropdown/multiple_select・逆順 position・その他行混入)
 *   - B5: 変換済 field-id 集合に無い rule を除去 (孤立 logic を editor に入れない)
 *   - W2: Formaloo position 昇順に安定ソート / W3: 空 id field は drop
 *   - W1: 候補配列未検出は {ok:false} / 明示的空配列のみ {ok:true, fields:[]}
 *   - fail-soft (N-6): get non-ok / 例外 / formalooSlug 無 は {ok:false} (throw しない)
 */
import { describe, it, expect, vi } from 'vitest';
import { toFormalooFieldPayload, type HarnessField, type HarnessFieldType } from '@line-crm/shared';
import { pullDefinitionFromFormaloo, extractFieldsList, extractLogic } from './formaloo-pull.js';
import type { FormalooClient } from './formaloo-client.js';

/** form-detail JSON body を返す mock client (get のみ)。 */
function mockClient(body: unknown, ok = true, status = 200): FormalooClient {
  return {
    get: vi.fn(async () => (ok ? { ok: true, status, data: body } : { ok: false, status, error: `HTTP ${status}` })),
  } as unknown as FormalooClient;
}
function throwingClient(): FormalooClient {
  return {
    get: vi.fn(async () => {
      throw new Error('network boom');
    }),
  } as unknown as FormalooClient;
}

/** Formaloo `{ data: { form: { fields_list, logic } } }` 形の form-detail body を組む。 */
function detail(fieldsList: unknown[], logic?: unknown): unknown {
  return { data: { form: { slug: 'form_slug', fields_list: fieldsList, logic: logic ?? { rules: [] } } } };
}

/**
 * harness choice field → Formaloo read-shape (push payload の choice_items を土台に
 * slug/わざと逆順の position/is_other_choice 自由記述行を付与)。往復ゼロ落ちの検証入力。
 */
function readShapeChoiceField(
  slug: string,
  harnessType: Extract<HarnessFieldType, 'choice' | 'dropdown' | 'multiple_select'>,
  formalooType: string,
  choices: string[],
): Record<string, unknown> {
  const seed: HarnessField = { id: 'seed', type: harnessType, label: 'L', required: false, position: 0, config: { choices } };
  const payload = toFormalooFieldPayload(seed);
  const pushItems = payload.choice_items as { title: string }[];
  // Formaloo は submit 順に position を採番する想定 → title→position を保ちつつ配列だけ逆順にする
  const items = pushItems.map((it, i) => ({ title: it.title, slug: `${slug}_c${i}`, position: i }));
  const shuffled: Record<string, unknown>[] = [...items].reverse();
  // is_other_choice=true の「その他」自由記述行を途中に混入 (pull で除外されるべき)
  shuffled.splice(1, 0, { title: 'その他', slug: `${slug}_other`, position: 999, is_other_choice: true });
  return { slug, type: formalooType, title: 'L', required: false, position: 0, choice_items: shuffled };
}

describe('pullDefinitionFromFormaloo — mapping (T-A1)', () => {
  it('非 subset は drop / slug→id resolve / logic を解決して {ok:true} を返す', async () => {
    const body = detail(
      [
        { slug: 's_name', type: 'short_text', title: '名前', required: true, position: 0, max_length: 30 },
        { slug: 's_matrix', type: 'matrix', title: '表', required: false, position: 1 }, // 非 subset → drop
        { slug: 's_age', type: 'number', title: '年齢', required: false, position: 2 },
      ],
      { rules: [{ conditions: [{ field: 's_name', operator: 'equals', value: '花子' }], actions: [{ type: 'show', field: 's_age' }] }] },
    );
    const resolve = (s: string) => ({ s_name: 'h_name', s_age: 'h_age' } as Record<string, string>)[s];
    const r = await pullDefinitionFromFormaloo(mockClient(body), { formalooSlug: 'form_slug', resolveId: resolve });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields.map((f) => f.id)).toEqual(['h_name', 'h_age']); // matrix drop / resolve
    expect(r.fields.map((f) => f.type)).toEqual(['text', 'number']);
    expect(r.logic).toHaveLength(1);
    expect(r.logic[0].sourceFieldId).toBe('h_name');
    expect(r.logic[0].targetFieldId).toBe('h_age');
  });

  it('未知 slug は fallback で slug 自身が id になる (resolveId が undefined を返しても落とさない)', async () => {
    const body = detail([{ slug: 's_new', type: 'email', title: 'メール', required: false, position: 0 }]);
    const r = await pullDefinitionFromFormaloo(mockClient(body), { formalooSlug: 'form_slug', resolveId: () => undefined });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields).toHaveLength(1);
    expect(r.fields[0].id).toBe('s_new'); // slug fallback
  });
});

describe('pullDefinitionFromFormaloo — choice_items round-trip zero-loss (T-A2)', () => {
  it.each([
    ['choice', 'choice'],
    ['dropdown', 'dropdown'],
    ['multiple_select', 'multiple_select'],
  ] as const)('%s: push payload → read-shape (逆順+その他行) → pull で choices が完全一致', async (harnessType, formalooType) => {
    const choices = ['犬', '猫', '鳥', 'うさぎ'];
    const field = readShapeChoiceField('s_pet', harnessType, formalooType, choices);
    const r = await pullDefinitionFromFormaloo(mockClient(detail([field])), {
      formalooSlug: 'form_slug',
      resolveId: (s) => (s === 's_pet' ? 'h_pet' : undefined),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields).toHaveLength(1);
    expect(r.fields[0].id).toBe('h_pet');
    expect(r.fields[0].type).toBe(harnessType);
    // position 昇順に復元・is_other_choice=true は除外・データ落ちゼロ
    expect(r.fields[0].config.choices).toEqual(choices);
  });
});

describe('pullDefinitionFromFormaloo — B5 孤立 logic 除去', () => {
  it('drop された非 subset field を参照する rule は返り値 logic に含まれない', async () => {
    const body = detail(
      [
        { slug: 's_a', type: 'short_text', title: 'A', required: false, position: 0 },
        { slug: 's_matrix', type: 'matrix', title: 'M', required: false, position: 1 }, // drop される
      ],
      {
        rules: [
          // s_matrix (drop) を参照 → 孤立 → 除去されるべき
          { conditions: [{ field: 's_a', operator: 'equals', value: 'x' }], actions: [{ type: 'show', field: 's_matrix' }] },
          // 両端とも生存 → 残す
          { conditions: [{ field: 's_a', operator: 'equals', value: 'y' }], actions: [{ type: 'hide', field: 's_a' }] },
        ],
      },
    );
    const r = await pullDefinitionFromFormaloo(mockClient(body), { formalooSlug: 'form_slug', resolveId: (s) => s });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.logic).toHaveLength(1);
    expect(r.logic[0].targetFieldId).toBe('s_a');
    expect(r.logic.some((rule) => rule.targetFieldId === 's_matrix')).toBe(false);
  });
});

describe('pullDefinitionFromFormaloo — W2 position 昇順 / W3 空 id drop', () => {
  it('W2: 入力配列順に依らず Formaloo position 昇順に安定ソート', async () => {
    const body = detail([
      { slug: 's_c', type: 'short_text', title: 'C', required: false, position: 2 },
      { slug: 's_a', type: 'short_text', title: 'A', required: false, position: 0 },
      { slug: 's_b', type: 'short_text', title: 'B', required: false, position: 1 },
    ]);
    const r = await pullDefinitionFromFormaloo(mockClient(body), { formalooSlug: 'form_slug', resolveId: (s) => s });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields.map((f) => f.id)).toEqual(['s_a', 's_b', 's_c']);
  });

  it('W3: slug 欠落 (= 空 id) の field は drop (重複空 id を作らない)', async () => {
    const body = detail([
      { type: 'short_text', title: 'no-slug', required: false, position: 0 }, // slug 無 → id='' → drop
      { slug: 's_ok', type: 'short_text', title: 'ok', required: false, position: 1 },
    ]);
    const r = await pullDefinitionFromFormaloo(mockClient(body), { formalooSlug: 'form_slug', resolveId: (s) => s });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields.map((f) => f.id)).toEqual(['s_ok']);
  });
});

describe('pullDefinitionFromFormaloo — W1 read-shape 判別', () => {
  it('候補配列が全て未検出 (誤 shape) は {ok:false}', async () => {
    const r = await pullDefinitionFromFormaloo(mockClient({ data: { form: { title: 'x' } } }), {
      formalooSlug: 'form_slug',
      resolveId: (s) => s,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/read shape mismatch/);
  });

  it('明示的な空配列 fields_list=[] は {ok:true, fields:[]} (正当な空フォーム)', async () => {
    const r = await pullDefinitionFromFormaloo(mockClient(detail([])), { formalooSlug: 'form_slug', resolveId: (s) => s });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields).toEqual([]);
    expect(r.logic).toEqual([]);
  });
});

describe('pullDefinitionFromFormaloo — fail-soft (N-6)', () => {
  it('formalooSlug が null なら {ok:false} (throw しない)', async () => {
    const r = await pullDefinitionFromFormaloo(mockClient(detail([])), { formalooSlug: null, resolveId: (s) => s });
    expect(r.ok).toBe(false);
  });

  it('client.get が non-ok なら {ok:false} (HTTP ステータス反映)', async () => {
    const r = await pullDefinitionFromFormaloo(mockClient(null, false, 404), { formalooSlug: 'form_slug', resolveId: (s) => s });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/404/);
  });

  it('client.get が throw しても {ok:false} を返す (fail-soft)', async () => {
    const r = await pullDefinitionFromFormaloo(throwingClient(), { formalooSlug: 'form_slug', resolveId: (s) => s });
    expect(r.ok).toBe(false);
  });
});

describe('pullDefinitionFromFormaloo — 複合ロジック弱化検知 warnings (T-A4 / additive)', () => {
  const fields = [
    { slug: 's_a', type: 'short_text', title: 'A', required: false, position: 0 },
    { slug: 's_b', type: 'short_text', title: 'B', required: false, position: 1 },
  ];

  it('複条件 (conditions 2件) rule を含むフォームで warnings を載せる (文言「複合ロジックルール」)', async () => {
    const body = detail(fields, {
      rules: [
        { conditions: [{ field: 's_a', operator: 'equals', value: 'x' }, { field: 's_b', operator: 'equals', value: 'y' }], actions: [{ type: 'show', field: 's_b' }] },
      ],
    });
    const r = await pullDefinitionFromFormaloo(mockClient(body), { formalooSlug: 'form_slug', resolveId: (s) => s });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toBeDefined();
    expect(r.warnings!.length).toBeGreaterThanOrEqual(1);
    expect(r.warnings![0]).toContain('複合ロジックルール');
  });

  it('複アクション (actions 2件) rule も弱化として warnings に含める', async () => {
    const body = detail(fields, {
      rules: [
        { conditions: [{ field: 's_a', operator: 'equals', value: 'x' }], actions: [{ type: 'show', field: 's_a' }, { type: 'hide', field: 's_b' }] },
      ],
    });
    const r = await pullDefinitionFromFormaloo(mockClient(body), { formalooSlug: 'form_slug', resolveId: (s) => s });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings?.[0]).toContain('複合ロジックルール');
  });

  it('弱化無し (単一条件・単一アクションのみ) は warnings 未載 (undefined)', async () => {
    const body = detail(fields, {
      rules: [{ conditions: [{ field: 's_a', operator: 'equals', value: 'x' }], actions: [{ type: 'hide', field: 's_b' }] }],
    });
    const r = await pullDefinitionFromFormaloo(mockClient(body), { formalooSlug: 'form_slug', resolveId: (s) => s });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toBeUndefined();
  });
});

describe('extractFieldsList / extractLogic — 許容的抽出 (候補キー順試行)', () => {
  it('extractFieldsList は複数候補パスを許容的に拾う', () => {
    expect(extractFieldsList({ data: { form: { fields_list: [1] } } })).toEqual([1]);
    expect(extractFieldsList({ data: { fields_list: [2] } })).toEqual([2]);
    expect(extractFieldsList({ fields_list: [3] })).toEqual([3]);
    expect(extractFieldsList({ form: { fields: [4] } })).toEqual([4]);
    expect(extractFieldsList([])).toEqual(null); // 素の配列は候補パスでない → 未検出
    expect(extractFieldsList({ data: { form: {} } })).toEqual(null);
    expect(extractFieldsList(null)).toEqual(null);
  });

  it('extractLogic は rules を持つ object のみ返し、無ければ {rules:[]}', () => {
    expect(extractLogic({ data: { form: { logic: { rules: [{ a: 1 }] } } } })).toEqual({ rules: [{ a: 1 }] });
    expect(extractLogic({ logic: { rules: [] } })).toEqual({ rules: [] });
    expect(extractLogic({ data: { form: {} } })).toEqual({ rules: [] });
  });
});
