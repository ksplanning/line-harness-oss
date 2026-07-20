import { describe, expect, test } from 'vitest';
import {
  FORMALOO_E1_FIELD_TYPES,
  FORMALOO_TO_HARNESS_TYPE,
  HARNESS_TO_FORMALOO_TYPE,
  fromFormalooField,
  toFormalooFieldPayload,
  validateHarnessField,
  type HarnessField,
} from './formaloo-forms';
import {
  canonicalDefinitionProjection,
  formalooDefinitionFingerprint,
} from './formaloo-fingerprint';

const CONFIRMED_E1_TYPES = ['yes_no', 'time', 'website', 'city'] as const;

const LIVE_READ_BACK = CONFIRMED_E1_TYPES.map((type, position) => ({
  slug: `e1-${type}`,
  type,
  title: `${type} label`,
  description: `${type} help`,
  required: position % 2 === 0,
  position,
  // Batch 0 scratch GET で確認した server defaults。harness が意味を持たない値は
  // pull/re-push/fingerprint から落ち、false-drift を起こしてはならない。
  config: {},
  invisible: false,
  admin_only: false,
  read_only: false,
}));

describe('treasure E1 field parts — live read-back 契約', () => {
  test('hosted 表示まで確認できた4型だけを単一正本にする', () => {
    expect(FORMALOO_E1_FIELD_TYPES).toEqual(CONFIRMED_E1_TYPES);
    expect(FORMALOO_E1_FIELD_TYPES).not.toContain('datetime');
    expect(FORMALOO_E1_FIELD_TYPES).not.toContain('country');
  });

  test.each(CONFIRMED_E1_TYPES)('%s は validate→push→GET read-back→pull を同じ enum で往復する', (type) => {
    const candidate = {
      id: `h-${type}`,
      type,
      label: `${type} label`,
      required: true,
      position: 2,
      config: { description: `${type} help`, ignored: 'drop me' },
    };

    const validated = validateHarnessField(candidate);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.field.config).toEqual({ description: `${type} help` });
    expect(HARNESS_TO_FORMALOO_TYPE[type]).toBe(type);
    expect(FORMALOO_TO_HARNESS_TYPE[type]).toBe(type);

    const payload = toFormalooFieldPayload(validated.field);
    expect(payload).toEqual({
      type,
      title: `${type} label`,
      required: true,
      position: 2,
      description: `${type} help`,
    });

    const readBack = {
      ...payload,
      slug: `remote-${type}`,
      config: {},
      invisible: false,
      admin_only: false,
      read_only: false,
    };
    expect(fromFormalooField(readBack, () => validated.field.id)).toEqual(validated.field);
  });

  test('live GET defaults を含むread-backとpull後のre-pushは同じfingerprintになる', async () => {
    const pulled = LIVE_READ_BACK.map((field) => fromFormalooField(field));
    expect(pulled.every((field): field is HarnessField => field !== null)).toBe(true);

    const repushed = (pulled as HarnessField[]).map((field, index) => ({
      ...toFormalooFieldPayload(field),
      slug: LIVE_READ_BACK[index].slug,
    }));
    expect(canonicalDefinitionProjection(LIVE_READ_BACK, [])).toEqual(
      canonicalDefinitionProjection(repushed, []),
    );
    expect(await formalooDefinitionFingerprint(LIVE_READ_BACK, [])).toBe(
      await formalooDefinitionFingerprint(repushed, []),
    );

    const changed = LIVE_READ_BACK.map((field, index) => (
      index === 0 ? { ...field, title: 'changed title' } : field
    ));
    expect(await formalooDefinitionFingerprint(changed, [])).not.toBe(
      await formalooDefinitionFingerprint(LIVE_READ_BACK, []),
    );
  });
});

describe('treasure E1 field parts — existing form regression', () => {
  const existingReadBack = [
    { slug: 'h_legacy_name', type: 'short_text', title: '氏名', required: true, position: 0, max_length: 50 },
    { slug: 'h_legacy_date', type: 'date', title: '来店日', required: false, position: 1 },
    {
      slug: 'h_legacy_choice',
      type: 'choice',
      title: '希望',
      required: false,
      position: 2,
      choice_items: [
        { title: 'A', slug: 'c1', position: 0 },
        { title: 'B', slug: 'c2', position: 1 },
      ],
    },
  ];

  test('既存フォームのpull JSON byteとfingerprint SHA-256を一切変えない', async () => {
    expect(JSON.stringify(existingReadBack.map((field) => fromFormalooField(field)))).toBe(
      '[{"id":"h_legacy_name","type":"text","label":"氏名","required":true,"position":0,"config":{"maxLength":50}},{"id":"h_legacy_date","type":"date","label":"来店日","required":false,"position":1,"config":{}},{"id":"h_legacy_choice","type":"choice","label":"希望","required":false,"position":2,"config":{"choices":["A","B"],"choiceItems":[{"title":"A","slug":"c1"},{"title":"B","slug":"c2"}]}}]',
    );
    expect(await formalooDefinitionFingerprint(existingReadBack, [])).toBe(
      '491bd87bcf50da3ad2a3701392d12c7f02ac0fa486e0a060ede8d21a6bcda95b',
    );
  });
});
