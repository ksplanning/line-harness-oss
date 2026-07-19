import { describe, expect, test } from 'vitest';
import {
  canonicalDefinitionProjection,
  formalooDefinitionFingerprint,
  stableStringify,
} from './formaloo-fingerprint';

describe('dynamic field fingerprint projection', () => {
  test('projects variable formula semantics and choice_fetch source additively', () => {
    expect(canonicalDefinitionProjection([
      {
        slug: 'TOTAL', type: 'variable', title: '合計', position: 2, sub_type: 'formula',
        config: { formula: '{PRICE}*{QTY}' }, decimal_places: 2,
      },
      {
        slug: 'STORE', type: 'choice_fetch', title: '店舗', required: true, position: 3,
        choices_source: 'https://api.example.test/formaloo/choices/f/l',
      },
    ], []).fields).toEqual([
      {
        slug: 'TOTAL', type: 'variable', title: '合計', required: false, position: 2,
        subType: 'formula', formula: '{PRICE}*{QTY}', decimalPlaces: 2,
      },
      {
        slug: 'STORE', type: 'choice_fetch', title: '店舗', required: true, position: 3,
        choicesSource: 'https://api.example.test/formaloo/choices/f/l',
      },
    ]);
  });

  test('plain variable defaults do not add formula or decimal keys', () => {
    const field = canonicalDefinitionProjection([
      { slug: 'V', type: 'variable', title: '値', position: 0, sub_type: 'int', config: {} },
    ], []).fields[0] as unknown as Record<string, unknown>;
    expect(field).toEqual({ slug: 'V', type: 'variable', title: '値', required: false, position: 0, subType: 'int' });
    expect(field).not.toHaveProperty('formula');
    expect(field).not.toHaveProperty('decimalPlaces');
  });

  test('drops dynamic fields whose required remote key is unset or invalid, matching pull', () => {
    expect(canonicalDefinitionProjection([
      { slug: 'V1', type: 'variable', title: '未設定', position: 0, config: {} },
      { slug: 'V2', type: 'variable', title: '不正', position: 1, sub_type: 'number', config: {} },
      { slug: 'C1', type: 'choice_fetch', title: '未設定', position: 2 },
      { slug: 'C2', type: 'choice_fetch', title: '空', position: 3, choices_source: '' },
    ], []).fields).toEqual([]);
  });

  test('formula/source changes alter the fingerprint', async () => {
    const variable = (formula: string) => ({
      slug: 'TOTAL', type: 'variable', title: '合計', position: 0, sub_type: 'formula', config: { formula },
    });
    const choices = (source: string) => ({
      slug: 'STORE', type: 'choice_fetch', title: '店舗', position: 1, choices_source: source,
    });
    expect(await formalooDefinitionFingerprint([variable('{A}+1')], [])).not.toBe(
      await formalooDefinitionFingerprint([variable('{A}+2')], []),
    );
    expect(await formalooDefinitionFingerprint([choices('https://a.test/x')], [])).not.toBe(
      await formalooDefinitionFingerprint([choices('https://b.test/x')], []),
    );
  });

  test('legacy field projection stays byte-identical when dynamic keys are absent', () => {
    const projection = canonicalDefinitionProjection([
      { slug: 'NAME', type: 'short_text', title: '名前', required: true, position: 0, max_length: 30 },
    ], []);
    expect(stableStringify(projection)).toBe(
      '{"fields":[{"max_length":30,"position":0,"required":true,"slug":"NAME","title":"名前","type":"short_text"}],"logic":[]}',
    );
  });
});
