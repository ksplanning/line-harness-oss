import { describe, expect, test } from 'vitest';
import * as shared from './index';

describe('extractGoogleSpreadsheetId', () => {
  test('extracts the id from the supported Google Sheets sharing URL forms', () => {
    const extract = (shared as typeof shared & {
      extractGoogleSpreadsheetId?: (value: string) => string | null;
    }).extractGoogleSpreadsheetId;

    expect(extract).toBeTypeOf('function');
    if (!extract) return;

    const id = '1AbCd_ef-GhIj-KlMn';
    expect(extract(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`)).toBe(id);
    expect(extract(`https://docs.google.com/spreadsheets/d/${id}/view?usp=sharing`)).toBe(id);
    expect(extract(`https://docs.google.com/spreadsheets/u/0/d/${id}/edit?gid=42#gid=42`)).toBe(id);
    expect(extract(`https://docs.google.com/spreadsheets/d/${id}`)).toBe(id);
  });

  test.each([
    '',
    '1AbCd_ef-GhIj-KlMn',
    'https://example.com/spreadsheets/d/1AbCd_ef-GhIj-KlMn/edit',
    'https://docs.google.com.evil.example/spreadsheets/d/1AbCd_ef-GhIj-KlMn/edit',
    'http://docs.google.com/spreadsheets/d/1AbCd_ef-GhIj-KlMn/edit',
    'https://docs.google.com/spreadsheets/d/e/2PACX-published/pubhtml',
  ])('rejects a non-editable sharing URL: %s', (value) => {
    const extract = (shared as typeof shared & {
      extractGoogleSpreadsheetId?: (input: string) => string | null;
    }).extractGoogleSpreadsheetId;

    expect(extract).toBeTypeOf('function');
    if (extract) expect(extract(value)).toBeNull();
  });
});
