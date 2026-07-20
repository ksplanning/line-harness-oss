import { describe, expect, test } from 'vitest';
import {
  validateInternalFormAnswers,
  type InternalFormField,
} from './internal-form-runtime.js';

const optionalNumber: InternalFormField = {
  id: 'amount',
  type: 'number',
  label: '金額',
  required: false,
  position: 0,
  config: {},
};

describe('validateInternalFormAnswers number grammar', () => {
  test.each([
    '0x10',
    '0b10',
    '   ',
    'NaN',
    'Infinity',
    '-Infinity',
  ])('rejects non-decimal number input %j', (value) => {
    expect(validateInternalFormAnswers([optionalNumber], { a_0: value })).toEqual({
      ok: false,
      error: '金額 の形式が正しくありません',
    });
  });

  test.each<[string, number]>([
    ['-12', -12],
    ['12.5', 12.5],
    ['.5', 0.5],
    ['-0.25', -0.25],
    ['6.02e23', 6.02e23],
    ['1e+3', 1_000],
    ['-2.5E-3', -0.0025],
  ])('accepts HTML-compatible decimal input %s', (value, expected) => {
    const result = validateInternalFormAnswers([optionalNumber], { a_0: value });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.answers.amount).toBe(expected);
  });

  test.each([
    {},
    { a_0: '' },
  ])('omits an optional empty number instead of coercing it', (input) => {
    const result = validateInternalFormAnswers([optionalNumber], input);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.answers).not.toHaveProperty('amount');
  });
});
