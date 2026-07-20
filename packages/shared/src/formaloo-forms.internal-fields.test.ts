import { describe, expect, test } from 'vitest';
import {
  FORMALOO_FIELD_TYPES,
  INTERNAL_ONLY_FIELD_TYPES,
  formalooDefinitionFingerprint,
  isInternalOnlyFieldType,
  toFormalooFieldPayload,
  validateHarnessField,
  type HarnessField,
  type HarnessFieldType,
} from './index';

const EXPECTED_INTERNAL_TYPES = [
  'datetime',
  'country',
  'postal_code',
  'prefecture',
  'address_city',
  'address_street',
  'address_building',
] as const;

// Compile-time guard: every internal-only discriminator must remain part of the
// shared HarnessFieldType even though it is deliberately absent from Formaloo's enum.
const INTERNAL_TYPES_AS_HARNESS_TYPES: readonly HarnessFieldType[] = EXPECTED_INTERNAL_TYPES;

describe('internal-only form field schema', () => {
  test('keeps the exact internal-only enum separate from the Formaloo enum', () => {
    expect(INTERNAL_ONLY_FIELD_TYPES).toEqual(EXPECTED_INTERNAL_TYPES);
    expect(INTERNAL_TYPES_AS_HARNESS_TYPES).toEqual(EXPECTED_INTERNAL_TYPES);
    for (const type of EXPECTED_INTERNAL_TYPES) {
      expect(FORMALOO_FIELD_TYPES).not.toContain(type);
    }
  });

  test('exports a strict internal-only type guard', () => {
    for (const type of EXPECTED_INTERNAL_TYPES) {
      expect(isInternalOnlyFieldType(type)).toBe(true);
    }
    for (const value of ['text', 'section', 'lookup', '', null, 1]) {
      expect(isInternalOnlyFieldType(value)).toBe(false);
    }
  });

  test.each(EXPECTED_INTERNAL_TYPES)('%s is rejected by default and validates only in explicit internal context', (type) => {
    const input = {
      id: `internal-${type}`,
      type,
      label: type,
      required: true,
      position: 0,
      config: {
        placeholder: '入力してください',
        defaultValue: '既定値',
        defaultValues: ['A', 'B'],
        ignored: 'drop me',
      },
    };

    expect(validateHarnessField(input)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/internal-only/),
    });

    const result = validateHarnessField(input, { allowInternalOnly: true });

    expect(result).toEqual({
      ok: true,
      field: {
        id: `internal-${type}`,
        type,
        label: type,
        required: true,
        position: 0,
        config: {
          placeholder: '入力してください',
          defaultValue: '既定値',
          defaultValues: ['A', 'B'],
        },
      },
    });
  });

  test('rejects invalid placeholder and default value config shapes', () => {
    const base = {
      id: 'text',
      type: 'text',
      label: '名前',
      required: false,
      position: 0,
    } as const;

    expect(validateHarnessField({ ...base, config: { placeholder: 123 } }, { allowInternalOnly: true }).ok).toBe(false);
    expect(validateHarnessField({ ...base, config: { defaultValue: ['A'] } }, { allowInternalOnly: true }).ok).toBe(false);
    expect(validateHarnessField({ ...base, config: { defaultValues: ['A', 1] } }, { allowInternalOnly: true }).ok).toBe(false);
  });

  test('keeps the legacy Formaloo validator byte contract by dropping internal config keys', () => {
    const result = validateHarnessField({
      id: 'choice',
      type: 'choice',
      label: '希望',
      required: false,
      position: 0,
      config: {
        choices: ['A', 'B'],
        placeholder: '選んでください',
        defaultValue: 'A',
        defaultValues: ['A'],
      },
    });

    expect(result).toEqual({
      ok: true,
      field: {
        id: 'choice',
        type: 'choice',
        label: '希望',
        required: false,
        position: 0,
        config: { choices: ['A', 'B'] },
      },
    });
  });

  test.each(EXPECTED_INTERNAL_TYPES)('%s fails closed before Formaloo serialization', (type) => {
    const field: HarnessField = {
      id: `internal-${type}`,
      type,
      label: type,
      required: false,
      position: 0,
      config: {},
    };

    expect(() => toFormalooFieldPayload(field)).toThrow(
      `internal-only field type cannot be serialized to Formaloo: ${type}`,
    );
  });

  test('internal config keys never enter an existing Formaloo payload or fingerprint', async () => {
    const legacy: HarnessField = {
      id: 'choice',
      type: 'choice',
      label: '希望',
      required: true,
      position: 0,
      config: { choices: ['A', 'B'] },
    };
    const withInternalConfig: HarnessField = {
      ...legacy,
      config: {
        ...legacy.config,
        placeholder: '選んでください',
        defaultValue: 'A',
        defaultValues: ['A'],
      },
    };

    const legacyPayload = toFormalooFieldPayload(legacy);
    const payload = toFormalooFieldPayload(withInternalConfig);
    expect(payload).toEqual(legacyPayload);
    expect(payload).toEqual({
      type: 'choice',
      title: '希望',
      required: true,
      position: 0,
      choice_items: [{ title: 'A' }, { title: 'B' }],
    });
    expect(payload).not.toHaveProperty('placeholder');
    expect(payload).not.toHaveProperty('defaultValue');
    expect(payload).not.toHaveProperty('defaultValues');

    const legacyRemote = [{ ...legacyPayload, slug: 'choice-slug' }];
    const remote = [{ ...payload, slug: 'choice-slug' }];
    expect(await formalooDefinitionFingerprint(remote, [])).toBe(
      await formalooDefinitionFingerprint(legacyRemote, []),
    );
  });
});
