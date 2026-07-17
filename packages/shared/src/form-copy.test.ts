/**
 * form-jp-localization — FormCopy 契約 + normalizeFormCopy の whitelist / trim / 空欄 drop を封鎖。
 *  - owner が個別指定できる 3 文言 (送信ボタン/完了/送信エラー) の canonical 型と Formaloo 直キー写像。
 *  - MVP set/absent 意味論: 空欄 (trim 後 '') は drop = 「未指定=触らない」で既存文言を誤消去しない。
 */
import { describe, expect, it } from 'vitest';
import {
  FORM_COPY_KEYS,
  FORM_COPY_TO_FORMALOO,
  normalizeFormCopy,
  type FormCopy,
} from './form-copy';

describe('FORM_COPY_KEYS / FORM_COPY_TO_FORMALOO (canonical 契約)', () => {
  it('canonical key は 3 種 (buttonText/successMessage/errorMessage) で順序安定', () => {
    expect(FORM_COPY_KEYS).toEqual(['buttonText', 'successMessage', 'errorMessage']);
  });

  it('各 canonical key は Formaloo form 直フィールド名へ 1:1 写像する', () => {
    expect(FORM_COPY_TO_FORMALOO).toEqual({
      buttonText: 'button_text',
      successMessage: 'success_message',
      errorMessage: 'error_message',
    });
  });
});

describe('normalizeFormCopy — whitelist / string / trim / 空欄 drop', () => {
  it('3 文言の非空 string を trim して返す', () => {
    const out = normalizeFormCopy({ buttonText: '  送信 ', successMessage: 'ありがとう', errorMessage: '送信失敗' });
    expect(out).toEqual({ buttonText: '送信', successMessage: 'ありがとう', errorMessage: '送信失敗' });
  });

  it('未知キーは drop する (whitelist)', () => {
    const out = normalizeFormCopy({ buttonText: '送信', evil: 'x', language: 'ja', __proto__: 'y' } as Record<string, unknown>);
    expect(out).toEqual({ buttonText: '送信' });
    expect('evil' in out).toBe(false);
    expect('language' in out).toBe(false);
  });

  it('非 string 値は drop する', () => {
    const out = normalizeFormCopy({ buttonText: 123, successMessage: null, errorMessage: { x: 1 } } as unknown);
    expect(out).toEqual({});
  });

  it('空文字 / 空白のみは drop する (set/absent MVP: 空欄=未指定=触らない)', () => {
    const out = normalizeFormCopy({ buttonText: '', successMessage: '   ', errorMessage: '\t\n' });
    expect(out).toEqual({});
    expect('buttonText' in out).toBe(false);
  });

  it('key 不在は結果でも absent (誤クリア防止: 未指定キーは生成しない)', () => {
    const out = normalizeFormCopy({ buttonText: '送信' });
    expect(out).toEqual({ buttonText: '送信' });
    expect('successMessage' in out).toBe(false);
    expect('errorMessage' in out).toBe(false);
  });

  it('set と空欄 (=absent) が混在しても set だけ残す', () => {
    const out = normalizeFormCopy({ buttonText: '送信', successMessage: '', errorMessage: '   ' });
    expect(out).toEqual({ buttonText: '送信' });
  });

  it('非 object 入力 (null / array / string / number) は {} を返す', () => {
    expect(normalizeFormCopy(null)).toEqual({});
    expect(normalizeFormCopy(undefined)).toEqual({});
    expect(normalizeFormCopy([])).toEqual({});
    expect(normalizeFormCopy('送信')).toEqual({});
    expect(normalizeFormCopy(42)).toEqual({});
  });

  it('key の入力順に依存せず同じ結果を返す (順序無依存)', () => {
    const a = normalizeFormCopy({ errorMessage: 'e', buttonText: 'b', successMessage: 's' });
    const b = normalizeFormCopy({ buttonText: 'b', successMessage: 's', errorMessage: 'e' });
    expect(a).toEqual(b);
    expect(a).toEqual({ buttonText: 'b', successMessage: 's', errorMessage: 'e' });
  });

  it('返り値は FormCopy 型に代入可能 (型契約)', () => {
    const out: FormCopy = normalizeFormCopy({ buttonText: '送信' });
    expect(out.buttonText).toBe('送信');
  });
});
