import { describe, expect, test } from 'vitest';
import {
  fromFormalooField,
  toFormalooFieldPayload,
  validateHarnessField,
  type HarnessField,
} from './formaloo-forms';

function validate(input: unknown): HarnessField {
  const result = validateHarnessField(input);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  return result.field;
}

describe('variable field measured contract', () => {
  test.each(['int', 'string', 'decimal'] as const)('plain %s emits required sub_type and empty config', (subType) => {
    const field = validate({
      id: `v_${subType}`,
      type: 'variable',
      label: '計算用の値',
      required: true,
      position: 2,
      config: { variableSubType: subType },
    });

    expect(toFormalooFieldPayload(field)).toEqual({
      type: 'variable',
      title: '計算用の値',
      position: 2,
      sub_type: subType,
      config: {},
    });
    expect(field.required).toBe(false);
  });

  test('formula emits config.formula and decimal_places in the measured shape', () => {
    const field = validate({
      id: 'v_total',
      type: 'variable',
      label: '合計',
      required: false,
      position: 3,
      config: {
        variableSubType: 'formula',
        formula: '{price}*{quantity}',
        decimalPlaces: 2,
      },
    });

    expect(toFormalooFieldPayload(field)).toEqual({
      type: 'variable',
      title: '合計',
      position: 3,
      sub_type: 'formula',
      config: { formula: '{price}*{quantity}' },
      decimal_places: 2,
    });
  });

  test('formula references translate harness ids to Formaloo slugs on push', () => {
    const field = validate({
      id: 'v_total', type: 'variable', label: '合計', required: false, position: 2,
      config: { variableSubType: 'formula', formula: '{price}*{quantity}' },
    });
    const slugs: Record<string, string> = { price: 'FIELD_PRICE', quantity: 'FIELD_QTY' };

    expect(toFormalooFieldPayload(field, (id) => slugs[id])).toMatchObject({
      config: { formula: '{FIELD_PRICE}*{FIELD_QTY}' },
    });
  });

  test('pull maps Formaloo formula slugs back to harness ids for round-trip symmetry', () => {
    const ids: Record<string, string> = { FIELD_PRICE: 'price', FIELD_QTY: 'quantity', TOTAL: 'total' };
    expect(fromFormalooField({
      slug: 'TOTAL',
      type: 'variable',
      title: '合計',
      position: 3,
      sub_type: 'formula',
      config: { formula: '{FIELD_PRICE}*{FIELD_QTY}' },
      decimal_places: 2,
    }, (slug) => ids[slug])).toEqual({
      id: 'total',
      type: 'variable',
      label: '合計',
      required: false,
      position: 3,
      config: {
        variableSubType: 'formula',
        formula: '{price}*{quantity}',
        decimalPlaces: 2,
      },
    });
  });

  test('rejects unsupported/missing sub_type and formula without an expression', () => {
    for (const config of [
      {},
      { variableSubType: 'number' },
      { variableSubType: 'formula', formula: '' },
    ]) {
      expect(validateHarnessField({ id: 'v', type: 'variable', label: '値', position: 0, config }).ok).toBe(false);
    }
  });
});

describe('choice_fetch field measured contract', () => {
  test('push/pull preserves choices_source and the local preview snapshot', () => {
    const source = 'https://api.example.test/formaloo/choices/form_1/list_1';
    const field = validate({
      id: 'dynamic_store',
      type: 'choice_fetch',
      label: '店舗',
      required: true,
      position: 1,
      config: {
        choicesSource: source,
        choiceListId: 'list_1',
        choiceFetchItems: [{ label: '渋谷店', value: 'shibuya' }],
        description: '予約する店舗を選んでください',
      },
    });

    expect(toFormalooFieldPayload(field)).toEqual({
      type: 'choice_fetch',
      title: '店舗',
      required: true,
      position: 1,
      choices_source: source,
      description: '予約する店舗を選んでください',
    });
    expect(fromFormalooField({
      slug: 'STORE', type: 'choice_fetch', title: '店舗', required: true, position: 1, choices_source: source,
      description: '予約する店舗を選んでください',
    }, () => 'dynamic_store')).toEqual({
      id: 'dynamic_store',
      type: 'choice_fetch',
      label: '店舗',
      required: true,
      position: 1,
      config: { choicesSource: source, description: '予約する店舗を選んでください' },
    });
  });

  test('rejects a missing or non-http choices_source', () => {
    for (const choicesSource of ['', 'javascript:alert(1)']) {
      expect(validateHarnessField({
        id: 'dynamic', type: 'choice_fetch', label: '動的選択肢', position: 0, config: { choicesSource },
      }).ok).toBe(false);
    }
  });

  test('normalizes choices_source before storing and emitting the validated URL', () => {
    const field = validate({
      id: 'dynamic', type: 'choice_fetch', label: '動的選択肢', position: 0,
      config: { choicesSource: '  https://worker.example.test/formaloo/choices/f/l  ' },
    });
    expect(field.config.choicesSource).toBe('https://worker.example.test/formaloo/choices/f/l');
    expect(toFormalooFieldPayload(field)).toMatchObject({
      choices_source: 'https://worker.example.test/formaloo/choices/f/l',
    });
  });
});
