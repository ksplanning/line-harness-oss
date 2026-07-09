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
  const ADDR = 'https://forms.formaloo.net/my-form-abc';

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
