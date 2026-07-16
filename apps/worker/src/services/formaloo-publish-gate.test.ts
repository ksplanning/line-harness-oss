/**
 * T-B3 (F-2) — publish gate 状態機械 (N-7 誤配信防止)。
 *   - draft/in_review では公開/埋め込み URL を発行しない (draft 中は誤送信不能)。
 *   - published でのみ公開 URL/埋め込みコードが有効。
 *   - draft→published の直行は禁止 (owner レビューを挟む = gate)。
 */
import { describe, test, expect } from 'vitest';
import {
  BUILDER_STATUSES,
  isBuilderStatus,
  canTransition,
  isPublicUrlEnabled,
  buildPublicUrl,
  buildEmbedCode,
  buildScriptEmbedCode,
} from './formaloo-publish-gate';

describe('publish gate — 状態定義', () => {
  test('3 状態 (draft/in_review/published)', () => {
    expect([...BUILDER_STATUSES]).toEqual(['draft', 'in_review', 'published']);
  });
  test('isBuilderStatus は 3 状態のみ true', () => {
    expect(isBuilderStatus('draft')).toBe(true);
    expect(isBuilderStatus('published')).toBe(true);
    expect(isBuilderStatus('nope')).toBe(false);
  });
});

describe('publish gate — 状態遷移 (draft→review→publish)', () => {
  test('draft→in_review は許可', () => {
    expect(canTransition('draft', 'in_review')).toBe(true);
  });
  test('in_review→published は許可 (owner 承認)', () => {
    expect(canTransition('in_review', 'published')).toBe(true);
  });
  test('in_review→draft は許可 (差し戻し)', () => {
    expect(canTransition('in_review', 'draft')).toBe(true);
  });
  test('published→draft は許可 (編集/unpublish → URL 無効化)', () => {
    expect(canTransition('published', 'draft')).toBe(true);
  });
  test('draft→published の直行は禁止 (レビューを飛ばせない = N-7 gate)', () => {
    expect(canTransition('draft', 'published')).toBe(false);
  });
  test('同一状態への遷移は no-op = false', () => {
    expect(canTransition('draft', 'draft')).toBe(false);
    expect(canTransition('published', 'published')).toBe(false);
  });
});

describe('publish gate — 公開 URL / 埋め込み (N-7)', () => {
  // full_form_address は account 固有サブドメインの絶対 https URL が唯一の正本 (実 API 系 formaloo.me)。
  const ADDR = 'https://demo-forms.formaloo.me/f/my-form-abc';

  test('published のみ公開 URL 有効', () => {
    expect(isPublicUrlEnabled('published')).toBe(true);
    expect(isPublicUrlEnabled('draft')).toBe(false);
    expect(isPublicUrlEnabled('in_review')).toBe(false);
  });

  test('draft/in_review では buildPublicUrl が null (URL 発行不可 = 誤配信防止)', () => {
    expect(buildPublicUrl('draft', ADDR)).toBeNull();
    expect(buildPublicUrl('in_review', ADDR)).toBeNull();
  });

  test('published では公開 URL を返す', () => {
    expect(buildPublicUrl('published', ADDR)).toBe(ADDR);
  });

  test('published でも address 未確定 (未 push) なら null', () => {
    expect(buildPublicUrl('published', null)).toBeNull();
    expect(buildPublicUrl('published', '')).toBeNull();
  });

  test('published でも絶対 https URL でない address は null (bare/相対を redirect に流さない)', () => {
    // full_form_address は絶対 https URL が唯一の正本。scheme 無し bare host / 相対パス / http / 非 http(s) は
    // 解決させない (ドメイン推測補完 o.formaloo.co が soft-200 エラーページに着地した実測事故 2026-07-17 の恒久ガード)。
    expect(buildPublicUrl('published', 'demo-forms.formaloo.me/f/abc')).toBeNull(); // scheme 無し bare host
    expect(buildPublicUrl('published', '/f/abc')).toBeNull(); // 相対パス
    expect(buildPublicUrl('published', 'http://demo-forms.formaloo.me/f/abc')).toBeNull(); // http は不可
    expect(buildPublicUrl('published', 'ftp://x/abc')).toBeNull(); // 非 http(s)
    expect(buildPublicUrl('published', 'not a url')).toBeNull(); // 解析不能
  });

  test('絶対 https でない address は埋め込みコードも null (buildPublicUrl 経由の一元ガード)', () => {
    expect(buildEmbedCode('published', 'demo-forms.formaloo.me/f/abc')).toBeNull();
    expect(buildScriptEmbedCode('published', 'demo-forms.formaloo.me/f/abc')).toBeNull();
  });

  test('draft では埋め込みコードも null (R4 は publish 後のみ)', () => {
    expect(buildEmbedCode('draft', ADDR)).toBeNull();
    expect(buildEmbedCode('in_review', ADDR)).toBeNull();
  });

  test('published の埋め込みコードは iframe に公開 URL を含む', () => {
    const code = buildEmbedCode('published', ADDR);
    expect(code).not.toBeNull();
    expect(code).toContain('<iframe');
    expect(code).toContain(ADDR);
  });

  test('script 埋め込み: draft は null / published は script に公開 URL を含む (T-E1)', () => {
    expect(buildScriptEmbedCode('draft', ADDR)).toBeNull();
    expect(buildScriptEmbedCode('in_review', ADDR)).toBeNull();
    const code = buildScriptEmbedCode('published', ADDR)!;
    expect(code).toContain('<script>');
    expect(code).toContain(ADDR);
    expect(code).toContain('createElement("iframe")');
  });

  test('script 埋め込み: </script> 混入 URL を JS 文字列として安全にエスケープ (XSS 防止)', () => {
    const evil = 'https://x.test/</script><img src=x onerror=alert(1)>';
    const code = buildScriptEmbedCode('published', evil)!;
    // 生の </script> は出力に現れない (\\u003c エスケープ済)
    expect(code).not.toContain('</script><img');
    expect(code).toContain('\\u003c/script');
  });
});
