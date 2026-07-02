/**
 * link 純ロジックテスト (D-12 の土台 + tel 正規化)。
 */
import { describe, test, expect } from 'vitest';
import { telUri, urlLink, trackedLink, telLink, bookingLink } from './link';

describe('telUri (電話番号正規化)', () => {
  test('ハイフン入りを tel: + 数字に正規化', () => {
    expect(telUri('090-1234-5678')).toBe('tel:09012345678');
  });
  test('全角スペースやカッコを除去', () => {
    expect(telUri('(03) 1234 5678')).toBe('tel:0312345678');
  });
  test('+ (国際) は保持', () => {
    expect(telUri('+81-90-1234-5678')).toBe('tel:+819012345678');
  });
});

describe('LinkSpec 生成', () => {
  test('urlLink は trim して url 種別を返す', () => {
    expect(urlLink('  https://ex.com/a  ')).toEqual({ type: 'url', uri: 'https://ex.com/a' });
  });

  test('D-12: trackedLink は uri=trackingUrl / trackedLinkId=id を持つ', () => {
    const choice = { id: 'lk_123', trackingUrl: 'https://base.example/t/lk_123' };
    expect(trackedLink(choice)).toEqual({
      type: 'tracked',
      trackedLinkId: 'lk_123',
      uri: 'https://base.example/t/lk_123',
    });
  });

  test('telLink は phone を保持し uri を正規化', () => {
    expect(telLink('090-1111-2222')).toEqual({
      type: 'tel',
      phone: '090-1111-2222',
      uri: 'tel:09011112222',
    });
  });

  test('bookingLink は booking 種別で trim', () => {
    expect(bookingLink(' https://ex.com/book ')).toEqual({ type: 'booking', uri: 'https://ex.com/book' });
  });
});
